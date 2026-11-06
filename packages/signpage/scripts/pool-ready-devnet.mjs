// One real devnet run of the signing page's state.pools `ready` across epoch boundaries (card pool-ready-no-flicker):
// one pool.deposit of 0.02 SOL through the page's own pool kinds (src/pool-kinds.ts over src/pool-testnet.ts
// testnetPool, as main.ts wires it), the proof queue's pass, then the state read main.ts makes, every READ_EVERY_MS
// (default 3 s) for EPOCHS (default 3) whole epochs after the first ready proof: a state read starts the queue's pass
// without waiting for it (main.ts `void testnet?.stateRead()`), so each boundary's remake and its swap run while the
// reads go on; each read takes the ready list and the notes through testnetPool's readyWith, as main.ts does, and
// withPools counts them. The note is never spent, so it stays ready: every read after the first ready one must give
// the same ready. The run also records, at each read, what the earlier read (the ready list copied before the notes
// are read) would have given, for comparison only.
//   node packages/signpage/scripts/pool-ready-devnet.mjs <out.json>
// - A seed made in this run only (16 random bytes), never printed; written before U is asked for to
//   ~/.ct-devnet-runs/run-<time>.seed (the folder 0700, the file 0600, its path logged, never its bytes), as
//   pool-pins-devnet.mjs keeps it. The wallet store and the notes are fake-indexeddb, in memory; the prover is
//   snarkjs's fullProve in this process on the pinned setup files.
// - It prints U and the lamports U needs, then waits for U to hold exactly that, or that plus at least an empty
//   account's rent. Someone else funds U.
// - Exit 0 only when a ready read came and every read after it, over EPOCHS boundaries with a remake each, gave it.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";

globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore, WALLET_SEED_LOCK } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, readNotes } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { readSolanaRent, solanaRentMin } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { SOL_EPOCH_MS } = await import("../../wallet/src/pool/solana.ts");
const { PAGE_POOLS, rentOnce, withPools, withSolanaRent } = await import("../src/pools.ts");
const { poolPrices } = await import("../src/pool-price.ts");
const { stateOf } = await import("../src/state.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-ready-devnet.mjs <out.json>");
const RUNG = 20_000_000n; // 0.02 SOL
const FEE = 5_000n;
const STATE_WAIT_MS = Number(process.env.STATE_WAIT_MS ?? 600_000);
const READ_EVERY_MS = Number(process.env.READ_EVERY_MS ?? 3_000);
const EPOCHS = Number(process.env.EPOCHS ?? 3);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
const rpcs = [testnetRpc(TESTNET_RPCS.solana[0]), testnetRpc(TESTNET_RPCS.solana[1])];

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

const w = await openWalletStore({ indexedDB: new IDBFactory() });
const entropy = randomBytes(16);
const dir = join(homedir(), ".ct-devnet-runs");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const at = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.seed`);
writeFileSync(at, entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
log(`the run's seed is kept at ${at}`);
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const page = { store: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} } });
const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });
const stages = [];
const noteList = async () => (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, sends: (n.sends ?? []).map((s) => s.signature) }));

const { scope, pool } = solanaPoolOf(SOL_POOLS.devnet.program);
const ns = await openNoteStore(w);
const planned = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
const id = depositId(seed64, scope, planned.ref.i);
const U = base58.encode(id.publicKey);
id.secretKey.fill(0);
const rent = await readSolanaRent(rpcs);
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const EMPTY = solanaRentMin(rent, 0);
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
log(`pool ${pool}; fund U ${U} with exactly ${NEED} lamports (or at least ${NEED + EMPTY}) on devnet`);
for (let b = await balance(); !(b === NEED || b >= NEED + EMPTY); b = await balance()) {
  if (b > 0n) log(`U holds ${b}: waiting for exactly ${NEED} or at least ${NEED + EMPTY}`);
  await sleep(10_000);
}
log("U funded; pool.deposit of 0.02 SOL");
const r = kinds["pool.deposit"]({ chain: "solana", amount: "0.02" }, { id: "pool.deposit", sha: "00", progress: (s) => (stages.push(s), log(`pool.deposit progress ${JSON.stringify(s)}`)) });
let answer = r;
if (!("error" in r)) {
  await r.after;
  answer = r.answer();
  log(`pool.deposit answered ${JSON.stringify(answer)}; waiting for its run to end`);
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
}
const deposit = { answer, notes: await noteList() };
log(`deposit ${JSON.stringify(deposit)}`);

// the page's state reads, as main.ts makes them: the pass started and not waited for, then the ready list and the
// notes in one turn of the queue (readyWith)
const prices = poolPrices({ rpcs: (chain) => (chain === "solana" ? rpcs : null) });
const rentRead = rentOnce(() => readSolanaRent(rpcs), () => log("the Rent sysvar read landed"));
const signedIn = stateOf(true, { source: "code", code_saved: true }, []);
const solOf = (out) => out.pools?.find((p) => p.chain === "solana") ?? null;
const stateRead = async () => {
  void t.stateRead();
  const rr = rentRead.get();
  const table = rr === null ? PAGE_POOLS : withSolanaRent(PAGE_POOLS, rr);
  // for comparison only: the earlier read, the ready list copied before the notes are read
  const early = (await t.readyWith(async () => null)).ready;
  const earlyOut = await withPools(signedIn, () => readNotes(w), table, early, prices.get);
  const both = await t.readyWith(() => readNotes(w));
  const out = await withPools(signedIn, async () => both.value, table, both.ready, prices.get);
  prices.refresh((out.pools ?? []).map((p) => p.chain));
  const attempts = (both.ready ?? []).map((p) => `${p.attempt.slice(0, 8)}@${p.epochStartMs}`);
  return { sol: solOf(out), early: solOf(earlyOut)?.ready ?? null, attempts, held: both.value.filter((n) => n.state === "HELD").length };
};
const states = [];
let first = null;
let bad = [];
const epochOf = (ms) => BigInt(ms) - (BigInt(ms) % SOL_EPOCH_MS);
if (deposit.notes.some((n) => n.ref === "deposit" && n.state === "UNSPENT")) {
  log("the proof queue's pass");
  log(`pass ${JSON.stringify(await t.proofs(), big)}`);
  const end = Date.now() + STATE_WAIT_MS;
  let until = null;
  for (;;) {
    const s = await stateRead();
    const row = { at: new Date().toISOString(), ready: s.sol?.ready ?? null, early: s.early, tap_max: s.sol?.tap_max ?? null, price: s.sol?.price ? true : false, attempts: s.attempts, held: s.held };
    states.push(row);
    log(`state ${JSON.stringify(row)}`);
    const pos = (x) => typeof x === "string" && /[1-9]/.test(x);
    if (first === null && pos(row.ready)) {
      first = row.ready;
      // EPOCHS whole epochs after the one the first ready read is in, and a few reads into the next
      until = Number(epochOf(Date.now()) + BigInt(EPOCHS + 1) * SOL_EPOCH_MS) + 5_000;
      log(`first ready ${first}: reading until ${new Date(until).toISOString()}`);
    } else if (first !== null && row.ready !== first) bad.push(row);
    if (until !== null && Date.now() > until) break;
    if (first === null && Date.now() > end) break;
    await sleep(READ_EVERY_MS);
  }
}
const after = first === null ? [] : states.slice(states.findIndex((x) => x.ready === first));
const epochs = new Set(after.map((x) => String(epochOf(Date.parse(x.at))))).size;
const remakes = new Set(after.flatMap((x) => x.attempts)).size - 1;
const ok = first !== null && bad.length === 0 && epochs >= EPOCHS + 1 && remakes >= EPOCHS;
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, rpcs: TESTNET_RPCS.solana, U, need: String(NEED), deposit, stages, readEveryMs: READ_EVERY_MS, first, reads: after.length, epochs, remakes, earlyZero: after.filter((x) => x.early === "0").length, bad, states }, big, 2) + "\n");
log(ok ? `PASS: ready ${first} on all ${after.length} reads over ${epochs} epochs, ${remakes} remakes; the earlier read gave 0 on ${after.filter((x) => x.early === "0").length}` : `FAIL: first ${first}, ${bad.length} read(s) off it, ${epochs} epochs, ${remakes} remakes`);
await t.signedOut();
ns.close();
w.close();
process.exit(ok ? 0 : 1);
