#!/usr/bin/env node
// Live check of card evm-money-shows-and-spends-at-once: money on Base and Robinhood shows and spends seconds after it
// lands, on every device. Read now:
//   - SIGN_HOST's served script is the one its index.html pins, and it carries the head rule's note store
//     (packages/wallet/src/notes/store.ts): the scope's highest finalized block kept under its own key (evm-final/) and
//     the refusal that never backs a finalized fact out ("it never backs out"), as minified, so the page writes a
//     note at the newest block both RPCs agree on and heals it if a reorg drops it;
//   - on each mainnet, the page's own pool pair (MAINNET_POOL_RPCS, packages/signpage/src/pool-testnet.ts; the test holds
//     them equal) agrees on one block by hash at the lower of the two newest heights, as the wallet's evmAgreedBlock
//     reads it, two blocks at one height read again up to LAG_TRIES times; that block is at most FRESH_S old. That
//     block is the one the page shows the balance and the notes from, so a deposit or a release in it shows within that
//     time. The finalized block on both is read beside it, its lag printed as a "--" line (about 1,100 s on Base,
//     Robinhood's varies), never judged: the page no longer waits for it.
// A provider that gives no answer is named and the check INCONCLUSIVE; a wrong answer (another chain, no block, two
// blocks at one height on every try, an old newest block) fails.
// After: sign
//   node scripts/live-checks/evm-money-shows-and-spends-at-once.mjs [--record <file>] [--answer <file>]
//     PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "evm-money-shows-and-spends-at-once";
export const SIGN = "https://confidential.unrealized.trade";
/** The page's mainnet pool pairs (packages/signpage/src/pool-testnet.ts MAINNET_POOL_RPCS). */
export const POOL_RPCS = Object.freeze({
  base: Object.freeze(["https://base-rpc.publicnode.com", "https://base.api.pocket.network"]),
  robinhood: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.api.pocket.network"]),
});
const CHAIN_IDS = Object.freeze({ base: 8453, robinhood: 4663 });
/** The newest agreed block's age the page shows money within, s (the card's 30 s). */
export const FRESH_S = 30;
/** Two blocks at one height read again, as the wallet's evmRetryLag does (EVM_LAG_TRIES). */
export const LAG_TRIES = 6;
const LAG_WAIT_MS = 1000;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const hostOf = (u) => new URL(u).host;
/** The store's highest finalized block key and its guard's words, as the bundle keeps them. */
const FINAL_KEY = /["'`]evm-final\/["'`]/;
const GUARD = /it never backs out/;

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of SIGN_HOST: its index, its served script's sha384, the marks read from it. */
export const signFacts = (index, js) => ({ index, sha384: sha384(js), finalKey: FINAL_KEY.test(js), guard: GUARD.test(js) });

/** The verdict on an answer { sign: signFacts, at: ms, chains: { [chain]: { chainId: [a, a], tries: [{ newest: [a, a],
 *  byNumber: [a, a] }], finalized: [a, a] } } }, each `a` an rpcAnswer ({ result } | { error } | { noAnswer }). */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  // a rule's line; its own verdict back, so a failed rule skips the rules that read past it
  const say = (ok, s) => {
    lines.push(`${ok ? "ok " : "BAD"} ${s}`);
    if (!ok) bad = true;
    return ok;
  };
  const pin = pinned(run?.sign?.index);
  say(pin !== null && pin.integrity === run.sign.sha384, "SIGN_HOST's served script is the one its index.html pins");
  say(run?.sign?.finalKey === true && run?.sign?.guard === true, "SIGN_HOST's note store writes EVM notes at the newest agreed block and never backs a finalized one out (evm-final/, \"it never backs out\")");
  const at = Number(run?.at);
  for (const chain of Object.keys(POOL_RPCS)) {
    const c = run?.chains?.[chain];
    const [h0, h1] = POOL_RPCS[chain].map(hostOf);
    const silent = (a) => a?.noAnswer !== undefined;
    const ids = c?.chainId ?? [];
    if (ids.some(silent)) {
      quiet = true;
      lines.push(`--  ${chain}: eth_chainId gave no answer on ${ids.map((a, k) => (silent(a) ? [h0, h1][k] : null)).filter(Boolean).join(" and ")}: INCONCLUSIVE`);
      continue;
    }
    if (!say(ids.length === 2 && ids.every((a) => typeof a?.result === "string" && Number(BigInt(a.result)) === CHAIN_IDS[chain]), `${chain}: ${h0} and ${h1} are chain ${CHAIN_IDS[chain]}`)) continue;
    const tries = Array.isArray(c.tries) ? c.tries : [];
    const last = tries.at(-1);
    if (last === undefined) {
      say(false, `${chain}: no newest block read`);
      continue;
    }
    if ([...(last.newest ?? []), ...(last.byNumber ?? [])].some(silent)) {
      quiet = true;
      lines.push(`--  ${chain}: the newest block read gave no answer on its try ${tries.length}: INCONCLUSIVE`);
      continue;
    }
    const tops = (last.newest ?? []).map((a) => a?.result);
    const blocks = (last.byNumber ?? []).map((a) => a?.result);
    if (!say(tops.length === 2 && tops.every((b) => b && typeof b.number === "string"), `${chain}: both name their newest block`)) continue;
    const n = BigInt(tops[0].number) < BigInt(tops[1].number) ? BigInt(tops[0].number) : BigInt(tops[1].number);
    const one = blocks.length === 2 && blocks.every((b) => b && typeof b.hash === "string" && BigInt(b.number) === n) && blocks[0].hash === blocks[1].hash && blocks[0].timestamp === blocks[1].timestamp;
    if (!say(one, `${chain}: ${h0} and ${h1} hold one block at ${n}${one ? ` (${blocks[0].hash.slice(0, 10)}…)` : ""}${tries.length > 1 ? `, on try ${tries.length} of ${LAG_TRIES}` : ""}`)) continue;
    const age = Math.round(at / 1000 - Number(BigInt(blocks[0].timestamp)));
    say(Number.isFinite(age) && age <= FRESH_S, `${chain}: the newest agreed block ${n} is ${age} s old, at most ${FRESH_S} s: money in it shows now`);
    const fin = (c.finalized ?? []).map((a) => a?.result);
    if (fin.length === 2 && fin.every((b) => b && typeof b.number === "string" && typeof b.timestamp === "string")) {
      const low = fin.reduce((x, y) => (BigInt(x.number) < BigInt(y.number) ? x : y));
      lines.push(`--  ${chain}: the finalized block ${BigInt(low.number)} is ${Number(BigInt(blocks[0].timestamp) - BigInt(low.timestamp))} s behind it (the wait this card removes)`);
    } else lines.push(`--  ${chain}: the finalized block not read on both`);
  }
  return { verdict: verdictOf(bad, quiet), lines };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One read of a chain as the wallet's evmAgreedBlock makes it, two blocks at one height read again. */
async function readChain(urls, fetchFn) {
  const both = (method, params) => Promise.all(urls.map((u) => rpcAnswer(u, method, params, { fetchFn })));
  const chainId = await both("eth_chainId", []);
  const tries = [];
  for (let i = 0; i < LAG_TRIES; i++) {
    const newest = await both("eth_getBlockByNumber", ["latest", false]);
    const t = { newest };
    tries.push(t);
    const tops = newest.map((a) => a?.result);
    if (!tops.every((b) => b && typeof b.number === "string")) break;
    const n = BigInt(tops[0].number) < BigInt(tops[1].number) ? BigInt(tops[0].number) : BigInt(tops[1].number);
    t.byNumber = await both("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]);
    const [x, y] = t.byNumber.map((a) => a?.result);
    if (!(x && y && x.hash !== y.hash)) break;
    await sleep(LAG_WAIT_MS);
  }
  const keep = (a) => (a?.result && typeof a.result === "object" ? { result: { number: a.result.number, hash: a.result.hash, timestamp: a.result.timestamp } } : a);
  for (const t of tries) {
    t.newest = t.newest.map(keep);
    if (t.byNumber) t.byNumber = t.byNumber.map(keep);
  }
  const finalized = (await both("eth_getBlockByNumber", ["finalized", false])).map(keep);
  return { chainId, tries, finalized };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${SIGN}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  const js = pin ? await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`) : "";
  const chains = {};
  for (const chain of Object.keys(POOL_RPCS)) chains[chain] = await readChain(POOL_RPCS[chain], fetchFn);
  return { sign: signFacts(index, js), at: Date.now(), chains };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${KEY}: ${v.verdict}`);
    process.exitCode = EXIT[v.verdict];
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exitCode = EXIT.ERROR;
  }
}
