// Real devnet runs of card buy-spends-several-pieces through the signing page's own testnet flow: the page's pool kinds
// (src/pool-kinds.ts poolKinds over src/pool-testnet.ts testnetPool, as main.ts wires the testnet build) on the devnet
// pool it pins, the helper at FLOW_HELPER (its POST /v1/pool/solana/pieces and its /v1/rpc/solana-devnet getBlock header
// read), and the page's own pool.buy.dry (src/pools.ts poolBuyDryKind) to see when a set of pieces is ready.
//   FLOW_HELPER=<helper origin> node packages/signpage/scripts/pool-buy-pieces-devnet.mjs <scenario> <table> <mint> <out.json>
// FLOW_HELPER (required, no default): every call the page and this script make to the helper's address (src/trade.ts
// TRADE_HELPER) goes to this origin instead, its RPC route included; its X-Helper-Commit is written to out.json.
// Scenarios:
//   pieces-2, pieces-3, pieces-4
//                       k pool.deposits of 0.01 SOL; the proof queue's passes until pool.buy.dry answers k pieces for
//                       the most k pieces spend on the coin's venue; one pool.buy of that; then a second device, a fresh
//                       store signed in with the same words, restores from the seed alone and finds W (the buy's note's
//                       own W) among its spent notes' Ws, holding the coin.
//   back-to-back        4 deposits; a buy of 2 pieces, then, once pool.buy.dry answers 2 pieces again, a second one;
//                       the proof gap (the first buy's end to the second set ready) timed.
//   landed-reload       2 deposits; one buy of 2 pieces whose page closes at the helper's answer to the pieces (its
//                       every read, send and helper call hangs from there); a new page on the same store loads every
//                       LOAD_MS until the owed record is gone. PASS: the record dropped as landed (the tag 3 its own
//                       note's spend), W holds the coin and keeps its SOL (no sweep), the buy's note SPENT.
//   tag3-fail           2 deposits; one buy of 2 pieces at slippage 1 bp; when the page posts the pieces to the helper,
//                       the run's funder F first buys the coin on its curve (FRONT lamports, landed on both RPCs), so the
//                       tag 3's min out fails on chain while the tag 2s land and pay W. Then FLOW_AFTER:
//                         stay (default)  the same page: its run strands W and its rent back sweeps W into the pool;
//                         reload          the page closes at the helper's answer to the pieces; a new page on the
//                                         same store loads every LOAD_MS until W is swept;
//                         stop            the process ends at the helper's answer to the pieces; W is left holding the
//                                         pieces' SOL, for `found`. Its out.json names W.
//   found               FLOW_RESUME=<seed of a tag3-fail stop run> FLOW_W=<its W>: a fresh store signed in with those
//                       words, the page's restore, then a load every LOAD_MS: each load's rent back lines, W's lamports,
//                       W's latest transaction, its block's height and each RPC's finalized height. FLOW_PLANT, sent by F
//                       right after the restore (F funded first):
//                         none (default)  nothing: held while + 151 is not past, then swept;
//                         pay             1,000,000 lamports to W: the clock runs from that signature, then swept;
//                         empty           an empty wSOL token account owned by W: held while + 151 from its create is
//                                         not past, then swept with that account closed (read gone on both RPCs);
//                         token           1 unit of <mint> in W's token account: held for good (the run passes when
//                                         W keeps its SOL for 2 loads past + 151).
//                       FLOW_EXPECT=held (any plant) passes when W keeps its SOL for 2 loads past + 151, as a helper
//                       that refuses the header read leaves it; else (swept) PASS needs every load before + 151 held
//                       and W swept within SWEEP_WAIT_MS.
// - A seed made in this run only (16 random bytes), never printed, kept at ~/.ct-devnet-runs/run-<time>.seed (0600;
//   FLOW_DIR=<folder> keeps it there instead, the folder made 0700), and
//   a funder F's key beside it (run-<time>.funder, 0600; FLOW_FUNDER=<file> uses a kept one). F's address and what it
//   must hold are printed first; someone else funds F, and this waits. FLOW_SWEEP_F_TO=<address> with FLOW_FUNDER: F's
//   balance back, no run.
// - What differs from the page in a browser, and only that: the stores are fake-indexeddb in memory; the prover is
//   snarkjs's fullProve in this process (the setup files checked by sha256 against ZK_SETUP_FILES); the helper's
//   address. Every check, every send and every read-back is the page's own code; this script sends only F's payments,
//   F's front-run buy and F's plants.
// - It writes every answer, stage, time, note and transaction to <out.json> and prints PASS or FAIL with what decided it;
//   exit 0 only on PASS.
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { COPY, copyAirdrop, copyNet } from "./copy-net.mjs";

// FLOW_COPY (./copy-net.mjs, run by ./sol-mainnet-copy.mjs SOL_COPY_FLOW=pieces): the mainnet build on a local copy of
// mainnet, its helper the sender in process, every payment the copy's airdrop; else the testnet build on devnet
globalThis.__SIGN_NETWORK__ = COPY ? "mainnet" : "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { jOf } = await import("../../wallet/src/pool/queue.ts");
const { SOL_EPOCH_MS, SOL_POOLS, SOL_POOL_TABLES, solanaNow, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
const { readSolanaRent, solanaRentMin, readSolanaPoolBuyVenue, solanaPoolBuyMaxSpend, solanaPoolBuySteps } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { HELPER_SOLANA_BLOCK_HEADER } = await import("../../kit/src/index.ts");
const { solanaCompileV0 } = await import("../../kit/src/trade/solana/build.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { PAGE_POOLS, poolBuyDryKind } = await import("../src/pools.ts");
const { poolRestore } = await import("../src/pool-restore.ts");
const { TESTNET_RPCS, testnetPool, testnetPoolDeps, testnetRpc } = await import("../src/pool-testnet.ts");
const { solanaPacedRpc } = await import("../../kit/src/trade/solana/send.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { WALLET_SEED_LOCK } = await import("@blindfill/wallet/store");
const { TRADE_HELPER } = await import("../src/trade.ts");
const { solanaAta, SOLANA_ATA_PROGRAM } = await import("../../kit/src/checks/solana/message.ts");
const { SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM } = await import("../../kit/src/checks/solana/checks.ts");
if (!COPY && (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined)) throw new Error("not the testnet build's pins");
const { SOLANA_POOL_JITO_TIP } = await import("../../kit/src/checks/solana/checks.ts");

// copy-part1 (FLOW_COPY only): 6 deposits of 0.01 SOL, none enough alone; with all 6 ready, a buy that needs 5 (past
// SOLANA_POOL_BUY_PIECES_MAX): refused, nothing taken or sent; a buy that needs 2 pieces; then Max, which takes the 4 left
// copy-legs (FLOW_COPY only, card buy-any-amount-on-every-chain): 6 deposits of 0.01 SOL; with all 6 ready, the same ask
// of 5 pieces is the page's legs, each its own W and pieces, filled in one tap
// copy-takeable (FLOW_COPY only): 5 deposits of 0.01 SOL (an account of several small notes); the ms until Max reads 4
// pieces ready, then again on a fresh load of the same store (a reload: the new page's queue makes every proof again);
// then, on a note landed this epoch (its proof on the newest root), Max tapped 16 to 40 s past the next boundary of the
// pool's time, while that proof's remake may run past its 15 s grace: it fills (or is not_funded), never fails. A
// timeline each second (the pool's time, Max and its pieces, the ready proofs by root and epoch) and every pass and
// proof's ms go in the record. FLOW_TAKEABLE_ROUNDS=0 stops after the load's Max; FLOW_PROVER_THREADS=1 proves on threads.
const SCENARIOS = { "copy-part1": 6, "copy-legs": 6, "copy-takeable": 5, "pieces-2": 2, "pieces-3": 3, "pieces-4": 4, "back-to-back": 4, "landed-reload": 2, "tag3-fail": 2, found: 0 };
const [SCENARIO, TABLE, MINT, OUT] = process.argv.slice(2);
if (!OUT || !Object.hasOwn(SCENARIOS, SCENARIO)) throw new Error(`usage: pool-buy-pieces-devnet.mjs <${Object.keys(SCENARIOS).join("|")}> <table> <mint> <out.json>`);
if (SCENARIO.startsWith("copy-") && !COPY) throw new Error(`${SCENARIO} runs on the copy only (FLOW_COPY)`);
// the page loads the tables its build pins (PAGE_TABLES); <table> names the pump-curve one the run expects (the copy: pinned)
if (COPY ? TABLE !== "pinned" : !(SOL_POOL_TABLES.devnet?.["pump-curve"] ?? []).includes(TABLE)) throw new Error(`<table> is not a pump-curve table the testnet build pins: ${JSON.stringify(SOL_POOL_TABLES.devnet?.["pump-curve"] ?? [])}`);
const AFTER = process.env.FLOW_AFTER ?? "stay";
if (!["stay", "reload", "stop"].includes(AFTER)) throw new Error("FLOW_AFTER is stay, reload or stop");
const RESUME = process.env.FLOW_RESUME;
if ((SCENARIO === "found") !== Boolean(RESUME)) throw new Error("found runs, and only found runs, take FLOW_RESUME=<seed file>");
const FOUND_W = process.env.FLOW_W;
if (SCENARIO === "found" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(FOUND_W ?? "")) throw new Error("found takes FLOW_W=<W's address from the stop run's out.json>");
const PLANT = process.env.FLOW_PLANT ?? "none";
if (!["none", "pay", "empty", "token"].includes(PLANT) || (PLANT !== "none" && SCENARIO !== "found")) throw new Error("FLOW_PLANT is none, pay, empty or token, on found only");
const EXPECT = process.env.FLOW_EXPECT ?? (PLANT === "token" ? "held" : "swept");
if (!["held", "swept"].includes(EXPECT)) throw new Error("FLOW_EXPECT is held or swept");
const HELPER = COPY ? "the copy's sender, in process" : process.env.FLOW_HELPER;
if (!COPY && !/^https?:\/\/[^/]+$/.test(HELPER ?? "")) throw new Error("FLOW_HELPER=<the helper's origin: https://ct-api.unrealized.trade, or a local helper's http://127.0.0.1:<port>>");
// every call to the page's helper address goes to FLOW_HELPER (solanaJsonRpc and the pool's helper calls read the global
// fetch at each call)
const realFetch = globalThis.fetch;
if (!COPY) globalThis.fetch = (u, init) => {
  const href = typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
  if (!href.startsWith(`${TRADE_HELPER}/`)) return realFetch(u, init);
  const to = HELPER + href.slice(TRADE_HELPER.length);
  return realFetch(typeof u === "string" || u instanceof URL ? to : new Request(to, u), init);
};
const N = SCENARIOS[SCENARIO];
const RUNG = 10_000_000n;
const FEE = 5_000n;
const FRONT = 50_000_000n; // F's front-run buy on the curve: moves the price well past 1 bp
const LOAD_MS = 20_000;
const SWEEP_WAIT_MS = 8 * 60_000;
const SYSTEM = "11111111111111111111111111111111";
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? String(v) : v);
const solOf = (l) => `${l / 1_000_000_000n}.${String(l % 1_000_000_000n).padStart(9, "0")}`;

// the rent back's lines (the sell host's told: `rent back <W> <step> <state> <detail>`), kept with their time
const told = [];
const warn = console.warn.bind(console);
console.warn = (...a) => {
  const line = a.map(String).join(" ");
  if (line.startsWith("rent back")) told.push({ at: new Date().toISOString(), line });
  warn(...a);
};

// FLOW_COPY: the step under way, for the copy's record of each send and failed simulation
let phase = "start";
const copy = COPY ? await copyNet({ log, phase: () => phase }) : null;
// paced as the page's pair is (pool-testnet.ts pageSolanaRpcs); the copy's one RPC under two names
const rpcs = COPY ? copy.rpcs : TESTNET_RPCS.solana.slice(0, 2).map((u) => solanaPacedRpc(testnetRpc(u)));
const PIN = COPY ? copy.pin : SOL_POOLS.devnet;
/** This script's own reads: a provider's refusal is read again, 10 tries 3 s apart. */
const again = async (f) => {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 9) throw e;
      await sleep(3_000);
    }
  }
};
const both = (f) => Promise.all(rpcs.map((r) => again(() => f(r))));

// FLOW_PROVER_THREADS=1: snarkjs proves on its own threads in this process (worker_threads), as the page's prover does on
// its workers; else one thread
const THREADED = process.env.FLOW_PROVER_THREADS === "1";
// FLOW_TAKEABLE_ROUNDS: copy-takeable's taps past a boundary (default 3; 0 stops after the load's Max)
const ROUNDS = Number(process.env.FLOW_TAKEABLE_ROUNDS ?? 3);
if (!Number.isInteger(ROUNDS) || ROUNDS < 0 || ROUNDS > 3) throw new Error("FLOW_TAKEABLE_ROUNDS is 0 to 3");
const KIT_ZK = new URL("../../kit/zk/", import.meta.url);
const file = (name) => {
  const b = readFileSync(new URL(name, KIT_ZK));
  if (createHash("sha256").update(b).digest("hex") !== ZK_SETUP_FILES[name].sha256) throw new Error(`${name}: not the pinned setup file`);
  return new Uint8Array(b);
};
const WASM = file("withdraw.wasm");
const ZKEY = file("withdraw.zkey");
const snarkjs = createRequire(new URL("../../kit/package.json", import.meta.url))("snarkjs");
const proveLog = []; // every proof's end and ms (this machine's one thread)
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: !THREADED });
    const proveMs = Math.round(performance.now() - t0);
    proveLog.push({ at: Date.now(), ms: proveMs });
    return { proof, publicSignals, proveMs };
  },
};

// the run's seed and F's key, kept before anything can move
const DIR = COPY ? COPY.dir : process.env.FLOW_DIR ?? join(homedir(), ".ct-devnet-runs");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const entropy = RESUME ? Buffer.from(readFileSync(RESUME, "utf8").trim(), "hex") : randomBytes(16);
if (entropy.length !== 16) throw new Error("the seed file holds no 16-byte seed");
const SEED_AT = RESUME ?? join(DIR, `run-${STAMP}.seed`);
if (!RESUME) writeFileSync(SEED_AT, entropy.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
log(RESUME ? `the words of ${RESUME}, signed in to a fresh store` : `the run's seed is kept at ${SEED_AT} (FLOW_RESUME=${SEED_AT} signs its words in again)`);
const keptF = process.env.FLOW_FUNDER;
const fKey = keptF ? Uint8Array.from(Buffer.from(readFileSync(keptF, "utf8").trim(), "hex")) : Uint8Array.from(randomBytes(32));
if (fKey.length !== 32) throw new Error("the funder's file holds no 32-byte key");
if (!keptF) writeFileSync(join(DIR, `run-${STAMP}.funder`), Buffer.from(fKey).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
const F = base58.encode(ed25519.getPublicKey(fKey));
const seed64 = wordsToSeed64(entropyToWords(Uint8Array.from(entropy)));
const { scope } = solanaPoolOf(PIN.program);

const balanceOf = async (a) => {
  const got = await both(async (r) => BigInt((await r("getBalance", [a, { commitment: "confirmed" }])).value));
  return got[0] < got[1] ? got[0] : got[1];
};
/** F signs and sends `ixs` (on both RPCs) and waits for it to read confirmed on both. */
const fSend = async (what, ixs) => {
  const { blockhash } = (await again(() => rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }]))).value;
  const { message } = solanaCompileV0(F, ixs, blockhash, [], [F]);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(ed25519.sign(message, fKey), 1);
  wire.set(message, 65);
  const sig = base58.encode(wire.subarray(1, 65));
  log(`F ${what}: ${sig}`);
  await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(wire), { encoding: "base64", preflightCommitment: "confirmed" }])));
  for (let i = 0; i < 60; i++) {
    const st = await both(async (r) => (await r("getSignatureStatuses", [[sig]])).value[0]);
    if (st.some((x) => x?.err)) throw new Error(`F's ${what} failed: ${JSON.stringify(st.map((x) => x?.err ?? null))}`);
    if (st.every((x) => x?.confirmationStatus === "confirmed" || x?.confirmationStatus === "finalized")) return sig;
    await sleep(1_000);
  }
  throw new Error(`F's ${what} not confirmed on both RPCs`);
};
const pay = (to, lamports) => {
  if (COPY) return copyAirdrop(rpcs[0], to, lamports);
  const data = new Uint8Array(12);
  data[0] = 2;
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return fSend(`pays ${to} ${lamports}`, [{ program: SYSTEM, accounts: [{ key: F, signer: true, writable: true }, { key: to, signer: false, writable: true }], data }]);
};
if (process.env.FLOW_SWEEP_F_TO) {
  if (!keptF) throw new Error("FLOW_SWEEP_F_TO needs FLOW_FUNDER");
  log(`F swept: ${await pay(process.env.FLOW_SWEEP_F_TO, (await balanceOf(F)) - FEE)}`);
  process.exit(0);
}

const rent = await again(() => readSolanaRent(rpcs));
const VENUE = await again(() => readSolanaPoolBuyVenue(rpcs, "pump-curve", MINT));
const NEED = RUNG + solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor + FEE;
const F_NEEDS = BigInt(N) * (NEED + FEE) + (SCENARIO === "tag3-fail" ? FRONT + solanaRentMin(rent, 165) + 10n * FEE : 0n) + solanaRentMin(rent, 0);

const idb = new IDBFactory();
// the device's own database beside the wallet's (src/device-spacing.ts, the rent back's spacing reads globalThis's), as
// a browser has it and pool-flow-devnet.mjs sets it: with none, every leftover pass is held and W is never swept
globalThis.indexedDB ??= idb;
const store = await openWalletStore({ indexedDB: idb });
// every W an owed record of a buy of several pieces names, in the order written (a landed buy's record goes at its end)
const owedWs = [];
const storeUpdate = store.update.bind(store);
store.update = async (...a) => {
  const r = await storeUpdate(...a);
  const [name, key] = a;
  if (name === "meta" && key === "owed/pieces-sol") for (const a of Object.keys((await store.get("meta", key)) ?? {})) if (!owedWs.includes(a)) owedWs.push(a);
  return r;
};
await store.insertSeed({ v: 1, entropy: Uint8Array.from(entropy), source: "code", code_saved: true, created_ms: Date.now() });
entropy.fill(0);
let relayFee = null;
const sent = []; // every transaction a page sends on a devnet RPC, by its signature, in order (public bytes only)

/**
 * One page on `w` (a load): its own reads, sends and helper calls, which all hang from `cut()` on (a closed tab), its
 * pool kinds and its pool.buy.dry. `onPieces` runs before the page's POST of the pieces reaches the helper, `piecesAnswered`
 * once the helper has answered it.
 */
function page(name, w, hooks = {}) {
  let dead = false;
  let onCut;
  const cutP = new Promise((r) => (onCut = r));
  const hang = () => new Promise(() => {});
  const live = (rpc) => {
    const p = async (method, params) => {
      if (dead) return hang();
      if (method === "sendTransaction") {
        const sig = base58.encode(Buffer.from(String(params?.[0]), "base64").subarray(1, 65));
        if (!sent.includes(sig)) sent.push(sig);
      }
      return rpc(method, params);
    };
    p.url = rpc.url; // the kit tells two providers apart by their URL
    return p;
  };
  const prs = [live(rpcs[0]), live(rpcs[1])];
  const helperFetch = async (url, init) => {
    if (dead) return hang();
    const path = new URL(url).pathname;
    if (path === "/v1/pool/solana/pieces" && hooks.onPieces) await hooks.onPieces();
    const r = await fetch(url, init);
    log(`${name} helper ${init?.method ?? "GET"} ${path}: HTTP ${r.status}`);
    if (path === "/v1/pool/fee" && r.status === 200) relayFee = BigInt(JSON.parse(await r.clone().text()).fee);
    if (path === "/v1/pool/solana/pieces" && hooks.piecesAnswered) await hooks.piecesAnswered(r.clone());
    return dead ? hang() : r;
  };
  const host = { store: async () => w, seed64: async () => seed64.slice() };
  const t = testnetPool(host, { rpcs: prs, prover: { vault, stop: () => {} }, fetch: helperFetch, ...(COPY ? { pin: copy.pin, holdings: copy.holdings } : {}) });
  const kinds = poolKinds({ ...testnetPoolDeps(t.flow), rpcs: (c) => (c === "solana" ? prs : testnetPoolDeps().rpcs(c)) });
  const notesOf = async () => (await (await openNoteStore(w)).list());
  const dry = poolBuyDryKind({ pools: PAGE_POOLS, rpcs: () => prs, rent: () => rent, ready: async () => {
    const r = await t.readyWith(notesOf);
    return { notes: r.value, ready: r.ready, open: r.open, landed: r.landed };
  }, trading: () => false });
  const ask = async (amount) => {
    const r = dry({ chain: "solana", token: MINT, amount });
    await r.after;
    return r.answer();
  };
  const askMax = async () => {
    const r = dry({ chain: "solana", token: MINT });
    await r.after;
    return r.answer();
  };
  return { name, w, t, kinds, ask, askMax, notesOf, cutP, cut: () => void ((dead = true), onCut()), get dead() { return dead; } };
}

const stages = [];
/** One tap of `kind` on page `p`: its answer at its send, then (unless `noEnd`) the run's end; its times from the tap. */
const once = async (p, kind, params, noEnd = false) => {
  const tap = performance.now();
  const times = {};
  const r = p.kinds[kind](params, { id: `${p.name}-${kind}-${stages.length}`, sha: "00", progress: (s) => {
    times[s.stage ?? JSON.stringify(s)] ??= Math.round(performance.now() - tap);
    stages.push({ page: p.name, kind, stage: s, ms: Math.round(performance.now() - tap) });
    log(`${p.name} ${kind} progress ${JSON.stringify(s)}`);
  } });
  if ("error" in r) return { answer: r, times };
  await r.after;
  const answer = r.answer();
  times.answer = Math.round(performance.now() - tap);
  log(`${p.name} ${kind} answered ${JSON.stringify(answer)}`);
  if (!noEnd) {
    await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
    times.ended = Math.round(performance.now() - tap);
  }
  return { answer, times };
};
const lastStage = (p, kind) => stages.filter((x) => x.page === p.name && x.kind === kind).at(-1)?.stage ?? null;
const stageName = (s) => (typeof s === "string" ? s : s?.stage ?? null);

/** Each signature read on both RPCs at finalized: its error, or "missing" once 30 s passed with an RPC not holding it.
 *  `waited` gets, per signature, the seconds from the read-back's start until both RPCs held it, or null at 30 s. */
const readBack = async (sigs, waited = {}) => {
  const out = {};
  const t0 = performance.now();
  for (const s of sigs) {
    const read = async () => (await both(async (r) => (await r("getSignatureStatuses", [[s], { searchTransactionHistory: true }])).value[0])).map((x) => (x === null ? "missing" : x.err === null ? x.confirmationStatus : `err ${JSON.stringify(x.err)}`));
    let st = await read();
    while (st.includes("missing") && performance.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 500)), (st = await read());
    out[s] = st;
    waited[s] = st.includes("missing") ? null : Math.round(performance.now() - t0) / 1000;
    log(`read-back ${s}: ${st.join(", ")}, ${waited[s] === null ? "not held by both RPCs at 30 s" : `held by both RPCs ${waited[s]} s after the read-back began`}`);
  }
  return out;
};
/** W's lamports and its token accounts' units of the coin, on both RPCs at confirmed. */
const wHolds = async (W) => {
  const lamports = await both(async (r) => String((await r("getBalance", [W, { commitment: "confirmed" }])).value));
  const units = await both(async (r) => {
    const v = (await r("getTokenAccountsByOwner", [W, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed" }])).value;
    return String(v.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n));
  });
  return { lamports, units };
};
/** W's latest transaction, its block's height and each RPC's finalized height, both RPCs (the found W's rule's reads). */
const wClock = async (W) => {
  const last = await both(async (r) => (await r("getSignaturesForAddress", [W, { limit: 1, commitment: "confirmed" }]))[0] ?? null);
  // each RPC's own answer, a refusal kept as its message (a helper that refuses the header read)
  const height = last[0] ? await Promise.all(rpcs.map((r) => r("getBlock", [last[0].slot, HELPER_SOLANA_BLOCK_HEADER]).then((b) => b?.blockHeight ?? null, (e) => `refused: ${String(e?.message ?? e).slice(0, 120)}`))) : [null, null];
  const finalized = await both(async (r) => r("getBlockHeight", [{ commitment: "finalized" }]));
  const h = height.find((x) => typeof x === "number") ?? null;
  return { latest: last.map((x) => x?.signature ?? null), height, finalized, past: h !== null && finalized.every((f) => f > h + 151) };
};

const helperCommit = await fetch(`${TRADE_HELPER}/v1/health`).then((r) => r.headers.get("x-helper-commit"), () => null);
log(`the helper at ${HELPER}: commit ${helperCommit}`);
const out = { at: new Date().toISOString(), scenario: SCENARIO, after: AFTER, plant: PLANT, expect: EXPECT, cluster: COPY ? "mainnet copy" : "devnet", program: PIN.program, table: TABLE, mint: MINT, seed: SEED_AT, F, helper: { base: HELPER, commit: helperCommit } };
const finish = (ok, why) => {
  out.ok = ok;
  out.why = why;
  out.stages = stages;
  out.proofs = proveLog;
  out.sent = sent;
  out.told = told;
  // FLOW_COPY: each send by its step (the copy's record reads each back), the helper's send lines, the stand-in's calls
  if (copy) Object.assign(out, { steps: copy.sent.map((x) => ({ step: x.phase, signature: x.signature })), sendLines: copy.sendLines, engineCalls: copy.engineCalls, simFails: copy.simFails, fee: String(copy.fee) });
  writeFileSync(OUT, JSON.stringify(out, big, 2) + "\n");
  log(`${ok ? "PASS" : "FAIL"} ${SCENARIO}${SCENARIO === "tag3-fail" ? ` (${AFTER})` : ""}: ${why}`);
  seed64.fill(0);
  fKey.fill(0);
  process.exit(ok ? 0 : 1);
};

/** Waits until F holds `need` lamports on both RPCs, after printing what to fund. */
const fundF = async (need) => {
  if (COPY) return void log(`F ${F} funded by the copy's airdrop: ${await copyAirdrop(rpcs[0], F, need)}`);
  log(`F ${F} (its key kept${keptF ? ` at ${keptF}` : ` at ${join(DIR, `run-${STAMP}.funder`)}`}); fund F with at least ${need} lamports on devnet`);
  for (let b = await balanceOf(F); b < need; b = await balanceOf(F)) {
    log(`F holds ${b}: waiting for at least ${need}`);
    await sleep(10_000);
  }
};
/** An account on both RPCs at confirmed: true where it exists. */
const exists = (a) => both(async (r) => (await r("getAccountInfo", [a, { encoding: "base64", commitment: "confirmed" }]))?.value != null);
const ataCreate = (owner, mint, tp) => ({ program: SOLANA_ATA_PROGRAM, accounts: [{ key: F, signer: true, writable: true }, { key: solanaAta(owner, mint, tp), signer: false, writable: true }, { key: owner, signer: false, writable: false }, { key: mint, signer: false, writable: false }, { key: SYSTEM, signer: false, writable: false }, { key: tp, signer: false, writable: false }], data: new Uint8Array([1]) });

// ---------- found: a fresh device from the words alone ----------
if (SCENARIO === "found") {
  const restore = poolRestore({ store: async () => store, seed64: async () => seed64.slice(), signedIn: async () => true, ended: () => {} });
  out.restore = await restore.auto();
  log(`the restore ended ${out.restore}`);
  // F's plant on W, right after the restore
  if (PLANT !== "none") {
    const ataRent = solanaRentMin(rent, 170);
    await fundF(PLANT === "pay" ? 1_000_000n + 2n * FEE + solanaRentMin(rent, 0) : PLANT === "empty" ? ataRent + 2n * FEE + solanaRentMin(rent, 0) : FRONT + 3n * ataRent + 4n * FEE + solanaRentMin(rent, 0));
    if (PLANT === "pay") out.plant = { sig: await pay(FOUND_W, 1_000_000n) };
    if (PLANT === "empty") {
      const account = solanaAta(FOUND_W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM);
      out.plant = { account, sig: await fSend(`creates W an empty wSOL token account ${account}`, [ataCreate(FOUND_W, SOLANA_SOL_MINT, SOLANA_TOKEN_PROGRAM)]) };
    }
    if (PLANT === "token") {
      const tp = VENUE.tokenProgram;
      const buy = await fSend(`buys ${FRONT} lamports of ${MINT}`, solanaPoolBuySteps(VENUE, F, FRONT, 1n));
      const from = solanaAta(F, MINT, tp);
      const decimals = (await again(() => rpcs[0]("getTokenAccountBalance", [from, { commitment: "confirmed" }]))).value.decimals;
      const data = new Uint8Array(10);
      data[0] = 12; // TransferChecked
      new DataView(data.buffer).setBigUint64(1, 1n, true);
      data[9] = decimals;
      const to = solanaAta(FOUND_W, MINT, tp);
      const sig = await fSend(`gives W 1 unit of ${MINT}`, [ataCreate(FOUND_W, MINT, tp), { program: tp, accounts: [{ key: from, signer: false, writable: true }, { key: MINT, signer: false, writable: false }, { key: to, signer: false, writable: true }, { key: F, signer: true, writable: false }], data }]);
      out.plant = { account: to, buy, sig };
    }
  }
  out.loads = [];
  const t0 = Date.now();
  let prev = null;
  for (let i = 0; Date.now() - t0 < SWEEP_WAIT_MS; i++) {
    prev?.cut();
    const p = page(`load${i}`, await openWalletStore({ indexedDB: idb }));
    const from = told.length;
    await p.t.stateRead();
    await sleep(LOAD_MS);
    const load = { at: new Date().toISOString(), told: told.slice(from).map((x) => x.line), holds: await wHolds(FOUND_W), clock: await wClock(FOUND_W) };
    out.loads.push(load);
    log(`load ${i}: W ${JSON.stringify(load.holds)}; latest ${load.clock.latest[0]} at height ${JSON.stringify(load.clock.height)}, finalized ${load.clock.finalized.join("/")} (past + 151: ${load.clock.past})`);
    prev = p;
    const swept = load.holds.lamports.every((l) => l === "0");
    const heldPast = out.loads.filter((x) => x.clock.past && x.holds.lamports.every((l) => l !== "0")).length;
    if (EXPECT === "held" && (swept || heldPast >= 2)) finish(!swept, swept ? `W swept, expected held (${PLANT})` : `W held ${heldPast} loads past + 151 (${PLANT}): ${JSON.stringify(load.holds)}; the rent back's lines ${JSON.stringify(load.told)}`);
    if (EXPECT === "swept" && swept) {
      const early = out.loads.filter((x) => !x.clock.past && x.holds.lamports.every((l) => l !== "0"));
      const sweptEarly = out.loads.some((x) => !x.clock.past && x.holds.lamports.every((l) => l === "0"));
      const notes = (await p.notesOf()).filter((n) => n.scope === scope).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
      out.notes = notes;
      // pay: a held load read the plant as W's latest; empty: the planted account is gone on both RPCs
      const fromPlant = PLANT !== "pay" || out.loads.some((x) => x.clock.latest[0] === out.plant.sig && !x.clock.past);
      const closed = PLANT !== "empty" || (await exists(out.plant.account)).every((e) => !e);
      finish(!sweptEarly && early.length > 0 && fromPlant && closed, `W swept after ${i + 1} load(s); ${early.length} load(s) held while + 151 was not past${PLANT === "pay" ? `; the clock ran from the plant ${out.plant.sig}: ${fromPlant}` : ""}${PLANT === "empty" ? `; the planted ${out.plant.account} closed on both RPCs: ${closed}` : ""}; the notes ${JSON.stringify(notes)}`);
    }
  }
  finish(false, `W ${EXPECT === "held" ? "not read past + 151 twice" : "not swept"} within ${SWEEP_WAIT_MS / 60_000} min`);
}

// ---------- F, then the deposits ----------
await fundF(F_NEEDS);
let front = null;
const A = page("A", store, {
  onPieces: async () => {
    if (SCENARIO !== "tag3-fail" || front) return;
    // the front-run: F's own buy of the coin on its curve, landed before the helper sends the pieces
    front = await fSend(`buys ${FRONT} lamports of ${MINT} on its curve`, solanaPoolBuySteps(VENUE, F, FRONT, 1n));
  },
  piecesAnswered: async (r) => {
    if (SCENARIO === "landed-reload") {
      out.piecesAnswer = { status: r.status, body: (await r.text()).slice(0, 2000) };
      A.cut();
      return;
    }
    if (SCENARIO !== "tag3-fail") return;
    out.piecesAnswer = { status: r.status, body: (await r.text()).slice(0, 2000) };
    if (AFTER === "reload") A.cut();
    if (AFTER === "stop") {
      out.W = (Object.values((await store.get("meta", "owed/pieces-sol")) ?? {})[0] ?? {}).address ?? null;
      finish(out.W !== null, `stopped at the helper's answer to the pieces (HTTP ${r.status}); W ${out.W} holds ${JSON.stringify(out.W ? await wHolds(out.W) : null)}; run: FLOW_RESUME=${SEED_AT} FLOW_W=${out.W} node packages/signpage/scripts/pool-buy-pieces-devnet.mjs found ${TABLE} ${MINT} <out.json>`);
    }
  },
});
const ns = await openNoteStore(store);
out.deposits = [];
for (let i = 0; i < N; i++) {
  const planned = await ns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
  const id = depositId(seed64, scope, planned.ref.i);
  const U = base58.encode(id.publicKey);
  id.secretKey.fill(0);
  if ((await balanceOf(U)) !== 0n) throw new Error(`U ${U} is not empty`);
  phase = `deposit-${i}`;
  await pay(U, NEED);
  const d = await once(A, "pool.deposit", { chain: "solana", amount: "0.01" });
  out.deposits.push({ U, ...d });
}
const landed = (await A.notesOf()).filter((n) => n.scope === scope && (n.state === "UNSPENT" || n.state === "HELD") && n.leaf);
if (landed.length !== N) finish(false, `${landed.length} of ${N} deposits landed`);

/** The most k pieces of 0.01 SOL spend on the coin's venue (devnet: no tip; the copy: the mainnet tip), as a pool.buy amount. */
const maxOf = (k) => solanaPoolBuyMaxSpend(Array.from({ length: k }, () => ({ withdrawnValue: RUNG, relayFee })), VENUE, COPY ? SOLANA_POOL_JITO_TIP : 0n, rent);
/** The proof queue's passes until pool.buy.dry answers `k` pieces for `amount`; the ms it took. */
const readyFor = async (k, amount) => {
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) {
    await A.t.proofs();
    const a = await A.ask(amount);
    log(`pool.buy.dry ${amount}: ${JSON.stringify(a)}`);
    if (a?.result?.pieces === k) return Math.round(performance.now() - t0);
    await sleep(3_000);
  }
  throw new Error(`no set of ${k} pieces ready for ${amount}`);
};
if (relayFee === null) await A.t.proofs();
if (relayFee === null) finish(false, "the helper's relay fee was not read");

/** One buy of k pieces: its answer, its stages and times, its transactions read back, W and what W holds. */
const buyOf = async (k, slippage = 300, noEnd = false, at = maxOf(k)) => {
  const amount = solOf(at);
  const ready = await readyFor(k, amount);
  const spentBefore = (await A.notesOf()).filter((n) => n.state === "SPENT").length;
  const wsBefore = owedWs.length;
  // a page closed at the helper's answer never answers: the run goes on from the cut
  const b = await Promise.race([once(A, "pool.buy", { chain: "solana", token: MINT, amount, slippage_bps: slippage }, noEnd), A.cutP.then(() => ({ answer: null, times: { cut: true } }))]);
  const W = owedWs.length > wsBefore ? owedWs.at(-1) : null;
  const txs = (b.answer?.result?.txs ?? []).map((x) => x.hash);
  return { k, amount, readyMs: ready, ...b, end: stageName(lastStage(A, "pool.buy")) ?? b.answer?.result?.stage ?? null, spent: (await A.notesOf()).filter((n) => n.state === "SPENT").length - spentBefore, W, txs };
};

if (SCENARIO === "copy-part1") {
  // each buy of several pieces as the copy's helper carried it (copy-net.mjs, call "pieces"): its answered signatures
  const bundles = () => copy.engineCalls.filter((x) => x.call === "pieces");
  const landedAll = (rb) => Object.values(rb).every((x) => x.every((st) => st === "confirmed" || st === "finalized"));
  // the answer names the tag 3 alone; the helper carried the k pieces, the tag 3 last, every one landed (card
  // owners-solana-buy-lands: the tag 2s plain, then the tag 3 on its own; no tip transaction of the helper's)
  const okBuy = (b, k) => b.end === "filled" && b.spent === k && b.txs.length === 1 && b.bundle?.txs === k && b.bundle.signatures.length === k && b.bundle.signatures.at(-1) === b.txs[0] && landedAll(b.readBack) && Object.keys(b.readBack).length === k && b.holds?.units.every((u) => u !== "0");
  const filledMs = (b) => b.times.filled ?? b.times['"filled"'] ?? null;
  const lamportsOf = (x) => BigInt(x.split(".")[0]) * 1_000_000_000n + BigInt((x.split(".")[1] ?? "").padEnd(9, "0").slice(0, 9));
  /** pool.buy.dry's tap_max with no amount, once a set of `k` pieces pays it (the tap's Max prices the tip at the proofs'
   *  tip cap, solanaPoolBuyTip's note, so it sits under maxOf(k)); the ms it took. */
  const maxReady = async (k) => {
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) {
      await A.t.proofs();
      const tapMax = (await A.askMax())?.result?.tap_max ?? null;
      const at = tapMax ? await A.ask(tapMax) : null;
      log(`Max: tap_max ${tapMax}; at it ${JSON.stringify(at)}`);
      if (at?.result?.pieces === k) return { tapMax, ms: Math.round(performance.now() - t0) };
      await sleep(3_000);
    }
    throw new Error(`Max not ready at ${k} pieces`);
  };
  // 1. with all 6 notes ready: a buy only 5 pieces pay, past the 4 one tap carries; refused before anything is taken or sent.
  // Its amount: 0.001 SOL past what 4 pieces spend at no tip at all, so no set of 4 pays it at any tip, and 5 do.
  phase = "ask-5";
  const ready6 = await maxReady(4);
  const four = solanaPoolBuyMaxSpend(Array.from({ length: 4 }, () => ({ withdrawnValue: RUNG, relayFee })), VENUE, 0n, rent);
  const readyMs = ready6.ms;
  const five = four + 1_000_000n;
  // and under what 5 pieces would spend at the most a tap tips (SOL_TIP_CAP, 0.001 SOL): the kit prices 4 at most, so 5
  // add up what each adds past its relay fee, less 5/4 of what 4 cost past theirs at that tip
  const four1 = solanaPoolBuyMaxSpend(Array.from({ length: 4 }, () => ({ withdrawnValue: RUNG, relayFee })), VENUE, 1_000_000n, rent);
  const fiveMost = 5n * (RUNG - relayFee) - (5n * (4n * (RUNG - relayFee) - four1) + 3n) / 4n;
  if (five >= fiveMost) finish(false, `the 5-piece ask ${solOf(five)} is not under what 5 pieces spend (${solOf(fiveMost)})`);
  const before = { sent: copy.sent.length, calls: copy.engineCalls.length, lines: copy.sendLines.length, reserved: (await A.notesOf()).filter((n) => n.state === "RESERVED").length };
  const dry5 = await A.ask(solOf(five));
  const ask5 = await once(A, "pool.buy", { chain: "solana", token: MINT, amount: solOf(five), slippage_bps: 300 });
  const notes5 = (await A.notesOf()).filter((n) => n.scope === scope && n.ref.kind === "deposit");
  out.five = { amount: solOf(five), fourMost: solOf(four), fiveMost: solOf(fiveMost), tapMax: ready6.tapMax, readyMs, dry: dry5, answer: ask5.answer, sent: copy.sent.length - before.sent, engineCalls: copy.engineCalls.length - before.calls, helperLines: copy.sendLines.length - before.lines, reserved: notes5.filter((n) => n.state === "RESERVED").length - before.reserved, notes: notes5.map((n) => n.state) };
  log(`five: ${JSON.stringify(out.five, big)}`);
  const okFive = ask5.answer?.error !== undefined && !("result" in (ask5.answer ?? {})) && dry5?.result?.pieces === undefined && out.five.sent === 0 && out.five.engineCalls === 0 && out.five.helperLines === 0 && out.five.reserved === 0 && notes5.length === 6 && notes5.every((n) => n.state !== "SPENT");
  // 2. a buy one 0.01 SOL note cannot pay: 0.001 SOL past one piece's most
  phase = "buy-2";
  const two = await buyOf(2, 300, false, maxOf(1) + 1_000_000n);
  two.bundle = bundles().at(-1) ?? null;
  two.waitedS = {};
  two.readBack = await readBack(two.bundle?.signatures ?? [], two.waitedS);
  two.holds = two.W ? await wHolds(two.W) : null;
  out.two = two;
  // 3. Max: pool.buy.dry's tap_max with no amount, once the set of the 4 notes left is ready at it
  phase = "max";
  const { tapMax } = await maxReady(4);
  const max = await buyOf(4, 300, false, lamportsOf(tapMax));
  max.bundle = bundles().at(-1) ?? null;
  max.waitedS = {};
  max.readBack = await readBack(max.bundle?.signatures ?? [], max.waitedS);
  max.holds = max.W ? await wHolds(max.W) : null;
  out.max = { tapMax, ...max };
  // 4. the sell after it (card owners-solana-buy-lands): one pool.sell of all the Max buy's W holds of the coin, the
  // page's own sell, its return note back in the pool
  phase = "sell";
  const units = max.W ? (await both(async (r) => (await r("getTokenAccountsByOwner", [max.W, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed" }])).value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? null))[0] : null;
  const sold = units ? await once(A, "pool.sell", { chain: "solana", token: MINT, amount: units, slippage_bps: 300 }) : { answer: null, times: {} };
  sold.end = stageName(lastStage(A, "pool.sell")) ?? sold.answer?.result?.stage ?? sold.answer?.error ?? null;
  sold.holds = max.W ? await wHolds(max.W) : null;
  out.sell = { units, ...sold };
  const notes = (await A.notesOf()).filter((n) => n.scope === scope).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
  out.notes = notes;
  const allSpent = notes.filter((n) => n.ref === "deposit").length === 6 && notes.filter((n) => n.ref === "deposit").every((n) => n.state === "SPENT");
  const okSell = sold.answer?.result !== undefined && sold.holds?.units.every((u) => u === "0") && notes.some((n) => n.ref === "return");
  finish(okFive && okBuy(two, 2) && okBuy(max, 4) && allSpent && two.W !== max.W && okSell, `sell of ${units}: ${sold.end}, W holds ${JSON.stringify(sold.holds)}, a return note ${notes.some((n) => n.ref === "return")}; 5 pieces asked (${out.five.amount} SOL, 4 pieces' most ${out.five.fourMost}): ${JSON.stringify(ask5.answer)}, dry ${JSON.stringify(dry5)}, ${out.five.sent} sent, ${out.five.engineCalls} engine calls, ${out.five.helperLines} helper sends, ${out.five.reserved} notes taken; 2 pieces: ${two.end}, ${two.spent} spent, bundle of ${two.bundle?.txs}, W ${two.W} holds ${JSON.stringify(two.holds)}, tap to filled ${filledMs(two) ?? "-"} ms, read-back s ${JSON.stringify(Object.values(two.waitedS ?? {}))}; Max ${tapMax} SOL: ${max.end}, ${max.spent} spent, bundle of ${max.bundle?.txs}, W ${max.W} holds ${JSON.stringify(max.holds)}, tap to filled ${filledMs(max) ?? "-"} ms, read-back s ${JSON.stringify(Object.values(max.waitedS ?? {}))}; every deposit note spent: ${allSpent}`);
}

if (SCENARIO === "copy-legs") {
  // card buy-any-amount-on-every-chain: with the 6 notes of 0.01 SOL ready, a buy only 5 pieces pay, past the 4 one W's
  // tap carries (SOLANA_POOL_BUY_PIECES_MAX): the page's legs (src/pool-buy.ts solanaLegsPlan), each its own W and
  // pieces, all in the one tap, filled; every leg's transactions read back on both RPCs and every leg's W holding the coin
  const bundles = () => copy.engineCalls.filter((x) => x.call === "pieces");
  const landedAll = (rb) => Object.values(rb).every((x) => x.every((st) => st === "confirmed" || st === "finalized"));
  // 0.001 SOL past what 4 pieces spend at no tip at all, as copy-part1's ask of 5
  const four = solanaPoolBuyMaxSpend(Array.from({ length: 4 }, () => ({ withdrawnValue: RUNG, relayFee })), VENUE, 0n, rent);
  const amount = solOf(four + 1_000_000n);
  phase = "legs-ready";
  // ready once pool.buy.dry prices it as legs: a cost and no one set's pieces (src/pools.ts poolBuyDryKind)
  const t0 = performance.now();
  let dry = null;
  for (let i = 0; i < 40 && !(dry?.result?.cost !== undefined && dry.result.pieces === undefined); i++) {
    if (i > 0) await sleep(3_000);
    await A.t.proofs();
    dry = await A.ask(amount);
    log(`pool.buy.dry ${amount}: ${JSON.stringify(dry)}`);
  }
  const readyMs = Math.round(performance.now() - t0);
  phase = "legs";
  const before = { calls: bundles().length, ws: owedWs.length, spent: (await A.notesOf()).filter((n) => n.state === "SPENT").length };
  const b = await once(A, "pool.buy", { chain: "solana", token: MINT, amount, slippage_bps: 300 });
  const end = stageName(lastStage(A, "pool.buy")) ?? b.answer?.result?.stage ?? b.answer?.error ?? null;
  const legs = bundles().slice(before.calls);
  const ws = owedWs.slice(before.ws);
  const waitedS = {};
  const rb = await readBack(legs.flatMap((x) => x.signatures), waitedS);
  const holds = await Promise.all(ws.map((w) => wHolds(w)));
  const spent = (await A.notesOf()).filter((n) => n.state === "SPENT").length - before.spent;
  const filledMs = b.times.filled ?? b.times['"filled"'] ?? null;
  out.legs = { amount, readyMs, dry, answer: b.answer, times: b.times, end, legs: legs.map((x) => ({ txs: x.txs, signatures: x.signatures })), ws, holds, spent, readBack: rb, waitedS };
  const ok = end === "filled" && legs.length >= 2 && ws.length >= 2 && new Set(ws).size === ws.length && Object.keys(rb).length > 0 && landedAll(rb) && holds.every((h) => h.units.every((u) => u !== "0")) && spent >= 5;
  finish(ok, `a buy of ${amount} SOL (4 pieces' most at no tip ${solOf(four)}): ${end}, ${legs.length} legs (${legs.map((x) => x.txs).join(" + ")} transactions), Ws ${JSON.stringify(ws)} hold ${JSON.stringify(holds)}, ${spent} notes spent, tap to filled ${filledMs ?? "-"} ms, ready ${readyMs} ms, read-back s ${JSON.stringify(Object.values(waitedS))}; dry ${JSON.stringify(dry)}`);
}

if (SCENARIO === "copy-takeable") {
  const E = Number(SOL_EPOCH_MS);
  const poolMs = async () => Number(await solanaNow(rpcs));
  const lastDeposit = Date.now();
  const lamportsOf = (x) => BigInt(x.split(".")[0]) * 1_000_000_000n + BigInt((x.split(".")[1] ?? "").padEnd(9, "0").slice(0, 9));
  // the page's own pass loop (a state read's pass, one after another) and a sampler each second, on page `p`
  const timeline = [];
  const passes = [];
  const watch = (p) => {
    let on = true;
    const loop = (async () => {
      while (on && !p.dead) {
        const at = Date.now();
        const r = await p.t.proofs().catch((e) => ({ error: String(e?.message ?? e) }));
        passes.push({ page: p.name, phase, at, ms: Date.now() - at, made: r?.made?.length ?? 0, remade: r?.remade?.length ?? 0, failed: r?.failed?.map((x) => x.error.slice(0, 120)) ?? r?.error ?? null });
        await sleep(250);
      }
    })();
    const sample = (async () => {
      while (on && !p.dead) {
        const at = Date.now();
        const [pm, max, rw] = await Promise.all([poolMs().catch(() => null), p.askMax().catch(() => null), p.t.readyWith(async () => null).catch(() => null)]);
        const tapMax = max?.result?.tap_max ?? null;
        const at4 = tapMax ? await p.ask(tapMax).catch(() => null) : null;
        const proofs = (rw?.ready ?? []).filter((r) => r.wallet.chain === "sol").map((r) => ({ note: r.noteId.slice(0, 8), own: r.own === true, root: r.root, epoch: Number(r.epochStartMs) }));
        timeline.push({ page: p.name, phase, at, pool: pm, intoEpoch: pm === null ? null : pm % E, tapMax, pieces: at4?.result?.pieces ?? null, making: [...(rw?.making ?? [])].length, proofs });
        await sleep(Math.max(0, 1_000 - (Date.now() - at)));
      }
    })();
    return { stop: async () => ((on = false), await Promise.all([loop, sample])) };
  };
  /** The ms from `t0` until Max reads `k` pieces on `p` (the sampler's own reads). */
  const maxAt = async (p, k, t0, limitMs) => {
    for (;;) {
      const tapMax = (await p.askMax())?.result?.tap_max ?? null;
      const at = tapMax ? await p.ask(tapMax) : null;
      if (at?.result?.pieces === k) return { ms: Date.now() - t0, tapMax };
      if (Date.now() - t0 > limitMs) return { ms: null, tapMax };
      await sleep(500);
    }
  };
  // 1. after the deposits: Max at 4 pieces
  phase = "ready";
  let w = watch(A);
  out.ready = await maxAt(A, 4, lastDeposit, 10 * 60_000);
  log(`ready: Max at 4 pieces ${out.ready.ms} ms after the last deposit's end (${out.ready.tapMax})`);
  await w.stop();
  // 2. a fresh load of the same store: the old page's queue closed (as a closed tab's dead lock frees its HELD notes), the
  // new page's queue proves every note again
  phase = "load";
  await A.t.signedOut();
  A.cut();
  const L = page("L", await openWalletStore({ indexedDB: idb }));
  const loadAt = Date.now();
  w = watch(L);
  out.load = await maxAt(L, 4, loadAt, 10 * 60_000);
  log(`load: Max at 4 pieces ${out.load.ms} ms after the load (${out.load.tapMax})`);
  // 3. three times: a note landed this epoch, so a proof on the newest root is ready when the boundary comes; then Max
  // 16 to 40 s past it, while that proof's remake may run past its grace: it fills with takeable pieces or is not_funded
  const lns = await openNoteStore(L.w);
  out.boundaries = [];
  for (let round = 0; round < ROUNDS; round++) {
    phase = `fresh-${round}`;
    const planned = await lns.planDeposit(scope, (ref) => noteSecrets(seed64, ref).precommitment);
    const id = depositId(seed64, scope, planned.ref.i);
    const U = base58.encode(id.publicKey);
    id.secretKey.fill(0);
    await pay(U, NEED);
    const fresh = await once(L, "pool.deposit", { chain: "solana", amount: "0.01" });
    for (let i = 0; i < 120 && !(await L.t.readyWith(async () => null)).ready.some((r) => r.root === "newest"); i++) await sleep(500);
    const nowPool = await poolMs();
    const boundary = nowPool - (nowPool % E) + E;
    const newestReady = (await L.t.readyWith(async () => null)).ready.filter((r) => r.root === "newest").map((r) => ({ note: r.noteId.slice(0, 8), own: r.own === true, epoch: Number(r.epochStartMs) }));
    phase = `boundary-${round}`;
    while ((await poolMs()) < boundary + 16_000) await sleep(250);
    const tapMax = (await L.askMax())?.result?.tap_max ?? null;
    const tapPool = await poolMs();
    const at = tapMax ? await L.ask(tapMax) : null;
    const spentBefore = (await L.notesOf()).filter((n) => n.state === "SPENT").length;
    const calls = copy.engineCalls.length;
    const b = tapMax ? await once(L, "pool.buy", { chain: "solana", token: MINT, amount: solOf(lamportsOf(tapMax)), slippage_bps: 300 }) : { answer: null, times: {} };
    const end = stageName(lastStage(L, "pool.buy")) ?? b.answer?.result?.stage ?? b.answer?.error ?? null;
    const bundle = copy.engineCalls.slice(calls).filter((x) => x.call === "pieces").at(-1) ?? null;
    const spent = (await L.notesOf()).filter((n) => n.state === "SPENT").length - spentBefore;
    const r = { round, fresh: fresh.answer, boundary, newestReady, tapMax, intoEpoch: tapPool - boundary, pieces: at?.result?.pieces ?? null, answer: b.answer, end, times: b.times, spent, bundleTxs: bundle?.txs ?? null };
    r.ok = b.answer?.error !== "failed" && (b.answer?.error === "not_funded" ? spent === 0 && bundle === null : end === "filled" && spent === r.pieces && (r.pieces === 1 ? bundle === null : bundle?.txs === r.pieces));
    out.boundaries.push(r);
    log(`boundary ${round}: Max ${tapMax} (${r.pieces} pieces) ${r.intoEpoch} ms past the boundary, newest-root ready before it ${JSON.stringify(newestReady)}: ${end}, ${spent} spent, bundle ${r.bundleTxs}; ok ${r.ok}`);
  }
  await sleep(3_000);
  await w.stop();
  Object.assign(out, { timeline, passes, proveMs: { n: proveLog.length, p50: proveLog.map((x) => x.ms).sort((x, y) => x - y)[Math.floor(proveLog.length / 2)] ?? null, max: Math.max(0, ...proveLog.map((x) => x.ms)) } });
  // what was offered, not takeable: a sample past the boundary + 15 s that names a newest-root proof of the epoch before
  const offeredLate = timeline.filter((x) => x.intoEpoch !== null && x.intoEpoch >= 15_000 && x.proofs.some((r) => r.root === "newest" && r.epoch < x.pool - x.intoEpoch));
  out.offeredLate = offeredLate.length;
  const ok = out.ready.ms !== null && out.load.ms !== null && out.boundaries.length === ROUNDS && out.boundaries.every((x) => x.ok) && offeredLate.length === 0;
  finish(ok, `Max at 4 pieces ${out.ready.ms} ms after the deposits, ${out.load.ms} ms after a load; Max tapped 16 s past a boundary: ${out.boundaries.map((x) => `${x.end} (${x.pieces} pieces, ${x.spent} spent, ${x.intoEpoch} ms in, ${x.newestReady.length} newest-root ready before)`).join("; ")}; samples offering a late proof: ${offeredLate.length}; proofs ${proveLog.length}, p50 ${out.proveMs.p50} ms, max ${out.proveMs.max} ms`);
}

if (SCENARIO.startsWith("pieces-")) {
  const b = await buyOf(N);
  b.readBack = await readBack(b.txs);
  b.holds = b.W ? await wHolds(b.W) : null;
  out.buy = b;
  // a second device: a fresh store on the same words, the page's restore, the spent notes' own Ws
  const w2 = await openWalletStore({ indexedDB: new IDBFactory() });
  await w2.insertSeed({ v: 1, entropy: Uint8Array.from(Buffer.from(readFileSync(SEED_AT, "utf8").trim(), "hex")), source: "code", code_saved: true, created_ms: Date.now() });
  out.restore = await poolRestore({ store: async () => w2, seed64: async () => seed64.slice(), signedIn: async () => true, ended: () => {} }).auto();
  const ws = (await (await openNoteStore(w2)).list()).filter((n) => n.state === "SPENT" && n.leaf).map((n) => {
    const fw = freshWallet(seed64, "sol", n.leaf.label, jOf(n.ref));
    fw.secretKey.fill(0);
    return fw.address;
  });
  out.restoredWs = ws;
  const ok = b.end === "filled" && b.spent === N && b.txs.length === N && Object.values(b.readBack).every((x) => x.every((s) => s === "finalized")) && b.holds?.units.every((u) => u !== "0") && ws.includes(b.W);
  finish(ok, `${N} pieces: ${b.end}; ${b.spent} notes spent; txs ${JSON.stringify(b.readBack)}; W ${b.W} holds ${JSON.stringify(b.holds)}; the restore (${out.restore}) finds W: ${ws.includes(b.W)}; tap to answer ${b.times.answer} ms, to filled ${b.times.filled ?? "-"} ms`);
}

if (SCENARIO === "back-to-back") {
  const one = await buyOf(2);
  const two = await buyOf(2);
  one.readBack = await readBack(one.txs);
  two.readBack = await readBack(two.txs);
  out.buys = [one, two];
  out.proofGapMs = two.readyMs;
  const ok = [one, two].every((b) => b.end === "filled" && b.spent === 2 && Object.values(b.readBack).every((x) => x.every((s) => s === "finalized"))) && one.W !== two.W;
  finish(ok, `two buys of 2 pieces: ${one.end}, ${two.end}; W ${one.W} then ${two.W}; the second set ready ${two.readyMs} ms after the first buy's end; taps to filled ${one.times.filled ?? "-"} and ${two.times.filled ?? "-"} ms`);
}

if (SCENARIO === "landed-reload") {
  const b = await buyOf(2, 300, true);
  out.buy = b;
  const W = b.W;
  if (!W) finish(false, "no owed record names W");
  const owedW = async () => Object.values((await store.get("meta", "owed/pieces-sol")) ?? {}).some((x) => x?.address === W);
  const before = await wHolds(W);
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < SWEEP_WAIT_MS; i++) {
    await sleep(LOAD_MS);
    const p = page(`reload${i}`, await openWalletStore({ indexedDB: idb }));
    const from = told.length;
    await p.t.stateRead();
    const still = await owedW();
    const h = await wHolds(W);
    log(`reload ${i}: owed record for W: ${still}; W ${JSON.stringify(h)}; the rent back's lines ${JSON.stringify(told.slice(from).map((x) => x.line))}`);
    p.cut();
    if (!still) {
      out.holds = h;
      const notes = (await p.notesOf()).filter((n) => n.scope === scope).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state }));
      out.notes = notes;
      const swept = told.some((x) => x.line.includes(W));
      const ok = h.units.every((u) => u !== "0") && h.lamports.every((l) => l !== "0") && !swept && notes.filter((n) => n.state === "SPENT").length >= N;
      finish(ok, `the owed record dropped after ${i + 1} reload(s); W ${JSON.stringify(h)} (at the cut ${JSON.stringify(before)}); a rent back line for W: ${swept}; the notes ${JSON.stringify(notes)}`);
    }
  }
  finish(false, `the owed record for W still kept after ${SWEEP_WAIT_MS / 60_000} min`);
}

if (SCENARIO === "tag3-fail") {
  // the copy prices the tag 3's tip at mainnet's, so the tap's Max sits under maxOf(2) there: a buy one piece cannot pay,
  // as copy-part1's buy of 2 pieces
  phase = "tag3-fail";
  const b = await buyOf(2, 1, AFTER !== "stay", COPY ? maxOf(1) + 1_000_000n : maxOf(2));
  out.buy = b;
  out.front = front;
  const W = b.W;
  if (!W) finish(false, "no owed record names W");
  // the state read an open page makes after the buy changed its store: in production the page's watchers push one
  // (src/api.ts host.watch, a read per batch of changes; the kit's client.ts REASK_STATE asks only on a pool.buy timeout);
  // this script has no watcher, so it reads once here, as that push does
  if (AFTER === "stay") await A.t.stateRead();
  const t0 = Date.now();
  let p = A;
  for (let i = 0; Date.now() - t0 < SWEEP_WAIT_MS; i++) {
    const h = await wHolds(W);
    log(`W ${W}: ${JSON.stringify(h)}`);
    if (h.lamports.every((l) => l === "0")) {
      out.holds = h;
      out.readBack = await readBack(sent);
      const notes = (await p.notesOf()).filter((n) => n.scope === scope).map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf ? String(n.leaf.value) : null }));
      out.notes = notes;
      const tag3 = b.txs[0] ?? null;
      finish(Boolean(front) && b.end !== "filled" && h.units.every((u) => u === "0"), `the tag 3 ${tag3} ${JSON.stringify(out.readBack[tag3] ?? null)}, the buy ${b.end}; W swept to 0 in ${Math.round((Date.now() - t0) / 1000)} s (${AFTER}); the notes ${JSON.stringify(notes)}`);
    }
    if (AFTER === "reload") {
      p = page(`reload${i}`, await openWalletStore({ indexedDB: idb }));
      await p.t.stateRead();
    }
    await sleep(LOAD_MS);
  }
  finish(false, `W not swept within ${SWEEP_WAIT_MS / 60_000} min`);
}
