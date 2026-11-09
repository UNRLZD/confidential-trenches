#!/usr/bin/env node
// Live check of card evm-pool-leaves-any-source: a device rebuilds each EVM mainnet pool's two trees from leaves any one
// source gives, and holds them to the pool's views at one head block on two operators. For Base and Robinhood, read now:
//   1. the head on two keyless operators of two companies (Base: PublicNode and Pocket; Robinhood: Robinhood's own and
//      Pocket): the lower `latest` block number, read by number on both: one hash on both;
//   2. at that block hash (EIP-1898 { blockHash }), eth_call of the pool's currentRoot(), currentTreeSize(),
//      currentLabelRoot() and currentLabelTreeSize() on both operators: the two answers equal;
//   3. the pool's leaf logs (Deposited, Withdrawn, Bought in one topic position) from its deploy block to that head
//      block, from one source only: the helper's keyed route (POST /v1/rpc/<chain>, JSON-RPC eth_getLogs), in pages of
//      10,000 blocks, a page halved on a range refusal and a refused page asked again twice; every log is the pool's, in
//      its page, not removed, of the three events, with its data words as the pool's ABI has them, a leaf a field
//      element above 0, and a log in the head block carries the head block's hash;
//   4. the state tree (Deposited's _commitment, Withdrawn's and Bought's _newCommitment, in block and log order) and the
//      label tree (Deposited's _label) built from them with the kit's VaultTree (packages/wallet/src/pool/evm.ts
//      decodeLog and evmTreeSync read the same words): their sizes and roots (an empty tree's root is 0) equal the views
//      of step 2. An empty pool passes only with no logs and root 0.
// Every provider is read through provider-answer.mjs (rpcAnswer): a provider's no-answer (no body, not JSON, a 429, a rate
// limit, a block or state it does not hold), still one after three reads, makes that chain INCONCLUSIVE, never a FAIL
// and never a PASS.
// It fails on two operators that disagree on the head block's hash or on a view, on a log that is not the pool's or
// not as the ABI has it, and on a history source that gives fewer or other leaves than the pool holds (a tree whose
// size or root is not the view's). The history source is a parameter of the check, not part of its verdict: any source
// whose leaves rebuild the pool's roots passes.
// Pure reads of public RPCs and the helper's route: no key, no write.
// After: sign
//   node scripts/live-checks/evm-pool-leaves-any-source.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (provider-answer.mjs EXIT)
// --record writes every answer read, as the good run of evm-pool-leaves-any-source.answers.json, and the bad run: the
// good answers with a leaf the pool does not hold added to Base's first page of logs (plantedBad; the file's note says so).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VAULT_FIELD_P, VaultTree, evmRpcOperator } from "../../packages/kit/src/index.ts";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-pool-leaves-any-source";
/** The pool's three events (packages/wallet/src/pool/evm.ts EVM_POOL_EVENTS), keccak256 of each signature; the test
 *  holds them equal to robinhood-mainnet-rpcs.mjs's POOL_TOPICS. */
export const POOL_TOPICS = Object.freeze([
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549", // Deposited(address,uint256,uint256,uint256,uint256)
  "0xfabb9e7afa4ef595f60e1ae9041b2b311b4acb27aeaed4b11b6f2abf689af10a", // Withdrawn(address,address,uint256,uint256,uint256,uint256)
  "0xb8a1e6c10d45357f60b093ab761ca4af74bf300c039aa105fb946f7e5105727d", // Bought(address,address,uint256,uint256,uint256,uint256,address,uint256)
]);

/** A provider's read: provider-answer.mjs's rpcAnswer, { result } or { error } (a JSON-RPC error, judged) or
 *  { noAnswer } (the provider's no-answer, named). */
export const live = (url, method, params) => rpcAnswer(url, method, params);

/** The live transport, each answer kept in order: the good run's recording. */
export function recorder(read = live) {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await read(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}

/** A transport that answers each call with the recorded answers to that same call, in their order; past the last, the
 *  last again. A call with none recorded is a no-answer (the run is INCONCLUSIVE, never judged on it). */
export function replayer(log) {
  const queues = new Map();
  for (const e of log) {
    const k = JSON.stringify([e.url, e.method, e.params]);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(e);
  }
  return async (url, method, params) => {
    const q = queues.get(JSON.stringify([url, method, params]));
    const e = q?.length > 1 ? q.shift() : q?.[0];
    if (e === undefined) return { noAnswer: `no recorded answer to ${method} ${JSON.stringify(params)} on ${url}` };
    return "noAnswer" in e ? { noAnswer: e.noAnswer } : "error" in e ? { error: e.error } : { result: e.result };
  };
}

/** A no-answer is read again after WAIT.ms, doubled each time, at most QUIET_TRIES reads in all: the helper's route
 *  answers a run past its per-client pace HTTP 429 (a live run, 9 Nov 11:1xZ, 30-odd pages in), so the walk waits it out
 *  as the old transport did (1-3 s a 429), never judged on it. The tests set WAIT.ms to 0. */
export const WAIT = { ms: 2000 };
const QUIET_TRIES = 5;
const pause = (t) => new Promise((r) => setTimeout(r, WAIT.ms * 2 ** (t - 1)));
/** One read of `url`, a no-answer read again (QUIET_TRIES): the last answer. */
async function read(transport, url, method, params) {
  let a;
  for (let t = 1; t <= QUIET_TRIES; t++) {
    a = await transport(url, method, params);
    if (!("noAnswer" in a) || t === QUIET_TRIES) return a;
    await pause(t);
  }
  return a;
}
/** A chain's provider that gave no answer: the chain is INCONCLUSIVE. */
class Quiet extends Error {}
/** A JSON-RPC error's words: a recorded string, or the error object's message. */
const words = (e) => (typeof e === "string" ? e : typeof e?.message === "string" ? `${e.code ?? ""} ${e.message}`.trim() : JSON.stringify(e));
export const HELPER = "https://ct-api.unrealized.trade";
/** The first page, in blocks (packages/wallet/src/pool/evm.ts EVM_LOG_PAGE_BLOCKS). */
export const PAGE = 10_000;
/** A refused page is asked again twice before it is halved (robinhood-mainnet-rpcs: Pocket's backends differ). */
const TRIES = 3;
/** The pool's views (selectors: keccak256 of each signature, first 4 bytes). */
export const VIEWS = Object.freeze({ root: "0xfdab463d", size: "0xa8f0f95a", labelRoot: "0x50f3e219", labelSize: "0x4181445b" });
/** Data words of each event (packages/wallet/src/pool/evm.ts DATA_WORDS); the leaf's word: _commitment 0, _newCommitment 4. */
const WORDS = Object.freeze({ [POOL_TOPICS[0]]: 4, [POOL_TOPICS[1]]: 5, [POOL_TOPICS[2]]: 7 });
/** A node's refusal of a read for its size, as the helper's rule names one (apps/helper/src/limits/limits.ts EVM_RANGE_MESSAGE). */
const RANGE = /block range|max(imum)? (block )?range|ranges? over|returned more than|response size|limit exceeded|too (many|large)/i;
/** A bound on the calls of one chain's history, so a source that refuses everything ends in a FAIL, not a long walk. */
const MAX_CALLS = 20_000;

/** The two mainnet pools: the deployments' addresses (contracts/pool-evm/deployments/<chain>.json) and their deploy blocks. */
export const CHAINS = Object.freeze([
  {
    name: "base",
    ops: ["https://base-rpc.publicnode.com", "https://base.api.pocket.network"],
    history: `${HELPER}/v1/rpc/base`,
    pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf",
    from: 54325671,
  },
  {
    name: "robinhood",
    ops: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"],
    history: `${HELPER}/v1/rpc/robinhood`,
    pool: "0x9306359433127c4f3be426f6faeb00a3c41f66db",
    from: 108420674,
  },
]);

const host = (u) => new URL(u).host;
const hx = (n) => `0x${n.toString(16)}`;
const H32 = /^0x[0-9a-f]{64}$/;
const lc = (s) => (typeof s === "string" ? s.toLowerCase() : s);
const qty = (v, what) => {
  if (typeof v !== "string" || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)) throw new Error(`${what}: ${JSON.stringify(v)} is not a quantity`);
  return BigInt(v);
};

/** One log, checked as the wallet's decodeLog checks it: { block, index, state, label }. */
export function decode(raw, pool, from, to, what) {
  if (typeof raw !== "object" || raw === null) throw new Error(`${what}: not a log`);
  if (lc(raw.address) !== pool) throw new Error(`${what}: not the pool's log`);
  if (raw.removed !== undefined && raw.removed !== false) throw new Error(`${what}: a removed log`);
  const block = qty(raw.blockNumber, `${what} blockNumber`);
  if (block < from || block > to) throw new Error(`${what}: block ${block} is outside ${from}..${to}`);
  const blockHash = lc(raw.blockHash);
  if (!H32.test(blockHash ?? "")) throw new Error(`${what}: blockHash is not 32 bytes`);
  const index = qty(raw.logIndex, `${what} logIndex`);
  const t = Array.isArray(raw.topics) ? raw.topics.map(lc) : null;
  if (t === null || t.length !== 2 || !t.every((x) => H32.test(x))) throw new Error(`${what}: not two topics`);
  const words = WORDS[t[0]];
  if (words === undefined) throw new Error(`${what}: not Deposited, Withdrawn or Bought`);
  const data = lc(raw.data);
  if (typeof data !== "string" || !new RegExp(`^0x[0-9a-f]{${64 * words}}$`).test(data)) throw new Error(`${what}: not ${words} data words`);
  const w = (i) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  const dep = t[0] === POOL_TOPICS[0];
  const state = dep ? w(0) : w(4);
  const label = dep ? w(1) : null;
  for (const v of [state, label]) if (v !== null && (v === 0n || v >= VAULT_FIELD_P)) throw new Error(`${what}: a leaf is not a field element above 0`);
  return { block, blockHash, index, state, label };
}

/** The pool's leaf logs from `from` to `head` off one history source, in pages: { logs (raw), pages, refused }. */
async function history(transport, url, pool, from, head, headHash) {
  const logs = [];
  let size = BigInt(PAGE);
  let at = from;
  let pages = 0;
  let refused = 0;
  let calls = 0;
  while (at <= head) {
    const to = at + size - 1n > head ? head : at + size - 1n;
    let answer;
    let error = "";
    let quiet = null;
    for (let t = 1; t <= TRIES && answer === undefined; t++) {
      if (++calls > MAX_CALLS) throw new Error(`${host(url)}: more than ${MAX_CALLS} log reads`);
      const a = await read(transport, url, "eth_getLogs", [{ address: pool, topics: [[...POOL_TOPICS]], fromBlock: hx(at), toBlock: hx(to) }]);
      quiet = null;
      if ("noAnswer" in a) quiet = a.noAnswer;
      else if ("error" in a) {
        error = words(a.error);
        refused++;
      } else if (!Array.isArray(a.result)) {
        error = "not a list of logs";
        refused++;
      } else answer = a.result;
    }
    if (answer === undefined && quiet !== null) throw new Quiet(`the pool's logs ${at}-${to}: ${quiet}`);
    if (answer === undefined) {
      if (size === 1n || !RANGE.test(error)) throw new Error(`${host(url)}: the pool's logs ${at}-${to}: ${error}`);
      size = (to - at + 1n) / 2n;
      continue;
    }
    pages++;
    for (const [i, raw] of answer.entries()) {
      const l = decode(raw, pool, at, to, `${host(url)}: logs ${at}-${to} #${i}`);
      if (l.block === head && l.blockHash !== headHash) throw new Error(`${host(url)}: a log in the head block ${head} carries ${l.blockHash}, not the head hash ${headHash}`);
      logs.push({ ...l, raw });
    }
    at = to + 1n;
  }
  return { logs, pages, refused };
}

/** The check for one chain: its line, or a thrown reason. */
async function chain(transport, c) {
  const { name, ops, pool } = c;
  const from = BigInt(c.from);
  if (ops.length !== 2 || evmRpcOperator(ops[0]) === null || evmRpcOperator(ops[0]) === evmRpcOperator(ops[1])) throw new Error(`${name}: the two operators are not two companies: ${ops.map(host).join(" and ")}`);
  const ask = async (url, method, params, what) => {
    let a;
    for (let t = 1; t <= TRIES; t++) {
      a = await read(transport, url, method, params);
      if (!("error" in a) && !("noAnswer" in a)) return a.result;
    }
    if ("noAnswer" in a) throw new Quiet(`${what}: ${a.noAnswer}`);
    throw new Error(`${name}: ${host(url)}: ${what}: ${words(a.error)}`);
  };
  const heads = [];
  for (const u of ops) heads.push(qty(await ask(u, "eth_blockNumber", [], "eth_blockNumber"), `${name}: ${host(u)} head`));
  const head = heads[0] < heads[1] ? heads[0] : heads[1];
  if (head < from) throw new Error(`${name}: the head ${head} is before the pool's deploy block ${from}`);
  const hashes = [];
  for (const u of ops) {
    const b = await ask(u, "eth_getBlockByNumber", [hx(head), false], `block ${head}`);
    const h = lc(b?.hash);
    if (typeof b !== "object" || b === null || !H32.test(h ?? "") || qty(b.number, `${name}: ${host(u)} block number`) !== head) throw new Error(`${name}: ${host(u)}: not block ${head}`);
    hashes.push(h);
  }
  if (hashes[0] !== hashes[1]) throw new Error(`${name}: the operators differ on block ${head}: ${ops.map((u, k) => `${host(u)} ${hashes[k]}`).join(", ")}`);
  const headHash = hashes[0];
  const views = {};
  for (const [what, data] of Object.entries(VIEWS)) {
    const got = [];
    for (const u of ops) {
      const r = await ask(u, "eth_call", [{ to: pool, data }, { blockHash: headHash }], `${what} at ${headHash}`);
      if (typeof r !== "string" || !H32.test(lc(r))) throw new Error(`${name}: ${host(u)}: ${what}: not one 32-byte word`);
      got.push(BigInt(r));
    }
    if (got[0] !== got[1]) throw new Error(`${name}: the operators differ on ${what} at ${headHash}: ${ops.map((u, k) => `${host(u)} ${hx(got[k])}`).join(", ")}`);
    views[what] = got[0];
  }
  const h = await history(transport, c.history, pool, from, head, headHash);
  const sorted = [...h.logs].sort((a, b) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].block === sorted[i - 1].block && sorted[i].index === sorted[i - 1].index) throw new Error(`${name}: the history gives block ${sorted[i].block} log ${sorted[i].index} twice`);
  const state = new VaultTree(sorted.map((l) => l.state));
  const label = new VaultTree(sorted.filter((l) => l.label !== null).map((l) => l.label));
  const root = state.root ?? 0n;
  const labelRoot = label.root ?? 0n;
  const at = `${name} at ${headHash} (block ${head}) from ${host(c.history)}`;
  if (BigInt(state.size) !== views.size) throw new Error(`the state tree from ${h.logs.length} logs has ${state.size} leaves, not the pool's ${views.size}: ${at}`);
  if (root !== views.root) throw new Error(`the state tree from ${h.logs.length} logs has root ${hx(root)}, not the pool's ${hx(views.root)}: ${at}`);
  if (BigInt(label.size) !== views.labelSize) throw new Error(`the label tree from ${h.logs.length} logs has ${label.size} leaves, not the pool's ${views.labelSize}: ${at}`);
  if (labelRoot !== views.labelRoot) throw new Error(`the label tree from ${h.logs.length} logs has root ${hx(labelRoot)}, not the pool's ${hx(views.labelRoot)}: ${at}`);
  if (state.size === 0 && h.logs.length !== 0) throw new Error(`${name}: an empty pool with ${h.logs.length} logs`);
  return `${name}: head ${head} ${headHash}, state size ${state.size} root ${hx(root)}, label size ${label.size} root ${hx(labelRoot)}, ${h.logs.length} logs in ${h.pages} pages from ${host(c.history)} (${h.refused} refused), operators ${ops.map(host).join(" and ")} agree`;
}

/** The check: { ok, verdict, lines }. `chains`: both pools unless a test names others. Every chain is read; one FAIL
 *  fails the run; else a chain whose provider gave no answer makes it INCONCLUSIVE (provider-answer.mjs verdictOf). */
export async function check(transport, chains = CHAINS) {
  const lines = [];
  let bad = false;
  let quiet = false;
  for (const c of chains) {
    try {
      lines.push(`PASS ${await chain(transport, c)}`);
    } catch (e) {
      if (e instanceof Quiet) {
        quiet = true;
        lines.push(`INCONCLUSIVE ${c.name}: ${e.message}`);
      } else {
        bad = true;
        lines.push(`FAIL ${e?.message ?? e}`);
      }
    }
  }
  const verdict = verdictOf(bad, quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** A Deposited log the pool does not hold (_commitment 5, _label 6), in the first page `fromBlock` of `pool`'s history. */
export function fabricated(pool, block) {
  const w = (v) => v.toString(16).padStart(64, "0");
  return {
    address: pool,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${"ab".repeat(32)}`,
    logIndex: "0x0",
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x0",
    topics: [POOL_TOPICS[0], `0x${"0".repeat(64)}`],
    data: `0x${w(5n)}${w(6n)}${w(1n)}${w(2n)}`,
    removed: false,
  };
}

/** The good recording with a leaf the pool does not hold added to Base's first page of logs: the bad run. */
export function plantedBad(good) {
  const base = good.chains[0];
  let done = false;
  const log = good.log.map((e) => {
    if (done || e.url !== base.history || e.method !== "eth_getLogs" || !Array.isArray(e.result)) return e;
    done = true;
    return { ...e, result: [...e.result, fabricated(base.pool, base.from)] };
  });
  if (!done) throw new Error("no history read to plant a leaf in");
  return { chains: good.chains, log };
}

async function main(argv) {
  const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const record = at("--record");
  const rec = recorder();
  const r = await check(rec.transport);
  for (const l of r.lines) console.log(l);
  if (record) {
    if (r.verdict !== "PASS") throw new Error("the good run did not pass: nothing to record");
    const good = { chains: [...CHAINS], log: rec.log };
    const bad = plantedBad(good);
    const b = await check(replayer(bad.log), bad.chains);
    if (b.verdict !== "FAIL") throw new Error("the planted bad run did not fail");
    for (const l of b.lines) console.log(`bad: ${l}`);
    const note = {
      good: "a real run from a Mac, read only: every answer the two operators and the helper's route gave",
      bad: "NOT a real source's answer: the good recording with one Deposited log (_commitment 5, _label 6) added to Base's first page of the helper's logs, a leaf the pool does not hold (both pools held no leaves when this was recorded, so no real source could give fewer: the planted run stands for a history source that gives other leaves than the pool holds)",
    };
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { note: note.good, ...good }, bad: { note: note.bad, ...bad } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(EXIT.ERROR)));
