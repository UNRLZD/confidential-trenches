#!/usr/bin/env node
// Live check of card robinhood-warm-tap-inside-2s: the mainnet signing page's Robinhood quote asks our helper's seat with
// its keyless providers, POST /v1/rpc/robinhood?keyed=alchemy (packages/kit/src/trade/evm/buy-unpinned.ts, Robinhood's
// venue `seat`), one company's key under a share of its own sized to the tap check's heaviest burst
// (apps/helper/src/rpc/rpc.ts SEAT_SHARE). Before it a
// warm Robinhood tap waited on the keyless four and took 2.7 to 24 s (the tap check's own quotes from the Mac, 26 Nov
// 15:0xZ); the tap check (evm-buy-and-sell-on-mainnet) judges each warm tap inside 2 s after every sign deploy. This
// reads, after every sign and helper deploy:
//   - SIGN_HOST's index.html and the /app.js it pins (its sha384): the served script names the seat's URL;
//   - the seat's CORS answer to the page's origin (the preflight of a JSON POST);
//   - the seat's head, with its answer's Server-Timing (the provider's name: the Alchemy key's alone) and RateLimit-Policy
//     (the caller's share at least TAP_BURST), then one block a few under it on the seat and on publicnode: one hash
//     (the seat and a keyless operator are a pair the page can trust when they agree);
//   - then TAP_BURST calls in the kit's batches of 3 in one of the helper's fixed 10 s windows, spread over SPREAD_MS.
// It passes when the script names the seat, the seat allows the page's origin, its answer came from the Alchemy key
// under a share of TAP_BURST or more, the pair agrees, and every post of the burst answers 200 with every call's
// answer. A 429 in the burst is a FAIL (the seat's share does not hold one page's heaviest taps); a 5xx or no answer is
// a provider down, INCONCLUSIVE, never a pass. About 100 posts to the seat (294 calls of eth_blockNumber at Alchemy's 10
// CU each) and one to publicnode, nothing signed, no money.
// After: sign helper
// Serial: evm-keyed 420 (its burst draws the helper's Robinhood Alchemy key, the keyed route's first URL, so it runs after the group's other Robinhood reads)
// Bundle: out the helper's Robinhood seat (its CORS answer to the page's origin, a mainnet read beside publicnode's, the heaviest tap burst in one 10 s window); the bundle's naming of the seat is held by packages/kit/test/evm-rh-seat.test.ts
//   node scripts/live-checks/robinhood-warm-tap-inside-2s.mjs [--record <file>]
//   node scripts/live-checks/robinhood-warm-tap-inside-2s.mjs --answer <file>     judge a recorded run, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> robinhood-warm-tap-inside-2s".
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, preflight, preflightRefuses, rpcAnswer, rpcBatchAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "robinhood-warm-tap-inside-2s";
export const SIGN = "https://confidential.unrealized.trade";
/** The seat as the page names it (the kit's Robinhood quote list; packages/kit/test/evm-rh-seat.test.ts holds it there). */
export const SEAT = "https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=alchemy";
export const KEYLESS = "https://robinhood-rpc.publicnode.com";
/** The environment name the seat's answers must come from: the Alchemy key (Server-Timing's rpc desc). */
export const SEAT_NAME = "ROBINHOOD_RPC_URL";
/** The tap check's heaviest coin's seat calls, a cold tap and three warm in about 13 s (NVDA, 26 Nov 15:5xZ). */
export const TAP_BURST = 294;
export const PER_POST = 3;
export const WINDOW_MS = 10_000;
const INTO_WINDOW_MS = 1_000;
export const SPREAD_MS = 7_000;
/** The pair read is this many blocks under the seat's head, so publicnode has it too. */
export const BACK = 5;

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** The caller's share a RateLimit-Policy names ("client";q=<n>;w=10), or null. */
export const clientShare = (policy) => {
  const m = /"client";q=(\d+);w=10\b/.exec(String(policy ?? ""));
  return m === null ? null : Number(m[1]);
};
/** The provider a Server-Timing names (rpc;dur=<ms>;desc="<name>"), or null. */
export const timingName = (timing) => /(?:^|,\s*)rpc;dur=\d+;desc="([^"]*)"/.exec(String(timing ?? ""))?.[1] ?? null;

/** The verdict on a run { index, app: { sha384, names }, preflight, head: { noAnswer? | error? | number, timing, policy },
 *  pair: { seat, keyless } each { noAnswer? | error? | hash }, burst: { posts: [{ i, status, ok, why? }] } }:
 *  { verdict, ok, lines, exit }. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const no = (m) => ((quiet = true), lines.push(`NO-ANSWER ${m}`));
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  say(pin !== undefined && pin === a?.app?.sha384, "the served /app.js is the one index.html pins");
  say((a?.app?.names ?? []).includes(SEAT), `the page's script names the seat ${SEAT}`);
  const p = a?.preflight;
  const off = preflightRefuses(SEAT, p, SIGN);
  if (off !== null) say(false, off);
  else if (p?.noAnswer !== undefined) no(p.noAnswer);
  else say(true, `the seat's preflight from ${SIGN}: ${p.status}, allow-origin ${p.acao}`);
  const h = a?.head;
  if (h?.noAnswer !== undefined) no(`the seat's head: ${h.noAnswer}`);
  else if (h?.error !== undefined || !Number.isSafeInteger(h?.number)) say(false, `the seat's head: ${h?.error !== undefined ? `error ${JSON.stringify(h.error).slice(0, 80)}` : "no block number"}`);
  else {
    const name = timingName(h.timing);
    say(name === SEAT_NAME, `the seat's head ${h.number} came from ${name ?? "no provider named"} (want ${SEAT_NAME}, the Alchemy key alone)`);
    const share = clientShare(h.policy);
    say(share !== null && share >= TAP_BURST, `the seat's share is ${share ?? "unnamed"} calls a 10 s window (RateLimit-Policy ${JSON.stringify(h.policy)}), want ${TAP_BURST} or more`);
  }
  const s = a?.pair?.seat;
  const k = a?.pair?.keyless;
  if (s?.noAnswer !== undefined || k?.noAnswer !== undefined) no(`the pair read: ${s?.noAnswer ?? k?.noAnswer}`);
  else if (s !== undefined || k !== undefined) {
    const same = typeof s?.hash === "string" && s.hash === k?.hash;
    say(same, same ? `the seat and publicnode agree on block ${a.pair.number} (${s.hash.slice(0, 12)})` : `the seat and publicnode disagree on block ${a?.pair?.number}: ${JSON.stringify({ seat: s?.hash ?? s?.error, publicnode: k?.hash ?? k?.error }).slice(0, 200)}`);
  }
  const posts = Array.isArray(a?.burst?.posts) ? a.burst.posts : [];
  const want = Math.ceil(TAP_BURST / PER_POST);
  const refused = posts.find((x) => x.status === 429);
  // a 4xx other than 429 is the helper refusing the seat (a helper without it answers 400), never a provider down
  const turned = posts.find((x) => !x.ok && Number.isInteger(x.status) && x.status >= 400 && x.status < 500 && x.status !== 429);
  const down = posts.find((x) => x.status !== 429 && !x.ok);
  if (refused) say(false, `the burst: post ${refused.i + 1} of ${want} (call ${refused.i * PER_POST + 1} of ${TAP_BURST}) refused 429: the seat does not give one page its heaviest taps in 10 s`);
  else if (turned) say(false, `the burst: post ${turned.i + 1} refused (${turned.why ?? `HTTP ${turned.status}`}): the helper does not serve the seat`);
  else if (down) no(`the burst: post ${down.i + 1} not served (${down.why ?? `HTTP ${down.status}`}): a provider down, not the share`);
  else if (posts.length !== want) say(false, `the burst: ${posts.length} posts recorded, the burst is ${want}`);
  else say(true, `the burst: ${TAP_BURST} calls in ${want} posts served in one 10 s window`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines, exit: EXIT[verdict] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => `0x${n.toString(16)}`;
/** One block's hash on `url`, kept small. */
async function blockAt(url, n, fetchFn) {
  const a = await rpcAnswer(url, "eth_getBlockByNumber", [hex(n), false], { fetchFn, redirect: "error" });
  if (a.noAnswer !== undefined) return { noAnswer: a.noAnswer };
  if (a.error !== undefined || a.result?.hash === undefined) return { error: a.error ?? "no block" };
  return { hash: a.result.hash };
}

/** One post of the burst, `n` calls in a batch as the kit sends them, asked once: a 429 is never retried away (the kit
 *  holds the seat on it), so the share is judged as the page meets it. */
async function burstPost(n, fetchFn) {
  const calls = Array.from({ length: n }, () => ["eth_blockNumber", []]);
  const a = await rpcBatchAnswer(SEAT, calls, { fetchFn, headers: { origin: SIGN }, redirect: "error", retry: false, timeoutMs: 10_000 });
  const ok = a.status === 200 && a.noAnswer === undefined && a.error === undefined && Array.isArray(a.answers) && a.answers.length === n && a.answers.every((x) => x?.noAnswer === undefined && x?.error === undefined && typeof x?.result === "string");
  if (ok) return { status: 200, ok };
  const miss = a.noAnswer ?? (a.error !== undefined ? JSON.stringify(a.error) : (a.answers ?? []).find((x) => x?.noAnswer !== undefined || x?.error !== undefined));
  return { status: a.status ?? null, ok: false, why: `HTTP ${a.status ?? "none"} ${typeof miss === "string" ? miss : JSON.stringify(miss ?? null)}`.slice(0, 160) };
}

/** Reads SIGN_HOST, the seat and publicnode as the page does. `clock` is the epoch ms (tests move it in `wait`). */
export async function read(fetchFn = fetch, { wait = sleep, clock = Date.now } = {}) {
  const index = await (await fetchFn(`${SIGN}/`, { signal: AbortSignal.timeout(20_000) })).text();
  const js = await (await fetchFn(`${SIGN}/app.js`, { signal: AbortSignal.timeout(20_000) })).text();
  // the kit writes the seat as a template on the helper's origin; the bundle may keep it so or inline it
  const named = js.includes(SEAT) || (js.includes("/v1/rpc/robinhood?keyed=alchemy") && js.includes("https://ct-api.unrealized.trade"));
  const run = { at: new Date(clock()).toISOString(), index, app: { sha384: sha384(js), names: named ? [SEAT] : [] } };
  run.preflight = await preflight(SEAT, SIGN, { fetchFn });
  const h = await rpcAnswer(SEAT, "eth_blockNumber", [], { fetchFn, redirect: "error", keep: ["server-timing", "ratelimit-policy"] });
  run.head = h.noAnswer !== undefined ? { noAnswer: h.noAnswer } : h.error !== undefined ? { error: h.error } : { number: typeof h.result === "string" ? Number.parseInt(h.result, 16) : null, timing: h.kept?.["server-timing"] ?? null, policy: h.kept?.["ratelimit-policy"] ?? null };
  if (Number.isSafeInteger(run.head.number)) {
    const n = run.head.number - BACK;
    run.pair = { number: n, seat: await blockAt(SEAT, n, fetchFn), keyless: await blockAt(KEYLESS, n, fetchFn) };
  }
  const now = clock();
  const start = Math.ceil((now - INTO_WINDOW_MS) / WINDOW_MS) * WINDOW_MS + INTO_WINDOW_MS + WINDOW_MS; // the next whole window
  await wait(Math.max(0, start - now));
  const want = Math.ceil(TAP_BURST / PER_POST);
  const posts = [];
  for (let i = 0; i < want; i++) {
    const left = start + Math.round((i * SPREAD_MS) / want) - clock();
    if (left > 0) await wait(left);
    const p = await burstPost(Math.min(PER_POST, TAP_BURST - i * PER_POST), fetchFn);
    posts.push({ i, ...p });
    if (!p.ok) break; // the burst's verdict is named: nothing more is sent
  }
  run.burst = { posts };
  return run;
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(run)}\n`);
    const v = judge(run);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}`);
    process.exit(v.exit);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
