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

globalThis.__SIGN_NETWORK__ = "testnet";
const { entropyToWords, wordsToSeed64, depositId } = await import("../../wallet/src/derive/index.ts");
const { freshWallet } = await import("../../wallet/src/derive/keys.ts");
const { openWalletStore } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { jOf } = await import("../../wallet/src/pool/queue.ts");
const { SOL_POOLS, SOL_POOL_TABLES, solanaPoolOf } = await import("../../wallet/src/pool/solana.ts");
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
if (POOL_TESTNET !== true || SOL_POOLS.devnet === undefined) throw new Error("not the testnet build's pins");

const SCENARIOS = { "pieces-2": 2, "pieces-3": 3, "pieces-4": 4, "back-to-back": 4, "landed-reload": 2, "tag3-fail": 2, found: 0 };
const [SCENARIO, TABLE, MINT, OUT] = process.argv.slice(2);
if (!OUT || !Object.hasOwn(SCENARIOS, SCENARIO)) throw new Error(`usage: pool-buy-pieces-devnet.mjs <${Object.keys(SCENARIOS).join("|")}> <table> <mint> <out.json>`);
// the page loads the tables the testnet build pins (PAGE_TABLES); <table> names the pump-curve one the run expects
if (!(SOL_POOL_TABLES.devnet?.["pump-curve"] ?? []).includes(TABLE)) throw new Error(`<table> is not a pump-curve table the testnet build pins: ${JSON.stringify(SOL_POOL_TABLES.devnet?.["pump-curve"] ?? [])}`);
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
const HELPER = process.env.FLOW_HELPER;
if (!/^https?:\/\/[^/]+$/.test(HELPER ?? "")) throw new Error("FLOW_HELPER=<the helper's origin: https://ct-api.unrealized.trade, or a local helper's http://127.0.0.1:<port>>");
// every call to the page's helper address goes to FLOW_HELPER (solanaJsonRpc and the pool's helper calls read the global
// fetch at each call)
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => {
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

// paced as the page's pair is (pool-testnet.ts pageSolanaRpcs)
const rpcs = TESTNET_RPCS.solana.slice(0, 2).map((u) => solanaPacedRpc(testnetRpc(u)));
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
    return { proof, publicSignals, proveMs: Math.round(performance.now() - t0) };
  },
};

// the run's seed and F's key, kept before anything can move
const DIR = process.env.FLOW_DIR ?? join(homedir(), ".ct-devnet-runs");
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
const { scope } = solanaPoolOf(SOL_POOLS.devnet.program);

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
const store = await openWalletStore({ indexedDB: idb });
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
  const t = testnetPool(host, { rpcs: prs, prover: { vault, stop: () => {} }, fetch: helperFetch });
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
  return { name, w, t, kinds, ask, notesOf, cutP, cut: () => void ((dead = true), onCut()), get dead() { return dead; } };
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

/** Each signature read on both RPCs at finalized: its error, or "missing". */
const readBack = async (sigs) => {
  const out = {};
  for (const s of sigs) {
    const st = await both(async (r) => (await r("getSignatureStatuses", [[s], { searchTransactionHistory: true }])).value[0]);
    out[s] = st.map((x) => (x === null ? "missing" : x.err === null ? x.confirmationStatus : `err ${JSON.stringify(x.err)}`));
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
const out = { at: new Date().toISOString(), scenario: SCENARIO, after: AFTER, plant: PLANT, expect: EXPECT, cluster: "devnet", program: SOL_POOLS.devnet.program, table: TABLE, mint: MINT, seed: SEED_AT, F, helper: { base: HELPER, commit: helperCommit } };
const finish = (ok, why) => {
  out.ok = ok;
  out.why = why;
  out.stages = stages;
  out.sent = sent;
  out.told = told;
  writeFileSync(OUT, JSON.stringify(out, big, 2) + "\n");
  log(`${ok ? "PASS" : "FAIL"} ${SCENARIO}${SCENARIO === "tag3-fail" ? ` (${AFTER})` : ""}: ${why}`);
  seed64.fill(0);
  fKey.fill(0);
  process.exit(ok ? 0 : 1);
};

/** Waits until F holds `need` lamports on both RPCs, after printing what to fund. */
const fundF = async (need) => {
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
  await pay(U, NEED);
  const d = await once(A, "pool.deposit", { chain: "solana", amount: "0.01" });
  out.deposits.push({ U, ...d });
}
const landed = (await A.notesOf()).filter((n) => n.scope === scope && (n.state === "UNSPENT" || n.state === "HELD") && n.leaf);
if (landed.length !== N) finish(false, `${landed.length} of ${N} deposits landed`);

/** The most k pieces of 0.01 SOL spend on the coin's venue (devnet: no tip), as a pool.buy amount. */
const maxOf = (k) => solanaPoolBuyMaxSpend(Array.from({ length: k }, () => ({ withdrawnValue: RUNG, relayFee })), VENUE, 0n, rent);
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
const buyOf = async (k, slippage = 300, noEnd = false) => {
  const amount = solOf(maxOf(k));
  const ready = await readyFor(k, amount);
  const spentBefore = (await A.notesOf()).filter((n) => n.state === "SPENT").length;
  // a page closed at the helper's answer never answers: the run goes on from the cut
  const b = await Promise.race([once(A, "pool.buy", { chain: "solana", token: MINT, amount, slippage_bps: slippage }, noEnd), A.cutP.then(() => ({ answer: null, times: { cut: true } }))]);
  const W = (Object.values((await store.get("meta", "owed/pieces-sol")) ?? {}).at(-1) ?? {}).address ?? null;
  const txs = (b.answer?.result?.txs ?? []).map((x) => x.hash);
  return { k, amount, readyMs: ready, ...b, end: stageName(lastStage(A, "pool.buy")) ?? b.answer?.result?.stage ?? null, spent: (await A.notesOf()).filter((n) => n.state === "SPENT").length - spentBefore, W, txs };
};

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
  const b = await buyOf(2, 1, AFTER !== "stay");
  out.buy = b;
  out.front = front;
  const W = b.W;
  if (!W) finish(false, "no owed record names W");
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
