// One real devnet run of the pool path through the signing page's own testnet flow (card signpage-pool-flow-run): the
// page's pool kinds (src/pool-kinds.ts poolKinds over src/pool-testnet.ts testnetPool, as main.ts wires them in the
// testnet build) on the devnet pool it pins: one pool.deposit of 0.01 SOL, the proof queue's pass, one pool.buy of a
// devnet pump.fun coin sent through the helper's POST /v1/pool/solana/send, then one pool.sell of all W holds of it,
// back into the pool as a return note.
//   node packages/signpage/scripts/pool-flow-devnet.mjs <table> <mint> <spend SOL | max> <out.json>
// - <spend> "max": the most the ready proof can spend on the coin's own venue (the kit's solanaPoolBuyMaxSpend on the
//   venue readSolanaPoolBuyVenue reads, the rung's chunk, the relay fee the helper gave the proof's pass, the devnet tip
//   of 0), so the buy leaves W exactly what its sell needs up front (the review of signpage-pool-sell 4b6223a), and
//   the sell then shows on chain that W at that need sells.
// - A seed made in this run only (16 random bytes), never printed or kept; the wallet store and its notes are
//   fake-indexeddb, in memory. U, the deposit's source, is the address the note store plans; this prints U and the
//   lamports it needs (the rung, the mark's rent, two page entries and the fee, from the Rent sysvar both RPCs give), then
//   waits for U to hold exactly that, or that plus at least an empty account's rent. Someone else funds U.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process, the one
//   the prover worker makes (the setup files checked by sha256 against ZK_SETUP_FILES); <table> is the lookup table
//   (DEVNET_TABLE once pinned); each devnet RPC call that fails in transport (an HTTP 429 or a JSON-RPC -32029, a 5xx,
//   a non-JSON page, a timeout) is logged and asked again, up to 10 times, a short wait apart; the helper's answers are logged by status;
//   and a kind that answers failed or quote_check_failed (nothing sent) is tapped again, up to 4 times. Every check,
//   the send and every read-back are the page's own code.
// - Each kind answers at its send and its run goes on; this waits for the run's end (the seed's lock), then reads the
//   notes: the deposit landed when its note is UNSPENT, the buy filled when that note is SPENT and no stage but sent or
//   filled was told, the sell filled when a return note is UNSPENT with a leaf and no stage but sent or filled was told.
//   The sell's amount is all W holds of the coin, as W's token account reads at finalized (W: the buy tx's second key).
// - It writes the answers, the stages, the notes and every tx to <out.json>; exit 0 only when both landed.
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";

// the testnet build's network, set before any module that reads it loads (as test/pool-testnet.test.ts does)
globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { solanaJsonRpc } = await import("../../kit/src/trade/solana/send.ts");
const { readSolanaRent, solanaRentMin, readSolanaPoolBuyVenue, solanaPoolBuyMaxSpend, solanaPoolBuySellNeed } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TABLE, MINT, SPEND, OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-flow-devnet.mjs <table> <mint> <spend SOL> <out.json>");
const RUNG = 10_000_000n;
const FEE = 5_000n;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const patient = (rpc) => {
  const p = async (method, params) => {
    for (let i = 0; ; i++) {
      try {
        return await rpc(method, params);
      } catch (e) {
        // every failed call is logged (its method and error: public reads only, never a key or the words)
        log(`rpc ${new URL(rpc.url).host} ${method}: ${String(e?.message).slice(0, 120)}`);
        // short waits, so a retried read never ages the quote past the rule's 25 slots
        if (i >= 9 || !/429|-32029|fetch failed|not a JSON-RPC answer|HTTP 5\d\d|timed out|aborted/i.test(String(e?.message))) throw e;
        await sleep(Math.min(500 * (i + 1), 3_000));
      }
    }
  };
  p.url = rpc.url; // the kit tells two providers apart by their URL
  return p;
};
const rpcs = [patient(solanaJsonRpc(TESTNET_RPCS.solana[0])), patient(solanaJsonRpc(TESTNET_RPCS.solana[1]))];

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
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const page = { store: async () => w, seed64: async () => seed64.slice() };
// the helper's fetch, logged: its status for every call
// the relay fee the helper gave the proof's pass (GET /v1/pool/fee), for a "max" spend
let relayFee = null;
const helperFetch = async (url, init) => {
  const r = await fetch(url, init);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
  if (new URL(url).pathname === "/v1/pool/fee" && r.status === 200) relayFee = BigInt(JSON.parse(await r.clone().text()).fee);
  return r;
};
const t = testnetPool(page, { rpcs, prover: { vault, stop: () => {} }, table: TABLE, fetch: helperFetch });
const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? rpcs : testnetPoolDeps().rpcs(c)) });
const ctx = (id) => ({ id, sha: "00", progress: (s) => log(`${id} progress ${JSON.stringify(s)}`) });
// a kind answers at its send and its run goes on (the app learns the end from its state reads): each run holds the seed's
// shared lock, so this waits for the exclusive one, then reads the notes, which hold the run's verdict
const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
const stages = [];
const once = async (kind, params) => {
  const r = kinds[kind](params, { ...ctx(kind), progress: (s) => (stages.push({ kind, stage: s }), log(`${kind} progress ${JSON.stringify(s)}`)) });
  if ("error" in r) return { answer: r };
  await r.after;
  const answer = r.answer();
  log(`${kind} answered ${JSON.stringify(answer)}; waiting for its run to end`);
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
  return { answer, notes: await noteList() };
};
// a kind that answers failed or quote_check_failed sent nothing (each sends only after every check, and answers a stage
// from the send on): tapped again, as a user would, after the proof queue's pass, up to 4 times
const run = async (kind, params) => {
  for (let k = 1; ; k++) {
    const r = await once(kind, params);
    const err = r.answer?.error;
    if ((err !== "failed" && err !== "quote_check_failed") || k >= 4) return r;
    log(`${kind} answered ${err} (try ${k}): again in 10 s`);
    await sleep(10_000);
    if (kind === "pool.buy") await t.proofs();
  }
};
const noteList = async () => (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null, sends: (n.sends ?? []).map((s) => s.signature) }));

// U: the index the note store plans (the flow's planDeposit names the same one until money reaches it)
const { scope, pool } = solanaPoolOf(SOL_POOLS.devnet.program);
const ns = await openNoteStore(w);
const planned = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
const id = depositId(seed64, scope, planned.ref.i);
const U = base58.encode(id.publicKey);
id.secretKey.fill(0);
const rent = await readSolanaRent(rpcs);
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const EMPTY = solanaRentMin(rent, 0);
// a read that fails while U waits is read again: this process holds the only copy of U's seed
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
// the coin's venue and what a buy on it leaves W for its sell, read before U is funded: a run that cannot compute its
// own spend fails here, before any money moves (run 6's first try deposited, then threw on a stale call here, and its
// seed went with it)
const VENUE = SPEND === "max" ? await readSolanaPoolBuyVenue(rpcs, "pump-curve", MINT) : null;
const KEEPS = VENUE === null ? null : solanaPoolBuySellNeed(VENUE, rent);
if (VENUE !== null) log(`venue ${VENUE.kind} (token account ${VENUE.tokenAccountSize} B, cashback ${VENUE.cashback}); a buy leaves W ${KEEPS} for its sell on any venue the coin sells on`);
log(`pool ${pool}; table ${TABLE}; fund U ${U} with exactly ${NEED} lamports (or at least ${NEED + EMPTY}) on devnet`);
for (let b = await balance(); !(b === NEED || b >= NEED + EMPTY); b = await balance()) {
  if (b > 0n) log(`U holds ${b}: waiting for exactly ${NEED} or at least ${NEED + EMPTY}`);
  await sleep(10_000);
}

log("U funded; pool.deposit of 0.01 SOL");
const deposit = await run("pool.deposit", { chain: "solana", amount: "0.01" });
log(`deposit ${JSON.stringify(deposit)}`);
const landed = deposit.notes?.some((n) => n.ref === "deposit" && n.state === "UNSPENT");
let buy = null;
if (landed) {
  log("the proof queue's pass");
  const pass = await t.proofs();
  log(`pass ${JSON.stringify(pass, (k, v) => (typeof v === "bigint" ? String(v) : v))}`);
  let spend = SPEND;
  if (SPEND === "max") {
    const max = solanaPoolBuyMaxSpend({ withdrawnValue: RUNG, relayFee }, VENUE, 0n, rent);
    spend = `0.${String(max).padStart(9, "0")}`;
    log(`max spend on ${VENUE.kind}: ${max} lamports at relay fee ${relayFee}; W keeps ${KEEPS}, its sell's need on any venue`);
  }
  log(`pool.buy of ${spend} SOL of ${MINT}`);
  buy = await run("pool.buy", { chain: "solana", token: MINT, amount: spend, slippage_bps: 300 });
  log(`buy ${JSON.stringify(buy)}`);
}
let sell = null;
const bought = buy?.notes?.some((n) => n.state === "SPENT");
if (bought) {
  const sig = buy.answer.result.txs[0].hash;
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    t = await rpcs[0]("getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!t) await sleep(2_000);
  }
  const W = t.transaction.message.accountKeys[1];
  const accs = (await rpcs[0]("getTokenAccountsByOwner", [W, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }])).value;
  const amount = accs[0].account.data.parsed.info.tokenAmount.uiAmountString;
  log(`W ${W} holds ${(await rpcs[0]("getBalance", [W, { commitment: "finalized" }])).value} lamports after the buy`);
  log(`pool.sell of ${amount} of ${MINT} from W ${W}`);
  sell = await run("pool.sell", { chain: "solana", token: MINT, amount, slippage_bps: 300 });
  log(`sell ${JSON.stringify(sell)}`);
}
const notes = await noteList();
log(`notes ${JSON.stringify(notes)}`);
const told = (kind) => !stages.some((x) => x.kind === kind && x.stage !== "sent" && x.stage !== "filled");
const filled = landed && bought && told("pool.buy") && sell?.answer?.result !== undefined && notes.some((n) => n.ref === "return" && n.state === "UNSPENT" && n.leafIndex !== null) && told("pool.sell");
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, table: TABLE, mint: MINT, spend: SPEND, U, need: String(NEED), deposit, buy, sell, stages, notes, filled }, null, 2) + "\n");
await t.signedOut();
ns.close();
w.close();
process.exit(filled ? 0 : 1);
