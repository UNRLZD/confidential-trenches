// The Solana pool's own coin sent straight to U_X on a local copy of mainnet (card deposit-takes-each-pools-own-coin),
// through the signing page's own pool.address and follow, as src/main.ts wires them. FLOW_COPY only (./copy-net.mjs,
// run by sol-mainnet-copy.mjs SOL_COPY_FLOW=plain):
//   FLOW_COPY=<run file> PLAIN_PRICE=<PoolStatePrice json> node packages/signpage/scripts/pool-plain-send-copy.mjs <out.json>
// - A seed made in this run only (16 random bytes), kept in the copy's own temp folder (COPY.dir) for the withdraw run
//   after it (pool-withdraw-devnet.mjs FLOW_RESUME), never printed. The deposit namer names U_X (src/deposit-name.ts).
// - pool.address (src/pool-deposit-address.ts poolAddressHost): origin_asset POOL_DEPOSIT_DESTINATION.solana, the floor
//   readSolanaPoolFloor on the page's pair, priced by poolQuotePricing(price, origin, "solana") at PLAIN_PRICE (SOL/USD
//   read by the parent on public mainnet RPCs: the copy holds no fresh Pyth write; it bounds the beta cap only), checked
//   by poolFollows' quoted into the store's op. Asked at the floor less 1 lamport (must answer below_min, no op) and at
//   the floor (must answer U_X as its address and its quote's deposit address); neither may ask 1Click or the helper's
//   1Click proxy (every helper path the copy serves is logged by copy-net.mjs; any other host is refused).
// - The outside wallet: a fresh key in the copy's temp folder, funded by the copy's airdrop, sends U_X floor - 1
//   lamport, then the 1 lamport that tops it up (SystemProgram transfers on the copy).
// - The follow (src/pool-deposit-follow.ts followPoolQuote over solanaPoolFollowDeps on the page's pair, the deposit the
//   page's pool.deposit from U_X, as main.ts wires them) runs on the op's own record with a status read that throws if
//   called (counted: must be 0). Under the floor it must show short and carry nothing; topped up, in_transit and the
//   carry, then in_pool with the deposit's note UNSPENT. The follow reads on to the quote's real deadline (30 min), so
//   the run ends it by its signal once the note is in.
// Writes <out.json>: the answers, the op, the stages, the sends (the parent reads every tx back), U_X's balance, the
// seed file's path. Exit 0 only when every check held. Nothing here logs a key or the words.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { COPY, copyAirdrop, copyNet } from "./copy-net.mjs";

globalThis.__SIGN_NETWORK__ = "mainnet";
const [OUT] = process.argv.slice(2);
if (!OUT || !COPY) throw new Error("usage: FLOW_COPY=<run file> PLAIN_PRICE=<json> pool-plain-send-copy.mjs <out.json>");
const PRICE = JSON.parse(process.env.PLAIN_PRICE ?? "null");
if (!PRICE || typeof PRICE.price !== "string" || !Number.isInteger(PRICE.expo)) throw new Error("PLAIN_PRICE: a PoolStatePrice");
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
let phase = "start";
const copy = await copyNet({ log, phase: () => phase });
const rpcs = copy.rpcs;
const PIN = copy.pin;

const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore, readNotes } = await import("../../wallet/src/notes/store.ts");
const { solanaPoolOf, SOL_LADDER } = await import("../../wallet/src/pool/solana.ts");
const { POOL_DEPOSIT_DESTINATION } = await import("../../wallet/src/deposit/quote.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { solanaCompileV0 } = await import("../../kit/src/trade/solana/build.ts");
const { solanaDecodeMessage } = await import("../../kit/src/checks/solana/message.ts");
const { testnetPool } = await import("../src/pool-testnet.ts");
const { depositNamer } = await import("../src/deposit-name.ts");
const { frameState } = await import("../src/state.ts");
const { poolAddressHost, poolQuotePricing, readSolanaPoolFloor } = await import("../src/pool-deposit-address.ts");
const { depositToEnd, followPoolQuote, poolFollows, solanaPoolFollowDeps, uxNoteLanded, uxNoteOpen } = await import("../src/pool-deposit-follow.ts");

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
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    return { proof, publicSignals };
  },
};

// the seed, kept in the copy's temp folder for the withdraw run (removed with it)
const w = await openWalletStore({ indexedDB: new IDBFactory() });
const entropy = randomBytes(16);
mkdirSync(COPY.dir, { recursive: true, mode: 0o700 });
chmodSync(COPY.dir, 0o700);
const seedFile = join(COPY.dir, "plain.seed");
writeFileSync(seedFile, entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const helperCalls = [];
const helperFetch = async (url, init) => {
  helperCalls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
  const r = await fetch(url, init);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
  return r;
};
const page = { store: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, fetch: helperFetch, pin: copy.pin, holdings: copy.holdings });
const { scope } = solanaPoolOf(PIN.program);
await openNoteStore(w);

const record = { at: new Date().toISOString(), cluster: "mainnet copy", program: PIN.program, seedFile, price: PRICE, checks: {} };
const failures = [];
const check = (name, ok, o) => {
  record.checks[name] = { ok, ...o };
  log(`${name}: ${ok ? "ok" : "FAIL"} ${JSON.stringify(o, big).slice(0, 1500)}`);
  if (!ok) failures.push(name);
};
const done = (code) => {
  record.failures = failures;
  record.helperCalls = helperCalls;
  record.steps = copy.sent.map((s) => ({ step: s.phase, signature: s.signature }));
  record.simFails = copy.simFails;
  record.sendLines = copy.sendLines;
  writeFileSync(OUT, JSON.stringify(record, big, 2) + "\n");
  seed64.fill(0);
  process.exit(code);
};

// U_X named, as the top-level page names it
const namer = depositNamer({ top: true, scope: () => null, pools: () => [{ chain: "solana", scope }], open: async () => w, startup: async () => {}, resyncing: () => null });
namer.name(Uint8Array.from(entropy));
entropy.fill(0);
await namer.named();
const fs = frameState(async () => w, () => {});
const pub = await fs.depositRead(scope);
const UX = pub?.deposit?.evm === undefined && pub?.deposit?.id ? base58.encode(Buffer.from(pub.deposit.id, "hex")) : null;
record.ux = UX;
if (UX === null) {
  check("U_X named", false, { deposit: pub?.deposit ?? null });
  done(1);
}

// pool.address, the plain send: below the floor, then at it
// pool.address reads a plain send's base on U_X before its address goes out (review P2-c), so its first deps call gets
// the pair's reads; the follow that call starts gets none, since the follow below is this run's own followPoolQuote
let baseReads = 1;
const noDeposit = async () => Promise.reject(new Error("pool.address deposits nothing"));
const follow = poolFollows({ store: async () => w, decimals: () => 9, deps: () => (baseReads-- > 0 ? solanaPoolFollowDeps({ rpcs, program: PIN.program, deposit: noDeposit }) : null), locks: () => null });
const host = poolAddressHost({ pools: () => [{ chain: "solana", scope }], network: "mainnet", read: fs.depositRead, named: () => namer.named(), priced: (c, o) => poolQuotePricing(PRICE, o, c), floor: (_c, wallet, signal) => readSolanaPoolFloor(rpcs, PIN.program, wallet, signal), checked: (id, c, q, u) => follow.quoted(id, c, q, u) });
const origin = POOL_DEPOSIT_DESTINATION.solana;
const sol = (l) => { const s = l.toString().padStart(10, "0"); return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, ""); };
const floor = await readSolanaPoolFloor(rpcs, PIN.program, UX);
const ask = async (amount, id) => {
  const r = host({ chain: "solana", origin_asset: origin, amount }, { id });
  await r.after;
  return r.answer();
};
const calls0 = helperCalls.length;
const under = await ask(sol(floor - 1n), "plain-under");
const at = await ask(sol(floor), "plain-send");
await follow.idle();
const op = await w.get("ops", "plain-send");
const underOp = (await w.get("ops", "plain-under")) ?? null;
const q = at?.result?.quote;
const f = op?.follow;
const asked = helperCalls.slice(calls0);
check("plain: pool.address", under?.error === "below_min" && underOp === null && at?.result?.address === UX && q?.deposit_address === UX && q?.origin_asset === origin && q?.amount_in === sol(floor) && Date.parse(q?.deadline) - Date.now() > 29 * 60_000 && asked.length === 0 && op?.kind === "pool_deposit" && f?.address === UX && f?.u === UX && f?.min_out === floor.toString(), { origin, floor, under, at, asked, op });
if (failures.length) done(1);

// the outside wallet: a fresh key, funded on the copy
const outKey = Uint8Array.from(randomBytes(32));
const OUTSIDE = base58.encode(ed25519.getPublicKey(outKey));
record.outside = OUTSIDE;
log(`the outside wallet ${OUTSIDE} funded by the copy's airdrop: ${await copyAirdrop(rpcs[0], OUTSIDE, 1_000_000_000n)}`);
const finalized = async (sig) => {
  for (let i = 0; i < 120; i++) {
    const st = await Promise.all(rpcs.map(async (r) => (await r("getSignatureStatuses", [[sig]])).value[0]));
    if (st.some((x) => x?.err)) throw new Error(`${sig} failed: ${JSON.stringify(st.map((x) => x?.err ?? null))}`);
    if (st.every((x) => x?.confirmationStatus === "finalized")) return;
    await sleep(500);
  }
  throw new Error(`${sig} not finalized on both names`);
};
const uxBalance = async () => BigInt((await rpcs[0]("getBalance", [UX, { commitment: "finalized" }])).value);
const plainSends = [];
record.plainSends = plainSends;
// a SystemProgram transfer of `lamports` from the outside wallet to U_X, sent on the copy and read finalized
const outsideSend = async (what, lamports) => {
  phase = what;
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  const ix = { program: "11111111111111111111111111111111", accounts: [{ key: OUTSIDE, signer: true, writable: true }, { key: UX, signer: false, writable: true }], data };
  const { blockhash } = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const { message } = solanaCompileV0(OUTSIDE, [ix], blockhash, [], [OUTSIDE]);
  const m = solanaDecodeMessage(message);
  const wire = new Uint8Array(1 + 64 * m.requiredSignatures + message.length);
  wire[0] = m.requiredSignatures;
  wire.set(ed25519.sign(message, outKey), 1);
  wire.set(message, 1 + 64 * m.requiredSignatures);
  const sig = await rpcs[0]("sendTransaction", [base64.encode(wire), { encoding: "base64", preflightCommitment: "confirmed" }]);
  await finalized(sig);
  const s = { what, signature: sig, from: OUTSIDE, to: UX, lamports, uxBalance: await uxBalance() };
  plainSends.push(s);
  log(`plain send ${JSON.stringify(s, big)}`);
  return s;
};

// the follow on the op's own record, as main.ts wires it on Solana; 1Click's status never asked
let statusCalls = 0;
const stages = [];
const carried = [];
let rounds = 0;
const ctl = new AbortController();
const depositFromUx = (g, amount, signal) => depositToEnd((p, ctx) => t.depositFrom(p, { s: BigInt(g.s), i: g.i, u: g.u }, ctx), "solana", 9, amount, signal);
const deps = {
  ...solanaPoolFollowDeps({ rpcs, program: PIN.program, deposit: depositFromUx }),
  noted: async (g) => uxNoteLanded(await readNotes(w), g),
  open: async (g) => uxNoteOpen(await readNotes(w), g),
  status: async () => {
    statusCalls++;
    throw new Error("a plain send asks 1Click nothing");
  },
  stage: async (s) => void (stages.push(s), log(`follow stage ${s}`)),
  txs: async (x) => void carried.push(...x),
  signal: ctl.signal,
  // the page's pace (15 s) capped at 2 s, to read the rounds fast on the copy
  sleep: (ms, sg) => (rounds++, new Promise((r) => { const k = setTimeout(r, Math.min(ms, 2_000)); sg.addEventListener("abort", () => (clearTimeout(k), r()), { once: true }); })),
};
const under1 = await outsideSend("plain send, one lamport under the floor", floor - 1n);
phase = "follow";
const run = followPoolQuote(f, deps, "quote_checked");
for (let k = 0; k < 60 && (rounds < 4 || !stages.includes("short")); k++) await sleep(500);
check("plain: under the floor", stages.includes("short") && !stages.includes("in_transit") && carried.length === 0 && copy.sent.filter((s) => s.phase === "deposit").length === 0 && statusCalls === 0, { rounds, stages: [...stages], uxBalance: await uxBalance(), statusCalls });
phase = "deposit";
const top = await outsideSend("plain send, the top-up to the floor", floor - (await uxBalance()));
phase = "deposit";
// the note shows once its deposit is final, through the page's state reads (the app asks state for what it shows; the
// 09:32Z run, with no state read, saw the carry land and no UNSPENT note in 4 min)
let note = null;
const uxNotes = async () => (await readNotes(w)).filter((n) => n.ref.kind === "deposit" && n.ref.i === f.i && n.scope === scope);
for (let k = 0; k < 240 && note === null; k++) {
  await sleep(1_000);
  await t.stateRead().catch(() => {});
  note = (await uxNotes()).find((n) => n.state === "UNSPENT" && n.leaf !== undefined) ?? null;
}
record.uxNoteStates = (await uxNotes()).map((n) => n.state);
// the carry's txs: the follow reads them landed (both names) in the next rounds
for (let k = 0; k < 30 && (carried.length === 0 || !stages.includes("in_pool")); k++) await sleep(1_000);
ctl.abort();
const shown = await run;
const uxAfter = await uxBalance();
check("plain: the carry", note !== null && stages.includes("in_transit") && stages.includes("in_pool") && shown === "in_pool" && carried.length >= 1 && statusCalls === 0 && under1.lamports + top.lamports === floor, { stages: [...stages], shown, carried, note: note ? { ref: note.ref, state: note.state, value: note.leaf.value } : null, uxAfter, statusCalls, rounds, ladderMin: SOL_LADDER.min });
record.statusCalls = statusCalls;
record.stages = stages;
record.carried = carried;
record.uxAfter = uxAfter;
record.note = note ? { ref: note.ref, state: note.state, value: note.leaf.value } : null;
record.oneclickHelperCalls = helperCalls.filter((c) => /oneclick/.test(c)).length;
if (record.oneclickHelperCalls !== 0) failures.push("the helper's 1Click proxy was called");
outKey.fill(0);
await t.signedOut();
done(failures.length === 0 ? 0 : 1);
