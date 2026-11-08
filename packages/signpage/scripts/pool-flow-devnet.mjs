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
//   (DEVNET_TABLE once pinned); the RPCs are the page's own (src/page-rpc.ts: its bounded retry of a 429, a 5xx,
//   -32029/-32429, a non-JSON answer or a stall is the page's, never this script's), each answer of 429 or 5xx logged,
//   and a call that still fails logged with its named fault; the helper's answers are logged by status. Every check,
//   the send and every read-back are the page's own code.
// - FLOW_BURST=1 injects throttles the way a public devnet provider gives them: on each devnet RPC host, the 1st and 2nd
//   of every 15 requests answer 429 with Retry-After 1 (never reaching the provider), and the helper's first POST
//   /v1/pool/solana/send answers its 429 rate_limited with Retry-After 1 (not forwarded). Each injection is logged.
// - Each kind answers at its send and its run goes on; this waits for the run's end (the seed's lock), then reads the
//   notes: the deposit landed when its note is UNSPENT, the buy filled when that note is SPENT and no stage but sent or
//   filled was told, the sell filled when a return note is UNSPENT with a leaf and no stage but sent or filled was told.
//   The sell's amount is all W holds of the coin, as W's token account reads at finalized (W: the buy tx's second key).
// - After the full sell, the rent back runs (card sol-buy-rent-back: the teardown frames, then W's sweep into the pool):
//   W's token account, both volume accounts and W's own lamports are read at finalized (null: no account), and every
//   transaction the page sent is listed by its signature, in order.
// - It writes the answers, the stages, the notes and every tx to <out.json>; exit 0 only when both landed.
// - The run's seed is written, before U is asked for, to ~/.ct-devnet-runs/run-<time>.seed (the folder 0700, the file
//   0600, the 16 bytes in hex; outside the repo, so no commit can carry it; its path is logged, never its bytes), and
//   kept: a run that stops after its deposit leaves notes only that seed can spend (runs 1, 3 and 6's first two tries
//   each stranded 0.01 SOL). FLOW_RESUME=<that file> runs again from it: no U, no deposit; the notes restored from the
//   seed on both devnet RPCs (the wallet's solanaRestoreNotes) into the store, then the buy and the sell as above.
//   FLOW_CRASH_AFTER=deposit stops the run right after its deposit (the resume's test).
// - FLOW_DUST=1 (card sol-rent-back-dust-burn) plants a stranger's unit on W's token account after its full sell: a
//   stranger S (a key made in this run, kept beside the seed as run-<time>.stranger, 0600, never printed) is funded by
//   someone else (its address and lamports printed with U's); after the buy, S takes 1 unit of the coin from W (S pays
//   the fee and its token account's rent, so W keeps exactly its sell's need); W then sells all it holds; once the sell
//   reads confirmed on both RPCs and before the rent back's first read of W's accounts, S sends that unit back to W's
//   token account. FLOW_STRANGER=<that file> uses a kept S again; FLOW_RESUME with FLOW_BUY_SIG=<the buy's signature>
//   goes on from a run that stopped after its buy (no deposit, no buy: the dust step and the sell). The rent back must then burn it, close the account and sweep W: the run is filled only when a
//   teardown frame burns exactly 1 and W, its token account and both volume accounts read null at finalized.
// - Each kind is tapped once. A kind that does not land on its tap is a failed run, recorded as one: it is never tapped
//   again (a re-tap would hide a page that gives up on a busy provider).
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";

// the testnet build's network, set before any module that reads it loads (as test/pool-testnet.test.ts does)
globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { SOL_POOLS, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { solanaRestoreNotes } = await import("../../wallet/src/pool/solana-restore.ts");
const { refKey } = await import("../../wallet/src/notes/store.ts");
const { readSolanaRent, solanaRentMin, readSolanaPoolBuyVenue, solanaPoolBuyMaxSpend, solanaPoolBuySellNeed } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const [TABLE, MINT, SPEND, OUT] = process.argv.slice(2);
if (!OUT) throw new Error("usage: pool-flow-devnet.mjs <table> <mint> <spend SOL> <out.json>");
const RUNG = 10_000_000n;
const FEE = 5_000n;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BURST = process.env.FLOW_BURST === "1";
const RPC_HOSTS = new Set(Object.values(TESTNET_RPCS).flat().map((u) => new URL(u).host));
const injected = { rpc: 0, send: 0 };
const asked = new Map();
// every transaction the page sends on a devnet RPC, by its first signature, in order (card sol-buy-rent-back: the sell,
// then its rent back, the teardown frames and the sweep); public bytes only
const sentTxs = [];
const sentWire = new Map();
const sentOf = (init) => {
  try {
    const b = JSON.parse(String(init?.body ?? ""));
    if (b?.method !== "sendTransaction") return;
    const sig = base58.encode(Buffer.from(String(b.params?.[0]), "base64").subarray(1, 65));
    if (!sentTxs.includes(sig)) sentTxs.push(sig);
    sentWire.set(sig, Buffer.from(String(b.params?.[0]), "base64"));
  } catch {}
};
// FLOW_DUST: the stranger S and its unit (set below); dust.armed is sentTxs' length before the sell's send
const DUST = process.env.FLOW_DUST === "1";
let dust = null;
// every devnet RPC answer of 429 or 5xx is logged (the page retries it); FLOW_BURST injects the bursts above
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const host = new URL(String(u)).host;
  if (!RPC_HOSTS.has(host)) return realFetch(u, init);
  const n = (asked.get(host) ?? 0) + 1;
  asked.set(host, n);
  sentOf(init);
  // FLOW_DUST: the rent back's first read of W and its token account after the sell confirmed waits for S's unit
  if (dust?.armed !== undefined && !dust.sent) {
    try {
      const b = JSON.parse(String(init?.body ?? ""));
      const keys = b?.method === "getMultipleAccounts" ? b.params?.[0] : null;
      if (Array.isArray(keys) && keys.includes(dust.w) && keys.includes(dust.ata) && sentTxs.length > dust.armed) {
        dust.p ??= dustBack().finally(() => (dust.p = null));
        await dust.p;
      }
    } catch (e) {
      log(`dust: ${String(e?.message).slice(0, 160)}`);
    }
  }
  if (BURST && n % 15 <= 2 && n % 15 >= 1) {
    injected.rpc++;
    log(`rpc ${host}: 429 injected (request ${n})`);
    return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "1" } });
  }
  const r = await realFetch(u, init);
  if (r.status === 429 || r.status >= 500) log(`rpc ${host}: HTTP ${r.status} from the provider (request ${n})`);
  return r;
};
// the buy's timeline (card pool-buy-send-fast): from the tap, every RPC call (its provider, method, start and length)
// and every helper call, written to <out.json> as buyTimeline and printed one line each
let tapAt = null;
const timeline = [];
const mark = (what, startMs, ms) => {
  if (tapAt === null) return;
  const e = { what, at: Math.round(startMs - tapAt), ms: Math.round(ms) };
  timeline.push(e);
  log(`t+${e.at} ms ${what} ${e.ms} ms`);
};
// a call that still fails after the page's retry: logged with its named fault (public reads only, never a key or the words)
const logged = (rpc) => {
  const p = async (method, params) => {
    const s = performance.now();
    try {
      return await rpc(method, params);
    } catch (e) {
      log(`rpc ${new URL(rpc.url).host} ${method}: ${String(e?.message).slice(0, 160)}`);
      throw e;
    } finally {
      mark(`rpc ${new URL(rpc.url).host} ${method}`, s, performance.now() - s);
    }
  };
  p.url = rpc.url; // the kit tells two providers apart by their URL
  return p;
};
const rpcs = [logged(testnetRpc(TESTNET_RPCS.solana[0])), logged(testnetRpc(TESTNET_RPCS.solana[1]))];

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
const RESUME = process.env.FLOW_RESUME;
const entropy = RESUME ? Buffer.from(readFileSync(RESUME, "utf8").trim(), "hex") : randomBytes(16);
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
// kept before anything can move: a run that stops past its deposit can be run again from this file (FLOW_RESUME)
if (!RESUME) {
  const dir = join(homedir(), ".ct-devnet-runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const at = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.seed`);
  writeFileSync(at, entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  log(`the run's seed is kept at ${at} (FLOW_RESUME=${at} runs again from it)`);
}
await w.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
entropy.fill(0);
const page = { store: async () => w, seed64: async () => seed64.slice() };
// the helper's fetch, logged: its status for every call
// the relay fee the helper gave the proof's pass (GET /v1/pool/fee), for a "max" spend
let relayFee = null;
const helperFetch = async (url, init) => {
  if (BURST && injected.send === 0 && new URL(url).pathname === "/v1/pool/solana/send") {
    injected.send++;
    log(`helper POST /v1/pool/solana/send: 429 rate_limited injected (not forwarded)`);
    return new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": "1", "content-type": "application/json" } });
  }
  const s = performance.now();
  const r = await fetch(url, init);
  log(`helper ${init?.method ?? "GET"} ${new URL(url).pathname}: HTTP ${r.status}`);
  mark(`helper ${init?.method ?? "GET"} ${new URL(url).pathname} HTTP ${r.status}`, s, performance.now() - s);
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
  if (kind === "pool.buy") tapAt = performance.now();
  const r = kinds[kind](params, { ...ctx(kind), progress: (s) => (stages.push({ kind, stage: s }), kind === "pool.buy" && mark(`progress ${s}`, performance.now(), 0), log(`${kind} progress ${JSON.stringify(s)}`)) });
  if ("error" in r) return { answer: r };
  await r.after;
  const answer = r.answer();
  if (kind === "pool.buy") mark(`answer ${JSON.stringify(answer).slice(0, 40)}`, performance.now(), 0);
  log(`${kind} answered ${JSON.stringify(answer)}; waiting for its run to end`);
  await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
  if (kind === "pool.buy") tapAt = null;
  return { answer, notes: await noteList() };
};
// each kind is tapped once: one that answers an error is the run's failure, recorded as one
const run = (kind, params) => once(kind, params);
const noteList = async () => (await ns.list()).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null, leafIndex: n.leaf ? String(n.leaf.leafIndex) : null, sends: (n.sends ?? []).map((s) => s.signature) }));

// U: the index the note store plans (the flow's planDeposit names the same one until money reaches it)
const { scope, pool } = solanaPoolOf(SOL_POOLS.devnet.program);
const ns = await openNoteStore(w);
let U = null;
if (!RESUME) {
  const planned = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
  const id = depositId(seed64, scope, planned.ref.i);
  U = base58.encode(id.publicKey);
  id.secretKey.fill(0);
}
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
// FLOW_DUST: S, its key kept beside the seed, funded by someone else before anything moves
const { solanaCompileV0 } = await import("../../kit/src/trade/solana/build.ts");
const { solanaDecodeMessage, solanaAta } = await import("../../kit/src/checks/solana/message.ts");
const SYSTEM = "11111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const dustTxs = [];
/** One transaction of `ixs`, `signers` ({ pub, key }) the payer first, sent on both RPCs and read confirmed on both. */
const sendOwn = async (what, ixs, signers) => {
  const { blockhash } = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const { message } = solanaCompileV0(signers[0].pub, ixs, blockhash, [], signers.map((x) => x.pub));
  const m = solanaDecodeMessage(message);
  const wire = new Uint8Array(1 + 64 * m.requiredSignatures + message.length);
  wire[0] = m.requiredSignatures;
  for (let i = 0; i < m.requiredSignatures; i++) wire.set(ed25519.sign(message, signers.find((x) => x.pub === m.staticKeys[i]).key), 1 + 64 * i);
  wire.set(message, 1 + 64 * m.requiredSignatures);
  const sig = base58.encode(wire.subarray(1, 65));
  dustTxs.push({ what, sig });
  log(`${what}: ${sig}`);
  await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(wire), { encoding: "base64", preflightCommitment: "confirmed" }])));
  for (let i = 0; i < 60; i++) {
    const st = await Promise.all(rpcs.map(async (r) => (await r("getSignatureStatuses", [[sig]])).value[0]));
    if (st.some((x) => x?.err)) throw new Error(`${what} failed: ${JSON.stringify(st.map((x) => x?.err ?? null))}`);
    if (st.every((x) => x?.confirmationStatus === "confirmed" || x?.confirmationStatus === "finalized")) return sig;
    await sleep(1_000);
  }
  throw new Error(`${what} not confirmed on both RPCs`);
};
const tokenProgram = (await rpcs[0]("getAccountInfo", [MINT, { encoding: "base64", commitment: "confirmed" }])).value.owner;
const decimals = Buffer.from((await rpcs[0]("getAccountInfo", [MINT, { encoding: "base64", commitment: "confirmed" }])).value.data[0], "base64")[44];
const transfer = (from, to, owner, signer) => {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked(amount 1, decimals)
  new DataView(data.buffer).setBigUint64(1, 1n, true);
  data[9] = decimals;
  return { program: tokenProgram, accounts: [{ key: from, signer: false, writable: true }, { key: MINT, signer: false, writable: false }, { key: to, signer: false, writable: true }, { key: owner, signer, writable: false }], data };
};
if (DUST) {
  const kept = process.env.FLOW_STRANGER;
  const key = kept ? Uint8Array.from(Buffer.from(readFileSync(kept, "utf8").trim(), "hex")) : Uint8Array.from(randomBytes(32));
  if (key.length !== 32) throw new Error("the stranger's file holds no 32-byte key");
  const dir = join(homedir(), ".ct-devnet-runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = kept ?? join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.stranger`);
  if (!kept) writeFileSync(at, Buffer.from(key).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  const S = base58.encode(ed25519.getPublicKey(key));
  // S's token account (Token-2022's with ImmutableOwner is 170 bytes; 200 bounds it), its two fees, and S's own
  // rent-exempt minimum, since S stays open after them (12:45Z: S at 1,700,000 failed "insufficient funds for rent")
  const need = solanaRentMin(rent, 200) + solanaRentMin(rent, 0) + 2n * FEE;
  dust = { S, key, need, ata: null, w: null, armed: undefined, sent: false, p: null };
  log(`FLOW_DUST: the stranger S ${S} (its key kept at ${at}); fund S with at least ${need} lamports on devnet (S is waited for after the buy, U first)`);
}
/** S's unit back to W's token account, once the sell reads confirmed and ok on both RPCs; false while it does not. */
async function dustBack() {
  const sell = sentTxs[dust.armed];
  const st = await Promise.all(rpcs.map(async (r) => (await r("getSignatureStatuses", [[sell]])).value[0]));
  if (!st.every((x) => x && x.err === null && (x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized"))) return false;
  dust.sent = true;
  await sendOwn("dust: S's 1 unit to W's token account after the sell filled", [transfer(solanaAta(dust.S, MINT, tokenProgram), dust.ata, dust.S, true)], [{ pub: dust.S, key: dust.key }]);
  return true;
}
let deposit;
if (RESUME) {
  // the notes from the seed alone, as a restore reads them: each into the store, a change note under its parent
  const r = await solanaRestoreNotes({ seed64, program: SOL_POOLS.devnet.program, rpcs });
  const ids = new Map();
  for (const n of r.notes) {
    const rec = await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: "UNSPENT", leaf: n.leaf, ...(n.parent === undefined ? {} : { parent: ids.get(n.parent) }) });
    ids.set(refKey(n.ref), rec.id);
  }
  deposit = { resumed: RESUME, notes: await noteList() };
  log(`resumed from the seed file: ${JSON.stringify(deposit.notes)}`);
} else {
  log(`pool ${pool}; table ${TABLE}; fund U ${U} with exactly ${NEED} lamports (or at least ${NEED + EMPTY}) on devnet`);
  for (let b = await balance(); !(b === NEED || b >= NEED + EMPTY); b = await balance()) {
    if (b > 0n) log(`U holds ${b}: waiting for exactly ${NEED} or at least ${NEED + EMPTY}`);
    await sleep(10_000);
  }
  log("U funded; pool.deposit of 0.01 SOL");
  deposit = await run("pool.deposit", { chain: "solana", amount: "0.01" });
  log(`deposit ${JSON.stringify(deposit)}`);
  if (process.env.FLOW_CRASH_AFTER === "deposit") {
    log("stopped after the deposit (FLOW_CRASH_AFTER=deposit): the seed stays in its file");
    process.exit(3);
  }
}
const landed = deposit.notes?.some((n) => n.ref === "deposit" && n.state === "UNSPENT");
let buy = null;
// a run that stopped after its buy, resumed: its buy's signature, its note SPENT in the restored store
if (RESUME && process.env.FLOW_BUY_SIG) buy = { answer: { result: { txs: [{ hash: process.env.FLOW_BUY_SIG }] } }, notes: await noteList(), resumedAfterBuy: true };
else if (landed) {
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
let rentBack = null;
const bought = buy?.notes?.some((n) => n.state === "SPENT");
if (bought) {
  const sig = buy.answer.result.txs[0].hash;
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    t = await rpcs[0]("getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!t) await sleep(2_000);
  }
  const W = t.transaction.message.accountKeys[1];
  if (DUST) {
    for (;;) {
      const got = await Promise.all(rpcs.map(async (r) => BigInt((await r("getBalance", [dust.S, { commitment: "confirmed" }])).value)));
      if (got.every((b) => b >= dust.need)) break;
      log(`S holds ${got.join("/")}: waiting for at least ${dust.need}`);
      await sleep(10_000);
    }
    log("S funded");
    // W's key from the seed: the spent note's label and j (buy-wallets.ts: each spent note names its W), then S takes
    // 1 unit: S pays, W only signs
    const { jOf } = await import("../../wallet/src/pool/queue.ts");
    const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
    const fw = (await ns.list()).filter((n) => n.state === "SPENT" && n.leaf).map((n) => freshWallet(seed64, "sol", n.leaf.label, jOf(n.ref))).find((x) => x.address === W);
    if (!fw || base58.encode(fw.publicKey) !== W) throw new Error("W's key is not W");
    const wKey = fw.secretKey.slice(0, 32);
    fw.secretKey.fill(0);
    const sAta = solanaAta(dust.S, MINT, tokenProgram);
    dust.ata = solanaAta(W, MINT, tokenProgram);
    dust.w = W;
    const create = { program: ATA_PROGRAM, accounts: [{ key: dust.S, signer: true, writable: true }, { key: sAta, signer: false, writable: true }, { key: dust.S, signer: false, writable: false }, { key: MINT, signer: false, writable: false }, { key: SYSTEM, signer: false, writable: false }, { key: tokenProgram, signer: false, writable: false }], data: Uint8Array.of(1) };
    try {
      await sendOwn("dust setup: S takes 1 unit from W before the sell (S pays)", [create, transfer(dust.ata, sAta, W, true)], [{ pub: dust.S, key: dust.key }, { pub: W, key: wKey }]);
    } finally {
      wKey.fill(0);
    }
    // the sell's amount is read at finalized below: wait until the setup is finalized
    for (let i = 0; i < 60; i++) {
      const st = (await rpcs[0]("getSignatureStatuses", [[dustTxs.at(-1).sig]])).value[0];
      if (st?.confirmationStatus === "finalized") break;
      await sleep(2_000);
    }
  }
  const accs = (await rpcs[0]("getTokenAccountsByOwner", [W, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }])).value;
  const amount = accs[0].account.data.parsed.info.tokenAmount.uiAmountString;
  log(`W ${W} holds ${(await rpcs[0]("getBalance", [W, { commitment: "finalized" }])).value} lamports after the buy`);
  log(`pool.sell of ${amount} of ${MINT} from W ${W}`);
  if (DUST) dust.armed = sentTxs.length;
  sell = await run("pool.sell", { chain: "solana", token: MINT, amount, slippage_bps: 300 });
  log(`sell ${JSON.stringify(sell)}`);
  // the rent back (card sol-buy-rent-back): after the full sell, W's token account and volume accounts at finalized,
  // and W's own lamports: each closed (null) and W at 0 when it all came back; read once every transaction the page
  // sent is finalized (90 s at most), since the page reads its rent back at confirmed
  for (let i = 0; i < 45; i++) {
    const st = (await rpcs[0]("getSignatureStatuses", [sentTxs])).value;
    if (st.every((s) => s?.confirmationStatus === "finalized")) break;
    await sleep(2_000);
  }
  const info =async (a) => (await rpcs[0]("getAccountInfo", [a, { encoding: "base64", commitment: "finalized" }])).value;
  const program = (await info(MINT)).owner;
  const { solanaVolumeAccumulator, SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM } = await import("../../kit/src/checks/solana/checks.ts");
  const left = async (a) => (await info(a))?.lamports ?? null;
  rentBack = { W, tokenAccount: await left(solanaAta(W, MINT, program)), pumpVolume: await left(solanaVolumeAccumulator(W, SOLANA_PUMP_PROGRAM)), ammVolume: await left(solanaVolumeAccumulator(W, SOLANA_PUMP_AMM_PROGRAM)), w: await left(W) };
  log(`after the rent back ${JSON.stringify(rentBack)}`);
  // FLOW_DUST: the teardown frame that burned S's unit (a token program's Burn, tag 8, of W's token account)
  if (DUST) {
    for (const sig of sentTxs) {
      const wire = sentWire.get(sig);
      if (!wire) continue;
      const m = solanaDecodeMessage(wire.subarray(1 + 64 * wire[0]));
      for (const ix of m.instructions) {
        const prog = m.staticKeys[ix.programIndex];
        if (prog === tokenProgram && ix.data.length === 9 && ix.data[0] === 8 && m.staticKeys[ix.accounts[0]] === dust.ata) dust.burned = { sig, amount: String(new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true)) };
      }
    }
    log(`dust: sent back ${dust.sent}; burned ${JSON.stringify(dust.burned ?? null)}`);
  }
}
const notes = await noteList();
log(`notes ${JSON.stringify(notes)}`);
const told = (kind) => !stages.some((x) => x.kind === kind && x.stage !== "sent" && x.stage !== "filled");
const dusted = !DUST || (dust.sent && dust.burned?.amount === "1" && rentBack !== null && Object.entries(rentBack).every(([k, v]) => k === "W" || v === null));
const filled = dusted && landed && bought && told("pool.buy") && sell?.answer?.result !== undefined && notes.some((n) => n.ref === "return" && n.state === "UNSPENT" && n.leafIndex !== null) && told("pool.sell");
seed64.fill(0);
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), cluster: "devnet", program: SOL_POOLS.devnet.program, pool, table: TABLE, mint: MINT, spend: SPEND, resumed: Boolean(RESUME), burst: BURST, injected, dust: DUST ? { S: dust.S, sent: dust.sent, burned: dust.burned ?? null, txs: dustTxs } : null, U, need: String(NEED), deposit, buy, buyTimeline: timeline, sell, rentBack, sentTxs, stages, notes, filled }, null, 2) + "\n");
await t.signedOut();
ns.close();
w.close();
process.exit(filled ? 0 : 1);
