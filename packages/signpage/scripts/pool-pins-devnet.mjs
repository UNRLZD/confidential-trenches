// One real devnet run of the signing page's state.pools on its testnet build (card signpage-pool-pins): one pool.deposit
// of a rung whose tap spend is above zero (0.02 SOL: a 0.01 SOL note spends 0 at the worst venue, card
// sol-small-note-buys) through the page's own pool kinds (src/pool-kinds.ts over src/pool-testnet.ts testnetPool, as
// main.ts wires the testnet build), the proof queue's pass, then the state read main.ts makes: withPools over
// PAGE_POOLS (the devnet pool from its pin), the queue's ready proofs (testnetPool's ready()), the page's own price
// (src/pool-price.ts poolPrices) and the Solana tap spend from the Rent sysvar (src/pools.ts rentOnce, withSolanaRent),
// all on main's devnet RPC pair (TESTNET_RPCS.solana, through the page's src/page-rpc.ts). main.ts's own glue around
// these is test/main-testnet-pools.test.ts.
//   node packages/signpage/scripts/pool-pins-devnet.mjs <out.json>
// - A seed made in this run only (16 random bytes), never printed; written before U is asked for to
//   ~/.ct-devnet-runs/run-<time>.seed (the folder 0700, the file 0600, its path logged, never its bytes), as
//   pool-flow-devnet.mjs keeps it, so a run that stops past its deposit can be spent from that seed. The wallet store and
//   the notes are fake-indexeddb, in memory; the prover is snarkjs's fullProve in this process on the pinned setup files.
// - It prints U and the lamports U needs (the rung, the mark's rent, two page entries and the fee, from the Rent sysvar
//   both RPCs give), then waits for U to hold exactly that, or that plus at least an empty account's rent. Someone else
//   funds U.
// - After the pass it reads the state every 15 s for up to STATE_WAIT_MS (default 10 min), as the page does on its
//   watchers, until the devnet pool's entry has ready above 0, a price and tap_max above 0; it writes every state read.
//   Exit 0 only when one did.
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
const { pageRpc } = await import("../src/page-rpc.ts");
const { readSolanaRent, solanaRentMin } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { PAGE_POOLS, rentOnce, withPools, withSolanaRent } = await import("../src/pools.ts");
const { poolPrices } = await import("../src/pool-price.ts");
const { stateOf } = await import("../src/state.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-pins-devnet.mjs <out.json>");
const RUNG = 20_000_000n; // 0.02 SOL
const FEE = 5_000n;
const STATE_WAIT_MS = Number(process.env.STATE_WAIT_MS ?? 600_000);
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
const rpcs = [pageRpc(TESTNET_RPCS.solana[0]), pageRpc(TESTNET_RPCS.solana[1])];

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

// the page's state reads, as main.ts makes them (each read starts the price read it is due; the Rent read once)
const prices = poolPrices({ rpcs: (chain) => (chain === "solana" ? rpcs : null) });
const rentRead = rentOnce(() => readSolanaRent(rpcs), () => log("the Rent sysvar read landed"));
const signedIn = stateOf(true, { source: "code", code_saved: true }, []);
const stateRead = async () => {
  await t.stateRead();
  const rr = rentRead.get();
  const out = await withPools(signedIn, () => readNotes(w), rr === null ? PAGE_POOLS : withSolanaRent(PAGE_POOLS, rr), await t.ready(), prices.get);
  prices.refresh((out.pools ?? []).map((p) => p.chain));
  return out.pools ?? null;
};
const states = [];
let good = null;
if (deposit.notes.some((n) => n.ref === "deposit" && n.state === "UNSPENT")) {
  log("the proof queue's pass");
  log(`pass ${JSON.stringify(await t.proofs(), big)}`);
  const end = Date.now() + STATE_WAIT_MS;
  for (;;) {
    const pools = await stateRead();
    states.push({ at: new Date().toISOString(), pools });
    log(`state.pools ${JSON.stringify(pools)}`);
    const sol = pools?.find((p) => p.chain === "solana");
    const pos = (s) => typeof s === "string" && /[1-9]/.test(s);
    if (sol && pos(sol.ready) && sol.price && pos(sol.tap_max)) {
      good = sol;
      break;
    }
    if (Date.now() > end) break;
    await sleep(15_000);
  }
}
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, rpcs: TESTNET_RPCS.solana, U, need: String(NEED), deposit, stages, states, pools: good }, big, 2) + "\n");
log(good ? `PASS: ${JSON.stringify(good)}` : "FAIL: no state with ready, a price and tap_max above 0");
await t.signedOut();
ns.close();
w.close();
process.exit(good ? 0 : 1);
