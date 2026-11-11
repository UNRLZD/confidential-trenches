#!/usr/bin/env node
// Live check of card evm-deposit-note-stays-incoming: every state read of the signing page's EVM pool deposit
// (packages/signpage/src/pool-deposit-evm.ts) is one the page's own providers answer.
// SIGN_HOST (https://confidential.unrealized.trade/): its page's script, the bundle the device runs, must name each
// pool pair's seats below, and must hold no state read (eth_getTransactionCount, eth_getBalance, eth_getCode,
// eth_getStorageAt, eth_call, eth_estimateGas) at a "finalized" or "safe" tag, which is the read this card removed. Robinhood is Arbitrum Nitro, whose
// public nodes keep about 10 to 24 s of state: U's nonce at "finalized" is refused there with -32000 "historical state
// ... is not available", so a deposit whose verdict read it never settled. The path now reads state only at the newest
// block both RPCs hold, and block headers. On each chain's pool pair as the deployed page seats it (the kit's
// evmPoolProvidersOf(evmPoolVenues()[chain]), which test/pool-restore.test.ts holds equal to the page's
// MAINNET_POOL_RPCS), read now, with the pool's own public address standing in for U (no user's wallet is named):
//   - the newest block both hold: eth_getBlockByNumber "latest" on both, the lower read by number on both, one hash;
//   - the price's reads at that block by number (accountReads): eth_getTransactionCount and eth_getBalance;
//   - the dead-send judgment's (spentFinal): eth_getTransactionCount at that block's hash (EIP-1898), the "finalized"
//     header on both at or below that block, and the header at the lower finalized number with one hash on both.
// Each must answer a well-formed value on both seats. A seat that refuses a read is never asked the same read again
// (the page does not ask again either), and one that answers nothing usable is (the page's client retries a transport
// fault too), making the check INCONCLUSIVE on its last try. Two seats on different blocks at one number (a moment's
// fork, or a seat behind) are read again from the newest block, FORK_TRIES times FORK_WAIT_MS apart, as the page's own
// lag retry reads them (the wallet's EVM_LAG_TRIES and EVM_LAG_WAIT_MS); a seat that refuses U's state at the newest
// block (a state miss is judged a wrong answer, judgeStateMiss) is read again the same way, from a newer block, as the
// page's next pass reads it. Either fails the check only if it is still so on the last read. A seat that does not know a
// block yet, one at or below the newest block both reported (a null block by number, or a state read at it answered
// with the words of a block not held: NOT_YET, not a pruned state's STATELESS), is read again the same way, and still
// behind on the last read is INCONCLUSIVE naming that seat (Lag): Base makes a block every 200 ms and a provider's
// backends lag one another (release 116's sign live run 43024665974: "base.api.pocket.network: block 56057255: not a
// block", a block below both seats' latest). A seat that knows the block and answers it wrong still fails.
// What the bundle rule (OLD_STATE_READ) sees: a state method named as a string literal, then within one list of params
// with no nested list, a "finalized" or "safe" literal as the last param, in any quote style, with no space after the
// commas: the shape the page's minified build makes, so SIGN_HOST's bundle before this card is caught by it. It does not
// see the tag or the method passed through a variable or a loop, a state read at the hash or number of a block read at
// "finalized", a nested list before the tag, or an unminified bundle's spacing: a rewrite of the path in such a shape
// passes it, and the provider reads below and the page's own tests (pool-deposit-evm.test.ts, "no step of the deposit
// asks a block's state by a tag other than the newest") hold that case.
// After: sign
//   node scripts/live-checks/evm-deposit-note-stays-incoming.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
// --record writes every answer read as the good run, and as the bad run a real run of the read the path made before
// (U's nonce at "finalized"), which Robinhood's providers refuse; a bundle's facts (bundleFacts) are recorded, not its
// 850 KB of text. --bundle <file> judges that file in place of SIGN_HOST's (a local build before its deploy). The bundle
// half alone (readBundle, judgeBundleOnly: the script the index pins, its old state reads and its seats) reads nothing
// past what SIGN_HOST serves, so scripts/ci/bundle-checks.mjs runs it on a pull request's build.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolProvidersOf, evmPoolVenues } from "../../packages/kit/src/index.ts";
import { EXIT, NOT_YET, rpcAnswer, STATELESS } from "./provider-answer.mjs";

const KEY = "evm-deposit-note-stays-incoming";
export const SIGN_HOST = "https://confidential.unrealized.trade/";
/** A state read at an old block's tag, as the bundle's code makes it: the method, then its params ending in the tag. */
export const OLD_STATE_READ = /[`"'](eth_getTransactionCount|eth_getBalance|eth_getCode|eth_getStorageAt|eth_call|eth_estimateGas)[`"'],\[[^\]]{0,200}?[`"'](finalized|safe)[`"']\]/g;
/** What the check reads of a bundle: its hash, its old state reads (each up to 120 characters) and the seats it names. */
export function bundleFacts(text, pairs) {
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: text.length,
    oldStateReads: [...text.matchAll(OLD_STATE_READ)].map((m) => m[0].slice(0, 120)),
    seats: Object.fromEntries(pairs.flatMap((p) => p.seats).map((u) => [u, text.includes(u)])),
  };
}
/** SIGN_HOST's bundle: its page (html) and the page's script, fetched (url, text). */
export async function signBundle(fetchFn = fetch) {
  const page = await fetchFn(SIGN_HOST);
  const html = await page.text();
  const src = html.match(/<script[^>]*\bsrc="([^"]+\.js)"/)?.[1];
  if (page.status !== 200 || src === undefined) throw new Error(`SIGN_HOST ${SIGN_HOST} answered ${page.status} with ${src === undefined ? "no script" : "a script"}`);
  const url = new URL(src, SIGN_HOST).href;
  const js = await fetchFn(url);
  if (js.status !== 200) throw new Error(`SIGN_HOST's script ${url} answered ${js.status}`);
  return { url, html, text: await js.text() };
}
/** The bundle's verdict lines: throws on an old state read or a seat the bundle does not name. */
function judgeBundle(b, pairs) {
  if (b.oldStateReads.length > 0) throw new Error(`the bundle ${b.url} (${b.sha256.slice(0, 16)}) holds ${b.oldStateReads.length} state read(s) at an old block's tag: ${b.oldStateReads.join(" | ")}`);
  const missing = pairs.flatMap((p) => p.seats).filter((u) => b.seats[u] !== true);
  if (missing.length) throw new Error(`the bundle ${b.url} names no ${missing.join(", ")}: not the page's pairs`);
  return `the bundle ${b.url} (${b.sha256.slice(0, 16)}, ${b.bytes} bytes): no state read at an old block's tag; it names every seat (${Object.keys(b.seats).length})`;
}
/** The bundle half alone, which reads only what SIGN_HOST serves (scripts/ci/bundle-checks.mjs runs it on a pull
 *  request's build): its index, the script it names and that script's sha384 against the index's pin. */
export async function readBundle(fetchFn = fetch, pairs = pagePairs()) {
  const got = await signBundle(fetchFn);
  return { index: got.html, sha384: `sha384-${createHash("sha384").update(got.text).digest("base64")}`, url: got.url, ...bundleFacts(got.text, pairs) };
}
/** The bundle half's verdict: { ok, lines }. */
export function judgeBundleOnly(b, pairs = pagePairs()) {
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(b?.index ?? "")?.[1];
  if (!pin) return { ok: false, lines: ["BAD SIGN_HOST's index.html pins no /app.js"] };
  if (pin !== b.sha384) return { ok: false, lines: ["BAD SIGN_HOST's served /app.js is not the one index.html pins"] };
  try {
    return { ok: true, lines: [judgeBundle(b, pairs)] };
  } catch (e) {
    return { ok: false, lines: [`BAD ${e?.message ?? e}`] };
  }
}
export const CHAINS = Object.freeze({ base: "0x2105", robinhood: "0x1237" });
const TRIES = 3;
export const FORK_TRIES = 5;
export const FORK_WAIT_MS = 2_000;
const QTY = /^0x[0-9a-fA-F]{1,64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Each chain's pool pair as the page seats it, and the public address read in U's place. */
export function pagePairs() {
  return Object.keys(CHAINS).map((chain) => {
    const v = evmPoolVenues()[chain];
    return { chain, seats: [...(evmPoolProvidersOf(v) ?? [])].slice(0, 2), address: (v.pool ?? v.poolManager).toLowerCase() };
  });
}

export const post = (url, method, params) => rpcAnswer(url, method, params, { timeoutMs: 20_000, judgeStateMiss: true });
export function recorder() {
  const log = [];
  const transport = async (url, method, params) => {
    const a = await post(url, method, params);
    log.push({ url, method, params, ...a });
    return a;
  };
  return { transport, log };
}
/** Replays each call's recorded answers in order (past the last, the last again); an unrecorded call is a no-answer. */
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
    if (e === undefined) return { noAnswer: `${new URL(url).host}: no recorded answer to ${method} ${JSON.stringify(params)}` };
    return "noAnswer" in e ? { noAnswer: e.noAnswer } : "error" in e ? { error: e.error } : { result: e.result };
  };
}

/** Two seats on different blocks at one number, or a seat that refuses U's state at the newest block: read again from
 *  the newest block. */
class Fork extends Error {}
/** A seat that does not know a block yet: read again from the newest block, INCONCLUSIVE when still so on the last read. */
class Lag extends Fork {}
class ReadFailed extends Error {
  constructor(message, quiet, rpcError) {
    super(message);
    this.quiet = quiet;
    this.rpcError = rpcError;
  }
}
/** A JSON-RPC error that says the seat does not hold the block yet (not that it pruned the block's state). */
const notYet = (e) => typeof e?.message === "string" && NOT_YET.test(e.message) && !STATELESS.test(e.message);
const host = (u) => new URL(u).host;
async function ask(transport, url, method, params, what) {
  let a;
  for (let t = 1; t <= TRIES; t++) {
    a = await transport(url, method, params);
    if (a?.noAnswer === undefined && a?.error === undefined) return a?.result;
    if (a?.noAnswer === undefined) break; // an RPC error: the page does not ask again either
  }
  if (a.noAnswer !== undefined) throw new ReadFailed(`${what}: no answer: ${a.noAnswer}`, true);
  throw new ReadFailed(`${host(url)}: ${what}: RPC error ${a.error?.code}: ${a.error?.message ?? JSON.stringify(a.error)}`, false, a.error);
}
const qty = (x, what) => {
  if (typeof x !== "string" || !QTY.test(x)) throw new Error(`${what}: not a quantity: ${JSON.stringify(x)}`);
  return BigInt(x);
};
const header = (x, what) => {
  if (typeof x?.hash !== "string" || !HASH.test(x.hash)) throw new Error(`${what}: not a block`);
  return { number: qty(x.number, `${what} number`), hash: x.hash.toLowerCase() };
};
const hx = (n) => `0x${n.toString(16)}`;

/** The deposit path's reads on one pair (`before`: the read the path made before this card, U's nonce at "finalized"). */
async function pairReads(transport, pair, before, sleep) {
  for (let t = 1; ; t++) {
    try {
      return await pairReadsOnce(transport, pair, before);
    } catch (e) {
      if (e instanceof Lag && t >= FORK_TRIES) throw new ReadFailed(`${e.message}, on ${FORK_TRIES} reads ${FORK_WAIT_MS} ms apart`, true);
      if (!(e instanceof Fork) || t >= FORK_TRIES) throw e;
      await sleep(FORK_WAIT_MS);
    }
  }
}
async function pairReadsOnce(transport, { chain, seats, address }, before) {
  const lines = [];
  const both = (f) => Promise.all(seats.map((u, k) => f(u, k)));
  for (const u of seats) {
    const id = await ask(transport, u, "eth_chainId", [], "eth_chainId");
    if (typeof id !== "string" || id.toLowerCase() !== CHAINS[chain]) throw new Error(`${host(u)}: eth_chainId ${JSON.stringify(id)}, not ${CHAINS[chain]}`);
  }
  if (before) {
    const n = await both(async (u) => qty(await ask(transport, u, "eth_getTransactionCount", [address, "finalized"], "U's nonce at finalized"), `${host(u)}: U's nonce at finalized`));
    lines.push(`${chain}: U's nonce at finalized answered on both (${n.join(", ")})`);
    return lines;
  }
  const tops = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", ["latest", false], "the latest block"), `${host(u)}: the latest block`));
  const n = tops[0].number < tops[1].number ? tops[0].number : tops[1].number;
  // a block at or below both seats' newest, by number: null is the seat not holding it yet (Lag), any other non-block fails
  const byNumber = async (u, k) => {
    const x = await ask(transport, u, "eth_getBlockByNumber", [hx(k), false], `block ${k}`);
    if (x === null) throw new Lag(`${host(u)}: block ${k}: not known yet`);
    return header(x, `${host(u)}: block ${k}`);
  };
  const at = await both((u) => byNumber(u, n));
  if (at[0].hash !== at[1].hash) throw new Fork(`${chain}: the seats hold different blocks at ${n} on ${FORK_TRIES} reads`);
  const blk = at[0];
  // U's state at the newest block: a refusal is read again from the newest block (Fork), never asked again as it is
  const fresh = (p) =>
    p.catch((e) => {
      if (e instanceof ReadFailed && !e.quiet && notYet(e.rpcError)) throw new Lag(`${e.message}: the block not known yet`);
      throw e instanceof ReadFailed && !e.quiet ? new Fork(`${e.message} (on ${FORK_TRIES} reads)`) : e;
    });
  for (const [method, what] of [["eth_getTransactionCount", "U's nonce"], ["eth_getBalance", "U's balance"]])
    await fresh(both(async (u) => qty(await ask(transport, u, method, [address, hx(n)], `${what} at the newest block ${n}`), `${host(u)}: ${what}`)));
  await fresh(both(async (u) => qty(await ask(transport, u, "eth_getTransactionCount", [address, { blockHash: blk.hash }], `U's nonce at the newest block's hash`), `${host(u)}: U's nonce at the block hash`)));
  const fin = await both(async (u) => header(await ask(transport, u, "eth_getBlockByNumber", ["finalized", false], "the finalized header"), `${host(u)}: the finalized header`));
  const low = fin[0].number < fin[1].number ? fin[0].number : fin[1].number;
  if (low > n) throw new Error(`${chain}: a finalized header ${low} above the newest agreed block ${n}`);
  const f = await both((u) => byNumber(u, low));
  if (f[0].hash !== f[1].hash) throw new Fork(`${chain}: the seats hold different final blocks at ${low} on ${FORK_TRIES} reads`);
  lines.push(`${chain} (${seats.map(host).join(", ")}): newest agreed block ${n}; U's nonce and balance at it, U's nonce at its hash, the finalized header ${low} (${n - low} blocks behind) with one hash on both: all answered`);
  return lines;
}

/** The check: { verdict, ok, lines }. */
export async function check(transport, { pairs = pagePairs(), before = false, bundle, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  const lines = [];
  try {
    if (bundle === undefined) throw new Error("no bundle read");
    lines.push(judgeBundle(bundle, pairs));
    for (const p of pairs) {
      if (p.seats.length !== 2) throw new Error(`${p.chain}: the pool list seats ${p.seats.length} providers, not two`);
      lines.push(...(await pairReads(transport, p, before, sleep)));
    }
    return { verdict: "PASS", ok: true, lines };
  } catch (e) {
    lines.push(`${e?.message ?? e}`);
    return { verdict: e?.quiet === true ? "INCONCLUSIVE" : "FAIL", ok: false, lines };
  }
}

async function main(argv) {
  const record = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : undefined;
  const file = argv.includes("--bundle") ? argv[argv.indexOf("--bundle") + 1] : undefined;
  const pairs = pagePairs();
  const got = file === undefined ? await signBundle() : { url: `file:${path.basename(file)}`, text: readFileSync(file, "utf8") };
  const bundle = { url: got.url, ...bundleFacts(got.text, pairs) };
  const rec = recorder();
  const r = await check(rec.transport, { pairs, bundle });
  for (const l of r.lines) console.log(`${r.verdict} ${l}`);
  if (record) {
    if (r.verdict !== "PASS") throw new Error(`the good run is ${r.verdict}: no good run to record`);
    const bad = recorder();
    const live = file === undefined ? bundle : await signBundle().then((x) => ({ url: x.url, ...bundleFacts(x.text, pairs) }));
    const b = await check(bad.transport, { pairs, before: true, bundle: { ...live, oldStateReads: [] } });
    if (b.verdict !== "FAIL") throw new Error(`the read before is ${b.verdict}, not FAIL: no bad run to record`);
    writeFileSync(record, `${JSON.stringify({ key: KEY, recorded: new Date().toISOString(), good: { pairs, bundle, log: rec.log }, before: { pairs, bundle: live, log: bad.log } }, null, 1)}\n`);
    console.log(`recorded ${record}`);
  }
  console.log(`${r.verdict} ${KEY}`);
  return EXIT[r.verdict];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`error: ${e?.stack ?? e}`), process.exit(2)));
