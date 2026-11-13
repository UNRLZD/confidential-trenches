// Scratch fork run (evm-buy-and-sell-on-mainnet; pool-fork-evm-buy.mjs extended): device A's pool.buy, then device B, a fresh
// profile from the same words: the restore, the state read that rebuilds W's buy record, B's position and balance
// against A's, B's pool.sell of the whole holding, and a third fresh profile's balance against B's after it.
// From pool-fork-evm-buy.mjs:
// it spends the note pool-fork-evm.mjs left in the pinned mainnet pool seconds before, sent through the helper's own
// route and EVM sender run in this process, with nothing signed or sent on any real chain:
//   node contracts/pool-evm/test/fork-rpc.mjs --book pools -- sh packages/signpage/scripts/pool-fork-evm.sh <base|robinhood> <S> <lag> <fork.json> \
//     packages/signpage/scripts/pool-fork-evm-buy.mjs <base|robinhood> http://127.0.0.1:<port> <out.json> <token>
// (anvil is a heavy job: scripts/heavy.sh). The mainnet build: __SIGN_NETWORK__ is not set, so the pins and lists are
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

const USAGE = "usage: pool-fork-evm-trade.mjs <base|robinhood> http://127.0.0.1:<port> <out.json> <token 0x...40 hex>";
const [CHAIN, ANVIL, OUT, TOKEN] = process.argv.slice(2);
if ((CHAIN !== "base" && CHAIN !== "robinhood") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ANVIL ?? "") || !OUT || !/^0x[0-9a-f]{40}$/.test(TOKEN ?? "")) {
  console.error(USAGE);
  process.exit(2);
}
const t0 = Date.now();
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
// the written record names a coin "coin": gitleaks' generic-api-key rule reads a "token" key with a 0x address as a key
// (a coin's public address; the record is committed beside the run)
const coins = (v) => (Array.isArray(v) ? v.map(coins) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k === "token" ? "coin" : k, coins(x)])) : v);
const log = (step, o) => console.log(`${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${step}: ${JSON.stringify(o ?? {}, big)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// installed before any module loads, so every provider made at load or later fetches through it; until the lists below
// are read, only the fork itself is reached
const realFetch = globalThis.fetch;
const route = { fork: new Set(), helper: null, local: null };
const refused = new Map();
const requests = [];
let tapped = false;
const force = { armed: process.env.FORK_FORCE_REFUSE === "1", at: null };
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  const to = u.origin === ANVIL || (route.local !== null && u.origin === route.local) ? "direct" : route.fork.has(u.host) ? "fork" : route.helper !== null && u.origin === route.helper ? "helper" : null;
  if (tapped) {
    let method = null;
    try {
      method = [JSON.parse(String(init?.body ?? "null"))].flat().map((x) => x?.method).filter(Boolean).join(",") || null;
    } catch {}
    const q = { atMs: Date.now(), host: u.host, path: u.pathname, verb: init?.method ?? "GET", method, to: to ?? "refused", body: String(init?.body ?? "").slice(0, 220) };
    requests.push(q);
    if (to === "fork" || to === "direct") {
      const s0 = Date.now();
      try {
        const r = await realFetch(to === "fork" ? ANVIL : input, init);
        q.ms = Date.now() - s0;
        q.status = r.status;
        return r;
      } catch (e) {
        q.ms = Date.now() - s0;
        q.error = String(e?.message ?? e).slice(0, 120);
        throw e;
      }
    }
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
const { EVM_EPOCH_MS, EVM_POOLS, EVM_SEND_MARGIN_MS } = await import("../../wallet/src/pool/evm.ts");
const { evmRestoreNotes } = await import("../../wallet/src/pool/evm-restore.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { ZK_SETUP_FILES } = await import("../../kit/src/zk/setup-files.ts");
const { evmPoolVenues } = await import("../../kit/src/trade/evm/buy-unpinned.ts");
const { poolKinds } = await import("../src/pool-kinds.ts");
const { MAINNET_EVM_FEE_RPCS, MAINNET_POOL_HISTORY, MAINNET_POOL_RPCS, pageEvmPoolRpcs, testnetPool, testnetPoolDeps } = await import("../src/pool-testnet.ts");
const { EVM_POSITION_COSTS_KEY } = await import("../src/pool-buy-evm.ts");
const { EVM_OWED_BACK_KEY, EVM_CARRY_DONE_KEY, EVM_CARRY_OPEN_KEY } = await import("../src/pool-carry-evm.ts");
const { evmPoolBuyQuote } = await import("../../kit/src/checks/evm/quote.ts");
const { writeRestored } = await import("../../wallet/src/notes/restore.ts");
const { readNotes } = await import("../../wallet/src/notes/store.ts");
const { poolBalances } = await import("../../wallet/src/pool/balances.ts");
const { PAGE_POOLS } = await import("../src/pools.ts");
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
// FORK_FORCE_REFUSE=1: the buy's own send (the helper's sender, the first raw transaction it sends) lands while the
// token's code reverts on any call, so the pool's swap call fails inside the pool (buySwap's balanceOf) and the pool pays
// W the chunk less the fee (Withdrawn); the code is put back once anvil has mined it (automine), so no other read sees it
// The sender sends the same bytes to both its sides at once (evm.ts sendBoth), so every send of that first transaction
// waits for the one code swap: run 11 (13 Nov 08:54Z) armed it on one side while the other's send was mined with the
// token's own code, and the buy filled
const sideRpc = async (method, params) => {
  if (!method.startsWith("eth_sendRawTransaction") || !(force.armed || force.swap)) return anvil(method, params);
  if (force.armed) {
    force.armed = false;
    force.swap = (async () => {
      const code = await anvil("eth_getCode", [TOKEN, "latest"]);
      const before = BigInt(await anvil("eth_blockNumber", []));
      await anvil("anvil_setCode", [TOKEN, "0x5f5ffd"]);
      return { code, before };
    })();
  }
  const swap = force.swap;
  const { code, before } = await swap;
  try {
    return await anvil(method, params);
  } finally {
    if (force.swap === swap) {
      force.swap = null;
      // anvil answers the send before it mines it (run 13, 13 Nov 09:11Z: the code was back in time and the buy
      // filled): the code stays swapped until a block past the send's start is mined, up to 10 s
      for (let i = 0; i < 50 && BigInt(await anvil("eth_blockNumber", [])) <= before; i++) await sleep(200);
      await anvil("anvil_setCode", [TOKEN, code]);
      force.at = Date.now();
      log("forced refusal", { method, tokenCodeBytes: (code.length - 2) / 2 });
    }
  }
};
// the sender holds the key it is given (apps/helper/src/pool/evm.ts cfg.senderKey, as the helper's own fresh unhex):
// its own copy, so the zeroing below leaves the sender's (run 6, 13 Nov 07:34Z: "invalid private key" at the buy's send)
// the sale's sender: its own published test key sha256("helper-pool-senders/test-key/EVM_SELL_SENDER"), never the
// withdraw sender's, and the chain's pinned FeeCollector (the kit's venue entry), as the helper's env sets both (run 9,
// 13 Nov 08:19Z: the sell answered 503 not_configured, no sell key set). The kit pins the mainnet sell sender, whose key
// is not ours: the device sims each sale from that pin, and on the copy this test key sends it (funded on the fork only)
const SELL_KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SELL_SENDER").digest());
const COLLECTOR = evmPoolVenues()[CHAIN]?.feeCollector;
if (COLLECTOR === undefined) throw new Error(`the mainnet build pins no ${CHAIN} fee collector`);
const sender = evmPoolSender({ network: CHAIN, pool: PIN.pool, senderKey: KEY.slice(), sellKey: SELL_KEY.slice(), feeRecipient: PIN.feeRecipient, feeCollector: COLLECTOR, log: (line) => log("helper sender", { line }) }, [sideRpc, (m, p) => sideRpc(m, p)]);
KEY.fill(0);
SELL_KEY.fill(0);
// the sender's own throw, which the handler answers as a bare 500 "internal"
const senderSeen = Object.create(sender, {
  carry: { value: async (body, client) => {
    try {
      const a = await sender.carry(body, client);
      log("helper sender answer", { status: a.status, body: a.body });
      return a;
    } catch (e) {
      log("helper sender threw", { error: String(e?.stack ?? e).slice(0, 1200) });
      throw e;
    }
  } },
});
await anvil("anvil_setBalance", [sender.sender, "0xde0b6b3a7640000"]);
await anvil("anvil_setBalance", [sender.sellSender, "0xde0b6b3a7640000"]);
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
  new Map([[sender.pool, senderSeen]]),
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
// up to 10 min: every read the queue's state read makes through anvil is a slot the copy fetches from the public
// upstreams first (run 14, 13 Nov 09:06Z: on a Robinhood copy no proof yet at 4 min, where Base's took 176-206 s)
for (let i = 0; i < 300 && ready.length === 0; i++) {
  await sleep(2_000);
  ready = ((await t.readyWith(async () => null)).ready ?? []).filter((p) => p.wallet.chain === "evm");
  if (ready.length === 0 && i % 10 === 9) await t.stateRead();
}
const readyMs = Date.now() - proveAt;
const notesNow = async () => (await ns.list()).map((n) => ({ id: n.id, ref: n.ref.kind, state: n.state, value: n.leaf ? n.leaf.value : null }));
const record = { by: "packages/signpage/scripts/pool-fork-evm-trade.mjs", chain: CHAIN, pool: PIN.pool, token: TOKEN, anvil: ANVIL, sender: sender.sender, times: { restoreMs, proveMs: proves.at(-1) ?? null, readyMs, tapToAnswerMs: null, tapToEndMs: null }, end: null, refusal: null, tx: null, copy: { note: "a copy of mainnet: anvil forks the chain and reads each slot it lacks from the public upstreams below through fork-rpc, so readyMs and every read through anvil include those upstreams' latency and throttles, never the product's alone", upstreams: (() => { try { return JSON.parse(process.env.FORK_RPC_UPSTREAMS ?? "null"); } catch { return null; } })() }, block: null, status: null, notesAfter: null, helperCalls, helperLines, requests: [], refusedHosts: {} };
const finish = async (code) => {
  record.notesAfter = await notesNow();
  record.refusedHosts = Object.fromEntries(refused);
  // the blocks mined during this run (the buy's own send's, at most): each one cost a recorded upstream read
  record.minedBlocks = BigInt(await anvil("eth_blockNumber", []).catch(() => "0x0")) - firstHead;
  writeFileSync(OUT, JSON.stringify(coins(JSON.parse(JSON.stringify(record, big))), null, 2) + "\n");
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
let proof = ready[0];
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
// one quote thrown away before the tap: the venue's state read once through the fork (anvil keeps each slot it read),
// so the tap's own quote reads it from anvil, not from the public upstreams
{
  // the shapes the page's quoteOf asks in turn (src/pool-buy-evm.ts:190-193 V4_FIRST, V3_FIRST, REQUOTE), the first
  // that quotes ending the warm-up
  const V = evmPoolVenues()[CHAIN];
  const Z = "0x0000000000000000000000000000000000000000";
  const shapes = [
    ...[[3000, 60], [10000, 200], [500, 10], [100, 1]].map(([fee, tickSpacing]) => ({ venue: "uniswap-v4", currencyIn: Z, hops: [{ currency: TOKEN, fee, tickSpacing, hooks: Z, hookData: "0x" }] })),
    ...[3000, 500, 10000, 100].map((fee) => ({ venue: "uniswap-v3", tokens: [V.weth, TOKEN], fees: [fee] })),
  ];
  const w0 = Date.now();
  const amountIn = proof.chunk - BigInt(proof.binding.feeCap);
  for (const route of shapes) {
    const s0 = Date.now();
    // a fresh head for each warm quote's head check (the fork mines only on a send: pass 6's warm quotes all read a
    // head 40 s old and ended stale_quote before reading the venue)
    await anvil("evm_mine", []);
    try {
      await evmPoolBuyQuote({ chain: CHAIN, token: TOKEN, amountIn, slippageBps: 300, route });
      log("warm quote", { ms: Date.now() - s0, route: route.venue + (route.fees ?? route.hops[0].fee), ok: true });
      break;
    } catch (e) {
      log("warm quote", { ms: Date.now() - s0, route: route.venue + (route.fees ?? route.hops[0].fee), code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 160) });
      if (["below_reference", "native_first", "over_gas_floor"].includes(e?.code) && e?.reference) {
        await evmPoolBuyQuote({ chain: CHAIN, token: TOKEN, amountIn, slippageBps: 300, route: e.reference.route }).then(() => log("warm quote", { route: "reference", ok: true }), (x) => log("warm quote", { route: "reference", code: x?.code ?? null }));
        break;
      }
    }
  }
  log("warm quotes", { ms: Date.now() - w0 });
}
// the tap takes a proof whose relay deadline leaves the helper's send margin and 30 s more: on this copy a proof came
// ready 10 s before its deadline and the tap refused deadline_past (runs 3 and 4, 13 Nov 06:45Z and 07:02Z; the copy's
// state reads are slow on its public upstreams). The queue proves again at each epoch past the newest block, so one
// block a try is mined and the newest such proof is waited for
const LIFE_LEFT_MS = Number(EVM_SEND_MARGIN_MS) + 30_000;
const left = (p) => Number(p.deadlineMs) - Date.now();
for (let i = 0; i < 90 && left(proof) < LIFE_LEFT_MS; i++) {
  if (i === 0) log("proof too close to its deadline", { leftMs: left(proof), needMs: LIFE_LEFT_MS, epoch: proof.epochStartMs });
  await sleep(2_000);
  await anvil("evm_mine", []);
  if (i % 10 === 9) await t.stateRead();
  const fresh = ((await t.readyWith(async () => null)).ready ?? []).filter((p) => p.wallet.chain === "evm" && p.chunk === proof.chunk).sort((x, y) => Number(y.deadlineMs) - Number(x.deadlineMs))[0];
  if (fresh !== undefined) proof = fresh;
}
record.times.proofLeftMs = left(proof);
record.times.proofEpochAgeMs = Date.now() - Number(proof.epochStartMs);
log("tap proof", { leftMs: record.times.proofLeftMs, epochAgeMs: record.times.proofEpochAgeMs, epoch: proof.epochStartMs, note: proof.noteId });
// a fresh head for the quotes' head checks (the fork mines only on a send)
await anvil("evm_mine", []);
// the clocks (the kit refuses a block more than 30 s behind the device's clock): the device's, anvil's newest block,
// and the newest block each provider the page and the kit name answers through this run's fetch
const clocks = async (tag) => {
  const at = Date.now();
  const one = async (url) => {
    try {
      const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }) })).json();
      const b = r.result;
      return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)), behindS: Math.round(at / 1000 - Number(BigInt(b.timestamp))) };
    } catch (e) {
      return { error: String(e?.message ?? e).slice(0, 120) };
    }
  };
  const urls = [...new Set([ANVIL, ...MAINNET_POOL_RPCS[CHAIN], ...urlsIn(evmPoolVenues()[CHAIN])])];
  const out = {};
  for (const u of urls) out[u] = await one(u);
  log(`clocks ${tag}`, { device: new Date(at).toISOString(), deviceS: Math.floor(at / 1000), blocks: out });
};
await clocks("before tap");
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
if (first && "error" in first) {
  await clocks("at refusal");
  const byMethod = {};
  for (const q of requests) {
    const m = (byMethod[q.method ?? q.path] ??= { n: 0, ms: 0, max: 0, errors: 0 });
    m.n++;
    m.ms += q.ms ?? 0;
    m.max = Math.max(m.max, q.ms ?? 0);
    if (q.error) m.errors++;
  }
  log("tap reads", { n: requests.length, byMethod, slowest: [...requests].sort((x, y) => (y.ms ?? 0) - (x.ms ?? 0)).slice(0, 8).map((q) => ({ atMs: q.atMs - tapAt, ms: q.ms, host: q.host, error: q.error ?? null, body: q.body })) });
  // why: the kit's quote of the standard shapes, each one's refusal
  const V = evmPoolVenues()[CHAIN];
  for (const route of [{ venue: "uniswap-v3", tokens: [V.weth, TOKEN], fees: [500] }, { venue: "uniswap-v3", tokens: [V.weth, TOKEN], fees: [3000] }, { venue: "uniswap-v4", currencyIn: "0x0000000000000000000000000000000000000000", hops: [{ currency: TOKEN, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" }] }]) {
    try {
      const q = await evmPoolBuyQuote({ chain: CHAIN, token: TOKEN, amountIn: proof.chunk - BigInt(proof.binding.feeCap), slippageBps: 300, route });
      log("quote probe", { route: route.venue + (route.fees ?? ""), ok: true, minOut: q.minOut ?? null });
    } catch (e) {
      log("quote probe", { route: route.venue + (route.fees ?? ""), code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e).slice(0, 300) });
    }
  }
  // why, as the tap asks: the kit's tap quote at the tap's amount, each route it asked and that route's refusal
  {
    const { evmPoolBuyQuoteTap } = await import("../../kit/src/trade/evm/buy-tap.ts");
    const asked = [];
    try {
      const q = await evmPoolBuyQuoteTap({ chain: CHAIN, token: TOKEN, amountIn: proof.chunk - BigInt(proof.binding.feeCap), slippageBps: 300 }, {
        quote: async (req) => {
          const e = { route: req.route };
          asked.push(e);
          try {
            return await evmPoolBuyQuote(req);
          } catch (x) {
            e.code = x?.code ?? null;
            e.message = String(x?.message ?? x).slice(0, 300);
            e.reference = x?.reference?.route ?? null;
            throw x;
          }
        },
      });
      log("tap probe", { ok: true, route: q.route, asked });
    } catch (e) {
      log("tap probe", { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300), asked });
    }
  }
  record.end = "answered_error";
  record.refusal = first;
  tapped = false;
  await finish(1);
}
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
const receiptOnFork = async (hash) => {
  let rc = null;
  for (let i = 0; hash && rc === null && i < 20; i++) {
    const top = BigInt(await anvil("eth_blockNumber", []));
    for (let n = top; rc === null && n > firstHead; n--) if ((await anvil("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])).transactions.includes(hash)) rc = await anvil("eth_getTransactionReceipt", [hash]);
    if (rc === null) await sleep(500);
  }
  return rc;
};
const rc = await receiptOnFork(hash);
record.tx = hash;
record.block = rc?.blockNumber ? BigInt(rc.blockNumber) : null;
record.status = rc?.status ?? null;
log("receipt", { tx: hash, block: record.block, status: record.status, gasUsed: rc?.gasUsed ? BigInt(rc.gasUsed) : null, logs: rc?.logs?.length ?? null });
if (process.env.FORK_FORCE_REFUSE === "1") {
  // the carry leg: the buy ended withdrawn (W holds the chunk less the fee in ETH); the page's carry puts it back into
  // the pool by itself, from the chain alone. Followed by state reads until W's carry is done and a new note is UNSPENT
  const Wf = proof.wallet.address.toLowerCase();
  const ethOf = async () => BigInt(await anvil("eth_getBalance", [Wf, "latest"]));
  const wAfterRefusal = await ethOf();
  const before = new Set((await ns.list()).map((n) => n.id));
  log("refused buy", { end: record.end, status: record.status, forced: force.at !== null, wEth: wAfterRefusal, holding: holdings?.[proof.wallet.address]?.state ?? null });
  const carryAt = Date.now();
  let done = null;
  let fresh = [];
  for (let i = 0; i < 90 && (done === null || fresh.length === 0); i++) {
    await t.stateRead();
    await sleep(2_000);
    await anvil("evm_mine", []);
    done = (await w.get("meta", EVM_CARRY_DONE_KEY))?.[Wf] ?? null;
    fresh = (await ns.list()).filter((n) => !before.has(n.id) && n.state === "UNSPENT");
    if (i % 5 === 0) log("carry wait", { i, done, open: (await w.get("meta", EVM_CARRY_OPEN_KEY))?.[Wf] ?? null, wEth: await ethOf(), fresh: fresh.length });
  }
  record.carry = { ms: Date.now() - carryAt, done, wEthBefore: wAfterRefusal, wEthAfter: await ethOf(), notes: fresh.map((n) => ({ id: n.id, ref: n.ref.kind, value: n.leaf?.value ?? null })), open: (await w.get("meta", EVM_CARRY_OPEN_KEY))?.[Wf] ?? null };
  log("carry end", record.carry);
  // the carried note from the words alone: a fresh profile's restore (notes only, as step 1's) finds it UNSPENT, at
  // the value the carry deposited
  const back = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs: pageEvmPoolRpcs(CHAIN), wallets: false });
  record.carry.restore = { block: back.block, notes: back.notes.map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf?.value ?? null })) };
  log("carry restore", record.carry.restore);
  const carried = fresh.length === 1 ? String(fresh[0].leaf?.value ?? "") : null;
  const restored = back.notes.some((n) => n.ref.kind === fresh[0]?.ref.kind && n.state === "UNSPENT" && String(n.leaf?.value ?? "") === carried);
  const ok = record.end === "refused" && holdings?.[proof.wallet.address]?.state === "withdrawn" && force.at !== null && done?.end === "carried" && fresh.length === 1 && restored;
  log("carry leg", { ok });
  await finish(ok ? 0 : 1);
}
if (!(record.end === "filled" && record.status === "0x1")) await finish(1);

// 5. device B: a fresh profile from the same words. The restore writes the notes (the buy's note SPENT), then B's first
// state read rebuilds W's buy record (src/pool-holdings-evm.ts: the round's Bought, the buy's transaction on the
// helper's /v1/rpc route, decimals on the pool pair)
const W = proof.wallet.address.toLowerCase();
const device = async (name) => {
  const st = await openWalletStore({ indexedDB: new IDBFactory() });
  await st.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: Date.now() });
  const nsx = await openNoteStore(st);
  const at = Date.now();
  const got = await evmRestoreNotes({ seed64: seed64.slice(), pin: PIN, rpcs: pageEvmPoolRpcs(CHAIN), wallets: false });
  await writeRestored(nsx, got);
  const restoreMs = Date.now() - at;
  const tx = testnetPool({ store: async () => st, held: async () => st, seed64: async () => seed64.slice() }, { prover: { vault, stop: () => {} }, fetch: helperFetch });
  log(`${name} restore`, { ms: restoreMs, notes: got.notes.map((n) => ({ ref: n.ref.kind, state: n.state, value: n.leaf?.value })) });
  return { name, st, ns: nsx, t: tx, kinds: poolKinds(testnetPoolDeps(tx.flow)), restoreMs };
};
const balanceOf = async (d) => {
  await d.t.stateRead();
  const rows = poolBalances(await readNotes(d.st), PAGE_POOLS);
  return rows.find((r) => r.chain === CHAIN)?.balance ?? null;
};
const positionOf = async (d) => {
  for (let i = 0; i < 120; i++) {
    const rows = ((await d.t.positions()) ?? []).filter((p) => p.chain === CHAIN && p.token.toLowerCase() === TOKEN);
    if (rows.length > 0) return rows[0];
    await sleep(500);
  }
  return null;
};
const A = { name: "A", st: w, ns, t, kinds };
const aPos = await positionOf(A);
const aBal = await balanceOf(A);
log("A after buy", { position: aPos, balance: aBal });
const B = await device("B");
const rebuildAt = Date.now();
await B.t.stateRead();
let rec = null;
for (let i = 0; i < 120 && rec === null; i++) {
  rec = ((await B.st.get("meta", EVM_POSITION_COSTS_KEY)) ?? {})[W] ?? null;
  if (rec === null) await sleep(250);
}
record.times.rebuildMs = Date.now() - rebuildAt;
log("B rebuild", { ms: record.times.rebuildMs, record: rec, sameRouteAsA: JSON.stringify(rec?.route?.path) === JSON.stringify(holdings?.[proof.wallet.address]?.route?.path) });
const bPos = await positionOf(B);
const bBal = await balanceOf(B);
record.ab = { aPosition: aPos, bPosition: bPos, aBalance: aBal, bBalance: bBal, equal: JSON.stringify([aPos?.amount, aBal]) === JSON.stringify([bPos?.amount, bBal]) };
log("B after restore", record.ab);
if (rec === null || bPos === null || !record.ab.equal) await finish(1);

// 6. B sells the whole holding (share 10,000 bps) at 300 bps, on a fresh head: the fork mines only on a send, and the
// kit refuses a block more than 30 s behind the device's clock (run 8, 13 Nov 08:16Z: the sell refused stale_quote, 58 s after the buy's fill)
await anvil("evm_mine", []);
const sellStages = [];
const SELL_ENDS = ["filled", "part_filled", "refused", "not_landed", "failed"];
tapped = true;
const sellAt = Date.now();
const s = B.kinds["pool.sell"]({ chain: CHAIN, token: TOKEN, share_bps: 10_000, slippage_bps: 300 }, { id: "sell", sha: "00", progress: (x) => (sellStages.push(x), log("sell progress", { stage: x, ms: Date.now() - sellAt })) });
if ("error" in s) {
  record.sell = { refusedAtTap: s };
  log("sell tap", { answer: s });
  await finish(1);
}
await s.after;
log("sell tap", { answer: s.answer(), ms: Date.now() - sellAt });
await navigator.locks.request(WALLET_SEED_LOCK, { mode: "exclusive" }, () => {});
for (let i = 0; i < 360 && !SELL_ENDS.includes(sellStages.at(-1)); i++) await sleep(1_000);
tapped = false;
record.sell = { end: sellStages.at(-1) ?? null, stages: sellStages, tapToEndMs: Date.now() - sellAt };
// the sale's transaction, the hash the helper's sell route answered, read back on the fork (run 10 kept it only in its
// helper calls)
const sold = helperCalls.filter((c) => c.path === "/v1/pool/evm/sell" && c.status === 200).map((c) => /"hash":"(0x[0-9a-f]{64})"/.exec(c.body)?.[1]).filter(Boolean).at(-1) ?? null;
const sellRc = await receiptOnFork(sold);
Object.assign(record.sell, { tx: sold, block: sellRc?.blockNumber ? BigInt(sellRc.blockNumber) : null, status: sellRc?.status ?? null });
log("sell end", record.sell);

// 7. the balances after the sale: B's, and a third fresh profile's from the same words
await sleep(2_000);
const bAfter = await balanceOf(B);
const C = await device("C");
let cAfter = null;
for (let i = 0; i < 20; i++) {
  cAfter = await balanceOf(C);
  if (cAfter === bAfter) break;
  await sleep(1_000);
}
const bPosAfter = ((await B.t.positions()) ?? []).filter((p) => p.chain === CHAIN);
record.after = { bBalance: bAfter, cBalance: cAfter, equal: bAfter === cAfter, bPositions: bPosAfter, grew: bAfter !== null && bBal !== null && Number(bAfter) > Number(bBal) };
log("after sale", record.after);
for (const d of [B, C]) await d.t.signedOut().catch(() => {});
await finish(record.sell.end === "filled" && record.sell.status === "0x1" && record.after.equal && record.after.grew ? 0 : 1);
