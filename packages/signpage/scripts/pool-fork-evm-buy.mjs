// The signing page's own pool.buy on a local fork of Base or Robinhood mainnet (card evm-money-shows-and-spends-at-once):
// it spends the note pool-fork-evm.mjs left in the pinned mainnet pool seconds before, sent through the helper's own
// route and EVM sender run in this process, with nothing signed or sent on any real chain:
//   node contracts/pool-evm/test/fork-rpc.mjs --book pools -- sh packages/signpage/scripts/pool-fork-evm.sh <base|robinhood> <S> <lag> <fork.json> \
//     packages/signpage/scripts/pool-fork-evm-buy.mjs <base|robinhood> http://127.0.0.1:<port> <out.json> <token>
// (a long run: start it where a 30-minute job may run). The mainnet build: __SIGN_NETWORK__ is not set, so the pins and lists are
// SIGN_HOST's (the wallet's EVM_POOLS, src/pool-testnet.ts MAINNET_POOL_RPCS and MAINNET_EVM_FEE_RPCS).
// - Every request is answered on this machine: the chain's hosts the page and the kit name (the pool list, the fee
//   list, the history list, every URL in the kit's venue entry for the chain) by the fork's anvil, each URL kept so a
//   pair stays two providers; the helper's origin (src/trade.ts TRADE_HELPER) by the helper's own handler
//   (apps/helper/src/server.ts handler) on a local port, its EVM pool sender the helper's evmPoolSender
//   (apps/helper/src/pool/evm.ts) on the fork with the published test key sha256("helper-pool-senders/test-key/EVM_SENDER")
//   (funded on the fork only, anvil_setBalance) and its /v1/rpc route the helper's createRpc with the fork as its keyed
//   provider. A request to any other host throws: nothing reaches a real chain or the real helper.
// - This run mines one block itself, past the epoch start after the note's block (each block anvil mines costs one
//   recorded upstream read), and the buy's own (anvil's automine at its send). The chain's time is the head pool-fork-evm.mjs left, seconds old, which
//   the epoch, the proof's deadline and the quotes' head checks read; the run prints its age.
// - The seed is the published all-zero test vector (packages/wallet/test/vectors/a8.json); the note comes back from the
//   seed alone on a fresh profile (the wallet's evmRestoreNotes, notes only), each note above the round's finalized
//   block with its landing, as pool-buy-evm-testnet.mjs writes them.
// - What differs from the page in a browser, and only that: the prover is snarkjs's fullProve in this process on the
//   kit's pinned withdraw files, and the wallet store is fake-indexeddb in memory.
// Steps, each printed as `<iso time> +<s> <step>: <json>`: the restore, the proof queue's proof (the state read, then
// readyWith), the tap of pool.buy into <token> at 300 bps up to its end stage, the receipt read on anvil. It writes the
// times, the end, the transaction, its block and status, the notes after and the helper calls to <out.json>, and exits 0
// only on filled with status 0x1. Nothing here logs a key or the words.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";

const USAGE = "usage: pool-fork-evm-buy.mjs <base|robinhood> http://127.0.0.1:<port> <out.json> <token 0x...40 hex>";
const [CHAIN, ANVIL, OUT, TOKEN] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ANVIL ?? "") || !OUT || !/^0x[0-9a-f]{40}$/.test(TOKEN ?? "")) {
  console.error(USAGE);
  process.exit(2);
}
const t0 = Date.now();
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const log = (step, o) => console.log(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${step}: ${JSON.stringify(o ?? {}, big)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// installed before any module loads, so every provider made at load or later fetches through it; until the lists below
// are read, only the fork itself is reached
const realFetch = globalThis.fetch;
const route = { fork: new Set(), helper: null, local: null };
const refused = new Map();
const requests = [];
let tapped = false;
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const to = u.origin === ANVIL || (route.local !== null && u.origin === route.local) ? "direct" : route.fork.has(u.host) ? "fork" : route.helper !== null && u.origin === route.helper ? "helper" : null;
  if (tapped) {
    let method = null;
    try {
      method = [JSON.parse(String(init?.body ?? "null"))].flat().map((x) => x?.method).filter(Boolean).join(",") || null;
    } catch {}
    requests.push({ atMs: Date.now(), host: u.host, path: u.pathname, verb: init?.method ?? "GET", method, to: to ?? "refused" });
  }
  if (to === "direct") return realFetch(input, init);
  if (to === "fork") return realFetch(ANVIL, init);
  if (to === "helper") return realFetch(`${route.local}${u.pathname}${u.search}`, init);
  if (!refused.has(u.host)) log("refused host", { host: u.host, path: u.pathname });
  refused.set(u.host, (refused.get(u.host) ?? 0) + 1);
  throw new Error(`pool-fork-evm-buy: no request past the fork (${u.host})`);
};

const { entropyToWords, wordsToSeed64 } = await import("../../wallet/src/derive/index.ts");
const { openWalletStore, WALLET_SEED_LOCK } = await import("../../wallet/src/store/index.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { EVM_EPOCH_MS, EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS, pageEvmPoolRpcs, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { EVM_OWED_BACK_KEY, EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { TRADE_HELPER } = await import("../src/trade.ts");
const { handler } = await import("../../../apps/helper/src/server.ts");
const { evmPoolSender } = await import("../../../apps/helper/src/pool/evm.ts");
const { createRpc } = await import("../../../apps/helper/src/rpc/rpc.ts");

if (POOL_TESTNET) throw new Error("this is the mainnet build's run: __SIGN_NETWORK__ must not be set");
const PIN = EVM_POOLS[CHAIN];
if (!PIN) throw new Error(`the mainnet build pins no ${CHAIN} pool`);

// the chain's hosts, as the page and the kit name them; a host the other chain also names is refused, never guessed
const urlsIn = (v, out = []) => {
  if (typeof v === "string" && /^https:\/\//.test(v)) out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) urlsIn(x, out);
  return out;
};
const hostsOf = (c) => new Set([...MAINNET_POOL_RPCS[c], ...MAINNET_EVM_FEE_RPCS[c], ...MAINNET_POOL_HISTORY[c], ...urlsIn(evmPoolVenues()[c])].map((u) => new URL(u).host));
const other = hostsOf(CHAIN === "base" ? "robinhood" : "base");
for (const h of hostsOf(CHAIN)) if (!other.has(h)) route.fork.add(h);

let id = 0;
const anvil = async (method, params) => {
  const j = await (await realFetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (j.error) throw new Error(`RPC error ${j.error.code}: ${String(j.error.message).slice(0, 200)}`); // the kit client's wording
  return j.result;
};

// the fork as pool-fork-evm.mjs left it (no block mined here)
const head = await anvil("eth_getBlockByNumber", ["latest", false]);
const fin = await anvil("eth_getBlockByNumber", ["finalized", false]);
const firstHead = BigInt(head.number);
log("fork", { chain: CHAIN, chainId: Number(await anvil("eth_chainId", [])), pool: PIN.pool, head: firstHead, headAgeS: Math.round(Date.now() / 1000 - Number(BigInt(head.timestamp))), finalized: BigInt(fin.number), forkHosts: [...route.fork], helper: TRADE_HELPER });

// the helper in this process: its own handler, its EVM pool sender on the fork with the published test key
const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const sideRpc = (method, params) => anvil(method, params);
const sender = evmPoolSender({ network: CHAIN, pool: PIN.pool, senderKey: KEY, feeRecipient: PIN.feeRecipient, log: (line) => log("helper sender", { line }) }, [sideRpc, (m, p) => sideRpc(m, p)]);
KEY.fill(0);
await anvil("anvil_setBalance", [sender.sender, "0xde0b6b3a7640000"]);
const rpcRoute = createRpc({ [CHAIN === "base" ? "BASE_RPC_URL" : "ROBINHOOD_RPC_URL"]: ANVIL }, { log: (line) => log("helper rpc", { line }) });
const helperLines = [];
const serve = handler(
  "0".repeat(40), // its commit header
  {}, // proxy: no route of it is asked here
  rpcRoute,
  {}, // token watches
  {}, // Solana lists
  {}, // withdraw fee
  {}, // withdraw sender
  {}, // Solana token
  {}, // bind sender
  null,
  new Map(), // no Solana pool sender
  new Map([[sender.pool, sender]]),
  () => Date.now(),
  {},
  {},
  () => true,
  Promise.resolve(),
  () => ({}),
  { count: () => {} },
  {},
  undefined,
  (line) => (helperLines.push(line), log("helper", { line })),
);
const server = createServer(serve);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
route.local = `http://127.0.0.1:${server.address().port}`;
route.helper = new URL(TRADE_HELPER).origin;
log("helper", { local: route.local, sender: sender.sender, pool: sender.pool, feeRecipient: PIN.feeRecipient });

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
const proves = [];
const vault = {
  load: async () => {},
  prove: async (circuit, input) => {
    if (circuit !== "withdraw") throw new Error(`no ${circuit} prover here`);
    const s = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY, undefined, undefined, { singleThread: true });
    const ms = Math.round(performance.now() - s);
    proves.push(ms);
    log("proved", { ms });
    return { proof, publicSignals, proveMs: ms };
  },
};

// 1. a fresh profile: the note from the seed alone, as the page's restore reads it (notes only: no W is named)
const ENTROPY = new Uint8Array(16); // the all-zero test vector
const seed64 = wordsToSeed64(entropyToWords(ENTROPY));
const w = await openWalletStore({ indexedDB: new IDBFactory() });
await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: Date.now() });
const ns = await openNoteStore(w);
const restoreAt = Date.now();
const restored = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs: pageEvmPoolRpcs(CHAIN), wallets: false });
for (const n of restored.notes) await ns.add({ ref: n.ref, scope: n.scope, precommitment: n.precommitment, state: n.state, leaf: n.leaf, ...(n.landed === undefined || n.state !== "UNSPENT" ? {} : { landed: n.landed }) });
const restoreMs = Date.now() - restoreAt;
log("restore", { ms: restoreMs, block: restored.block, notes: restored.notes.map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf?.value, leaf: n.leaf?.leafIndex, landed: n.landed ?? null })) });
if (!restored.notes.some((n) => n.state === "UNSPENT")) throw new Error("no UNSPENT note to buy with");

// the helper's calls, as the page made them
const helperCalls = [];
const helperFetch = async (url, init) => {
  const s = Date.now();
  const r = await fetch(url, init);
  const text = (await r.clone().text()).slice(0, 400);
  const c = { atMs: s - t0, verb: init?.method ?? "GET", path: new URL(url).pathname, query: new URL(url).search, status: r.status, ms: Date.now() - s, body: text, retryAfter: r.headers.get("retry-after") };
  helperCalls.push(c);
  log("helper call", c);
  return r;
};
const page = { store: async () => w, held: async () => w, seed64: async () => seed64.slice() };
const t = testnetPool(page, { prover: { vault, stop: () => {} }, fetch: helperFetch });
const kinds = poolKinds(testnetPoolDeps(t.flow));

// 2. the proof queue's proof: the state read starts the chain's pass; its ready proof. The queue proves at an epoch's
// start (EVM_EPOCH_MS) on the tree of the leaves before it, once the newest block both RPCs agree on is past that start
// ("no leaf before" until then). Mainnet makes a block every 200 ms (Base) or 110 ms (Robinhood); this fork mines only
// on a send, so once the epoch after the note's block has begun, one block is mined (its one recorded read)
const EPOCH_MS = Number(EVM_EPOCH_MS);
const nextEpoch = (Math.floor((Number(BigInt(head.timestamp)) * 1000) / EPOCH_MS) + 1) * EPOCH_MS;
const epochWaitMs = Math.max(0, nextEpoch + 1_000 - Date.now());
await sleep(epochWaitMs);
await anvil("evm_mine", []);
log("epoch", { start: new Date(nextEpoch).toISOString(), waitedMs: epochWaitMs });
const proveAt = Date.now();
await t.stateRead();
let ready = [];
for (let i = 0; i < 120 && ready.length === 0; i++) {
  await sleep(2_000);
  ready = ((await t.readyWith(async () => null)).ready ?? []).filter((p) => p.wallet.chain === "evm");
  if (ready.length === 0 && i % 10 === 9) await t.stateRead();
}
const readyMs = Date.now() - proveAt;
const notesNow = async () => (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, value: n.leaf ? n.leaf.value : null }));
const record = { by: "packages/signpage/scripts/pool-fork-evm-buy.mjs", chain: CHAIN, pool: PIN.pool, token: TOKEN, anvil: ANVIL, sender: sender.sender, times: { restoreMs, proveMs: proves.at(-1) ?? null, readyMs, tapToAnswerMs: null, tapToEndMs: null }, end: null, refusal: null, tx: null, block: null, status: null, notesAfter: null, helperCalls, helperLines, requests: [], refusedHosts: {} };
const finish = async (code) => {
  record.notesAfter = await notesNow();
  record.refusedHosts = Object.fromEntries(refused);
  // the blocks mined during this run (the buy's own send's, at most): each one cost a recorded upstream read
  record.minedBlocks = BigInt(await anvil("eth_blockNumber", []).catch(() => "0x0")) - firstHead;
  writeFileSync(OUT, JSON.stringify(record, big, 2) + "\n");
  log("wrote", { out: OUT, end: record.end, status: record.status });
  await t.signedOut().catch(() => {});
  seed64.fill(0);
  server.close();
  ns.close();
  w.close();
  process.exit(code);
};
if (ready.length === 0) {
  record.end = "no_ready_proof";
  log("ready", { ms: readyMs, ready: 0, notes: await notesNow() });
  await finish(1);
}
const proof = ready[0];
log("ready", { ms: readyMs, proveMs: record.times.proveMs, note: proof.noteId, chunk: proof.chunk, fee: proof.binding.feeCap, root: proof.root, w: proof.wallet.address, epoch: proof.epochStartMs });

// 3. the tap: pool.buy of the ready chunk into the token, 300 bps
const units = (v, d) => {
  const s = v.toString().padStart(d + 1, "0");
  const f = s.slice(-d).replace(/0+$/, "");
  return f === "" ? s.slice(0, -d) : `${s.slice(0, -d)}.${f}`;
};
const amount = units(proof.chunk, 18);
const stages = [];
const ENDS = ["filled", "part_filled", "refused", "not_landed"];
tapped = true;
const tapAt = Date.now();
const r = kinds["pool.buy"]({ chain: CHAIN, token: TOKEN, amount, slippage_bps: 300 }, { id: "buy", sha: "00", progress: (s) => (stages.push(s), log("progress", { stage: s, ms: Date.now() - tapAt })) });
if ("error" in r) {
  // refused at the tap, before any run: the page's own answer (the mainnet build closes the EVM buy in src/pool-testnet.ts
  // evmBuy while POOL_TESTNET is false)
  record.times.tapToAnswerMs = Date.now() - tapAt;
  record.end = "refused_at_tap";
  record.refusal = r;
  log("tap", { amount, answer: r, ms: record.times.tapToAnswerMs });
  tapped = false;
  record.requests = requests.map((q) => ({ ...q, atMs: q.atMs - tapAt }));
  await finish(1);
}
await r.after;
const first = r.answer();
record.times.tapToAnswerMs = Date.now() - tapAt;
log("tap", { amount, answer: first, ms: record.times.tapToAnswerMs });
// the send part holds the seed's lock; the read-back runs past it and ends as progress (the tap's or a late one)
await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
for (let i = 0; i < 360 && !ENDS.includes(stages.at(-1)); i++) await sleep(1_000);
record.end = stages.at(-1) ?? null;
record.times.tapToEndMs = Date.now() - tapAt;
tapped = false;
record.requests = requests.map((q) => ({ ...q, atMs: q.atMs - tapAt }));
const holdings = await w.get("meta", EVM_POSITION_COSTS_KEY);
const owed = await w.get("meta", EVM_OWED_BACK_KEY);
log("end", { end: record.end, ms: record.times.tapToEndMs, stages, holding: holdings?.[proof.wallet.address] ?? null, owed: owed ?? null });

// 4. the receipt, read on the fork
const sent = helperCalls.filter((c) => c.path === "/v1/pool/evm/send" && c.status === 200).map((c) => /"hash":"(0x[0-9a-f]{64})"/.exec(c.body)?.[1]).filter(Boolean).at(-1);
const hash = holdings?.[proof.wallet.address]?.route?.tx ?? sent ?? null;
// read only once a block of this fork holds it: anvil sends a hash it does not know to the forked chain's provider
let rc = null;
for (let i = 0; hash && rc === null && i < 20; i++) {
  const top = BigInt(await anvil("eth_blockNumber", []));
  for (let n = top; rc === null && n > firstHead; n--) if ((await anvil("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])).transactions.includes(hash)) rc = await anvil("eth_getTransactionReceipt", [hash]);
  if (rc === null) await sleep(500);
}
record.tx = hash;
record.block = rc?.blockNumber ? BigInt(rc.blockNumber) : null;
record.status = rc?.status ?? null;
log("receipt", { tx: hash, block: record.block, status: record.status, gasUsed: rc?.gasUsed ? BigInt(rc.gasUsed) : null, logs: rc?.logs?.length ?? null });
await finish(record.end === "filled" && record.status === "0x1" ? 0 : 1);
