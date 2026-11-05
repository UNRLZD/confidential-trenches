// One real devnet run of card signpage-buy-own-spend: two devices signed in with the same 12 words, each with its own
// wallet store and note store, each proving the same note with its own attempt (its own salt), through the signing
// page's own testnet pool kinds (src/pool-kinds.ts poolKinds over src/pool-testnet.ts testnetPool, as main.ts wires
// the testnet build). Device B buys first: filled. Device A then buys with its own ready proof of that note, to the
// same W: its buy answers not_landed (never filled), and A's note is SPENT with its change written from the spent mark.
//   node packages/signpage/scripts/pool-buy-own-spend-devnet.mjs <table> <mint> <spend SOL> <out.json>
// - A seed made in this run only (16 random bytes), never printed. It is written, before U is asked for, to
//   ~/.ct-devnet-runs/run-<time>.seed (the folder 0700, the file 0600, outside the repo; its path is logged, never its
//   bytes), so the note's change and W stay recoverable. The stores are fake-indexeddb, in memory, one per device.
// - Device A plans the deposit: U, the deposit's source, is the address its note store plans; this prints U and the
//   lamports it needs (the rung, the mark's rent, two page entries and the fee, from the Rent sysvar both RPCs give),
//   then waits for U to hold exactly that, or that plus at least an empty account's rent. Someone else funds U.
// - Device B restores its notes from the seed alone on both devnet RPCs (the wallet's solanaRestoreNotes), as a second
//   device signing in does. Each device's proof queue then makes its own ready proof of the note.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process (the
//   setup files checked by sha256 against ZK_SETUP_FILES); the RPCs are the page's own (src/page-rpc.ts). Every check,
//   the send, every read-back, the settle and whose spend it is are the page's own code.
// - Each kind is tapped once; the run waits for each run's end (the seed's exclusive Web Lock), then reads the notes.
// - It writes the answers, each device's stages, its notes and every tx to <out.json>; exit 0 only when B's buy is
//   filled, A's is not_landed with no filled stage, and A's note is SPENT with its change in A's store.
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";

// the testnet build's network, set before any module that reads it loads (as test/pool-testnet.test.ts does)
globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, refKey } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { solanaRestoreNotes } = await import("../../wallet/src/pool/solana-restore.ts");
const { pageRpc } = await import("../src/page-rpc.ts");
const { readSolanaRent, solanaRentMin } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TABLE, MINT, SPEND, OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-buy-own-spend-devnet.mjs <table> <mint> <spend SOL> <out.json>");
const RUNG = 10_000_000n;
const FEE = 5_000n;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a call that still fails after the page's retry: logged with its named fault (public reads only)
const logged = (rpc) => {
  const p = async (method, params) => {
    try {
      return await rpc(method, params);
    } catch (e) {
      log(`rpc ${new URL(rpc.url).host} ${method}: ${String(e?.message).slice(0, 160)}`);
      throw e;
    }
  };
  p.url = rpc.url; // the kit tells two providers apart by their URL
  return p;
};
const rpcs = [logged(pageRpc(TESTNET_RPCS.solana[0])), logged(pageRpc(TESTNET_RPCS.solana[1]))];

// the prover: snarkjs's fullProve in this process, on the release's pinned withdraw files
const KIT_ZK = new URL("../../kit/zk/", import.meta.url);
const file = (name) => {
  const b = readFileSync(new URL(name, KIT_ZK));
  if (createHash("sha256").update(b).digest("hex") !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: not the pinned setup file`);
  return new Uint8Array(b);
};
const WASM = file("withdraw.wasm");
const ZKEY = file("withdraw.zkey");
const snarkjs = createRequire(new URL("../../kit/package.json", import.meta.url))("snarkjs");
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    log(`proved in ${Math.round(performance.now() - t0)} ms`);
    return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
  },
};

const RESUME = process.env.FLOW_RESUME;
const entropy = RESUME ? Buffer.from(readFileSync(RESUME, "utf8").trim(), "hex") : randomBytes(16);
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
if (!RESUME) {
  const dir = join(homedir(), ".ct-devnet-runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const at = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.seed`);
  writeFileSync(at, entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  log(`the run's seed is kept at ${at} (FLOW_RESUME=${at} runs again from it, past the deposit)`);
}
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const { scope, pool } = solanaPoolOf(SOL_POOLS.devnet.program);

/** One device: its own wallet store and note store on the same 12 words, its own proof queue and pool kinds. */
async function device(name) {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
  const page = { store: async () => w, seed64: async () => seed64.slice() };
  const helperFetch = async (url, init) => {
    const r = await fetch(url, init);
    log(`${name} helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
    return r;
  };
  const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, table: TABLE, fetch: helperFetch });
  const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });
  const ns = await openNoteStore(w);
  const stages = [];
  const notes = async () => (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, parent: n.parent ?? null, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null, sends: (n.sends ?? []).map((s) => s.signature) }));
  // a kind answers at its send and its run goes on: each run holds the seed's shared lock, so this waits for the
  // exclusive one, then reads the notes, which hold the run's verdict
  const run = async (kind, params) => {
    const r = kinds[kind](params, { id: `${name}-${kind}`, sha: "00", progress: (s) => (stages.push({ kind, stage: s }), log(`${name} ${kind} progress ${JSON.stringify(s)}`)) });
    if ("error" in r) return { answer: r };
    await r.after;
    const answer = r.answer();
    log(`${name} ${kind} answered ${JSON.stringify(answer)}; waiting for its run to end`);
    await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
    return { answer, notes: await notes() };
  };
  const close = async () => {
    await t.signedOut();
    ns.close();
    w.close();
  };
  return { name, t, ns, run, stages, notes, close };
}

const A = await device("A");
const B = await device("B");
const rent = await readSolanaRent(rpcs);
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const EMPTY = solanaRentMin(rent, 0);
let deposit = null;
let U = null;
if (!RESUME) {
  const planned = await A.ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
  const id = depositId(seed64, scope, planned.ref.i);
  U = base58.encode(id.publicKey);
  id.secretKey.fill(0);
  const balance = async () => {
    for (;;) {
      try {
        const got = await Promise.all(rpcs.map(async (r) => BigInt((await r("getBalance", [U, { commitment: "confirmed" }])).value)));
        return got[0] < got[1] ? got[0] : got[1];
      } catch (e) {
        log(`balance read failed (${String(e?.message).slice(0, 80)}): reading again`);
        await sleep(5_000);
      }
    }
  };
  log(`pool ${pool}; table ${TABLE}; fund U ${U} with exactly ${NEED} lamports (or at least ${NEED + EMPTY}) on devnet`);
  for (let b = await balance(); !(b === NEED || b >= NEED + EMPTY); b = await balance()) {
    if (b > 0n) log(`U holds ${b}: waiting for exactly ${NEED} or at least ${NEED + EMPTY}`);
    await sleep(10_000);
  }
  log("U funded; device A's pool.deposit of 0.01 SOL");
  deposit = await A.run("pool.deposit", { chain: "solana", amount: "0.01" });
  log(`deposit ${JSON.stringify(deposit)}`);
} else {
  // a resumed run: device A's notes from the seed too, as B's below
  deposit = { resumed: RESUME };
}
entropy.fill(0);
// the notes from the seed alone, as a restore reads them: each into the device's store, a change note under its parent
const restore = async (d) => {
  // read again while the deposit is not yet on both RPCs (a provider a few slots behind finds no note)
  let r = null;
  for (let i = 0; i < 12 && !(r?.notes.length > 0); i++) {
    if (i > 0) await sleep(5_000);
    r = await solanaRestoreNotes({ seed64, program: SOL_POOLS.devnet.program, rpcs }).catch((e) => (log(`restore read failed (${String(e?.message).slice(0, 80)}): reading again`), null));
  }
  if (!r) throw new Error("no restore read");
  const ids = new Map();
  for (const n of r.notes) {
    const rec = await d.ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf, ...(n.parent === undefined ? {} : { parent: ids.get(n.parent) }) });
    ids.set(refKey(n.ref), rec.id);
  }
  log(`device ${d.name} restored from the seed: ${JSON.stringify(await d.notes())}`);
};
if (RESUME) await restore(A);
await restore(B);
// the note on each device: landed, UNSPENT or HELD by that device's own proof queue (a landing starts its pass)
const unspent = async (d) => (await d.notes()).filter((n) => (n.state === "UNSPENT" || n.state === "HELD") && n.leafIndex !== null);
const [na, nb] = [await unspent(A), await unspent(B)];
if (na.length !== 1 || nb.length !== 1 || na[0].leafIndex !== nb[0].leafIndex) throw new Error(`not one note on both devices: A ${JSON.stringify(na)}, B ${JSON.stringify(nb)}`);
log(`one note on both devices, leaf ${na[0].leafIndex}`);
// each device's own proof of that note, its own attempt and salt, before either buys
for (const d of [A, B]) {
  log(`device ${d.name}'s proof queue pass`);
  log(`${d.name} pass ${JSON.stringify(await d.t.proofs(), (k, v) => (typeof v === "bigint" ? String(v) : v))}`);
}
log(`device B's pool.buy of ${SPEND} SOL of ${MINT}`);
const buyB = await B.run("pool.buy", { chain: "solana", token: MINT, amount: SPEND, slippage_bps: 300 });
log(`B buy ${JSON.stringify(buyB)}`);
log(`device A's pool.buy of ${SPEND} SOL of ${MINT}, its own proof of the note B spent`);
const buyA = await A.run("pool.buy", { chain: "solana", token: MINT, amount: SPEND, slippage_bps: 300 });
log(`A buy ${JSON.stringify(buyA)}`);
const notesA = await A.notes();
const notesB = await B.notes();
const last = (d) => d.stages.filter((x) => x.kind === "pool.buy").at(-1)?.stage ?? null;
const end = (d, run) => last(d) ?? run?.answer?.result?.stage ?? null;
const spentA = notesA.find((n) => n.leafIndex === na[0].leafIndex);
const changeA = notesA.find((n) => n.parent === spentA?.id && n.ref === "change");
const ok = end(B, buyB) === "filled" && end(A, buyA) === "not_landed" && !A.stages.some((x) => x.kind === "pool.buy" && x.stage === "filled") && spentA?.state === "SPENT" && changeA !== undefined;
log(`B ${end(B, buyB)}, A ${end(A, buyA)}; A's note ${spentA?.state}, its change ${JSON.stringify(changeA ?? null)}: ${ok ? "PASS" : "FAIL"}`);
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, table: TABLE, mint: MINT, spend: SPEND, resumed: Boolean(RESUME), U, need: String(NEED), deposit, buyB, buyA, stagesA: A.stages, stagesB: B.stages, notesA, notesB, ok }, null, 2) + "\n");
await A.close();
await B.close();
process.exit(ok ? 0 : 1);
