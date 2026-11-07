#!/usr/bin/env node
// Live check of card solana-jupiter-build (markets paper row M1.1, docs/plan1/markets.md l.3054; T2.1 l.291-336): the
// kit builds the paper's Solana swap shapes through HELPER_HOST's Jupiter proxy and assembles each on the device, at
// most 1,232 bytes, signing nothing. The shapes are the self-mode frames of T2.1 (06c S-1 buy and S-2 sell; P4's float
// shapes are gone in Plan 1, the fresh wallet pays and signs alone), each on two live tokens, so four:
//   S-1 buy and S-2 sell of a listed token: the first pump.fun token (the lane's subject, M1's end state) on the
//   helper's Solana Discover lists (GET /v1/market/lists?chain=solana, the read a device makes; Trending 1h first)
//   with at least $50k of liquidity, or --token;
//   S-1 buy and S-2 sell of a token with no route at 40: found at run time, never a fixed mint (one routes at 40 the
//   next day: 1znxCqDU…qyNd on 2026-11-06, live run 42135737951). The candidates are the helper's lists, New, then
//   Graduating, then the rest; each is asked as a device's trade, the buy, then the sell of what that buy quoted out,
//   and the first whose buy and sell both start with "No routes found" at 40 and end in a build that fits is the token.
//   Its two shapes are those asks themselves, never asked again (asked again a minute later, the same buy had no route
//   at 40, 48 or 60, and the sell that followed sold a stand-in amount that routes at 40: run 42135737951). A candidate
//   that routes at 40, or has no fitting route within the search's reach, is passed over; at most PROBES are asked, in
//   at most PROBE_CALLS calls. Or --no-route-token: that token's asks are the shapes, whatever they answer.
// Every shape is built as the device builds a trade (card solana-uncapped-fits): the kit's fetchSolanaJupiterBuildThatFits,
// the cap search judged on the device's own assembly (40, up on no route, down when over 1,232 bytes, at most 3
// builds), live and on replay. So the check asks only paths a device takes: the second token's shapes must start with
// "No routes found" at 40 and end in a build that fits, the first token's go as its route goes.
// A broken retry path is a FAIL, never hidden as a token passed over: when the search ends with no route, the check
// asks Jupiter itself at each of MARKET_CAPS the search did not ask (its own list, not the kit's), and a route there
// that fits makes that token the shapes, which then FAIL. A run where no candidate has the shape is its own verdict,
// INCONCLUSIVE (exit 3), said on its own line (card jupiter-build-budget-503: run 42188135355 ended "none of the shape"
// with nothing saying the retry path went unchecked), never a PASS; the judge holds it to every passed-over
// candidate's recorded answers.
// The check's Jupiter calls are a device's builds and its probes, each at least PACE_MS after the last, so one runner
// asks at most JUPITER_PER_MINUTE in any counted minute, what the helper lends a client on the total alone
// (apps/helper/src/limits/limits.ts LEND_FREE_SHARES x the share): the run is never past its own share or lent, so the
// helper's 429 (a caller past its own limit) never comes. The vendor's total can still be spent by every caller
// together in a minute, which the helper answers 503 upstream (limits.ts totalWait), and a shape then FAILs. Each
// call's send time is recorded and the judge holds the run to it. The taker
// is a random address nobody holds a key for, made per run (so no wallet is linked to the check).
// The device's reads come from two public RPCs: both mints and every lookup table any build names (processed), and the
// blockhash from getLatestBlockhash at finalized on the first (never the build's blockhashWithMetadata).
// It passes only when every shape: answers 200; parses; assembles at most 1,232 bytes on the device's own blockhash
// and tables; decodes back with that blockhash; and passes the quote checks on the frame the assembly builds (S2 tables,
// S3 programs, S4 signer, S5 transfers and tips, S8 compute budget, S9 size, S13 creates and closes) and on Jupiter's
// route and the token (S1 request match, S6 the output to the wallet's own account, S7 the floor, S10 the mint), on
// either route instruction /build answers: route_v2 (discriminator bb64facc31c4af14) or shared_accounts_route_v2
// (d19853937cfed8e9, which /build answers for many multi-hop routes). S7's minOut is the floor of the build's own
// outAmount at the slippage this check asked for, so the floor decoded from the signed bytes must be at least what was
// asked. S11 and S12 need a funded simulation and the reference pool, the buy flow's.
//   node scripts/live-checks/solana-jupiter-build.mjs [--base <helper origin>] [--token <mint>] [--no-route-token <mint>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (no candidate has no route at 40 and a fitting one).
//   --record writes every answer the run read, so the test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import {
  SOLANA_BUILD_TIMEOUT_MS,
  SOLANA_JUPITER_CAP_UP,
  SOLANA_JUPITER_MAX_BUILDS,
  SOLANA_MAX_TX_BYTES,
  SOLANA_SOL_MINT,
  assembleSolanaSwap,
  checkSolanaQuote,
  SolanaBuildError,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaJsonRpc,
  solanaMintDisagreement,
  solanaResolveKeys,
} from "../../packages/kit/src/index.ts";

const KEY = "solana-jupiter-build";
export const BASE = "https://ct-api.unrealized.trade";
/** A 503's cause entry in the helper's Server-Timing (apps/helper/src/proxy/proxy.ts Cause). */
export const CAUSE = /(^|,\s*)cause;desc="(429|held|budget|5xx|timeout|send|key|answer)"/;
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
export const SLIPPAGE_BPS = 1000;
/** Candidates asked to find one with no route at 40; 7 of 40 listed tokens had none on 2026-11-05 03:30Z. Card
 * jupiter-build-budget-503: 24 asked in 37 calls found none whose buy and sell both had it (run 42188135355, two
 * buys only), so up to 48, inside PROBE_CALLS: a candidate that routes at 40 is one call. */
export const PROBES = 48;
/** The most a candidate asks: each side's 3 builds and 2 market asks. */
export const CANDIDATE_CALLS = 2 * (3 + 2);
/** The candidates' Jupiter calls at most: 60 at PACE_MS is 8 min, inside the check job's 20 (live.yml check
 * timeout-minutes 20) with the listed shapes' 6 at most. A candidate is started only while CANDIDATE_CALLS stay. */
export const PROBE_CALLS = 60;
/** The steps past 40 the check asks Jupiter itself when the search ends with no route: the paper's (kit build.ts
 * SOLANA_JUPITER_CAP_UP comment: 48 routed 10 of 14 no-route-at-40 shapes, 60 the top), written here, not imported, so
 * a search that stops stepping up still meets a route the device should have built. */
export const MARKET_CAPS = [48, 60];
/** What the helper lends one client of Jupiter's a counted minute on the total alone, before it lends only while room
 * stays for others: LEND_FREE_SHARES 2 x the share 4 (apps/helper/src/limits/limits.ts, proxy.ts PROXY_BUDGETS). */
export const JUPITER_PER_MINUTE = 8;
/** The helper counts a draw to the end of its second plus the minute, so a counted minute spans up to 61 s. */
export const COUNTED_MINUTE_MS = 61_000;
/** One Jupiter call every 8 s: at most 8 in any 61 s (0, 8, ..., 56; the ninth at 64). */
export const PACE_MS = 8_000;
/** The most of `times` (ms) in any span of `span` ms. */
export function mostIn(times, span = COUNTED_MINUTE_MS) {
  const t = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] >= span) j++;
    most = Math.max(most, i - j + 1);
  }
  return most;
}
export const SHAPES = [
  { name: "S-1 buy, a listed token", side: "buy", token: "listed" },
  { name: "S-1 buy, a token with no route at 40", side: "buy", token: "noRoute" },
  { name: "S-2 sell, a listed token", side: "sell", token: "listed" },
  { name: "S-2 sell, a token with no route at 40", side: "sell", token: "noRoute" },
];
// The checks a build is judged by here; S11 and S12 need the buy flow's simulation and reference pool.
/** S6's and S11's reads of every account the tx writes (card solana-legs-checked), each as no account: the check's
 * wallet is a random address made per run, which owns none. `pairs` holds each table's two reads. */
export const noneWritten = (wire, pairs) =>
  Object.fromEntries(solanaResolveKeys(solanaDecodeTransaction(wire).message, Object.fromEntries(Object.entries(pairs).flatMap(([k, [a]]) => (a ? [[k, solanaDecodeLookupTable(a.data)]] : [])))).filter((k) => k.writable).map((k) => [k.key, [null, null]]));
export const JUDGED = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S13"];
// The route instruction by its Anchor discriminator, for the line only (the checks decode the bytes themselves).
const ROUTES = { bb64facc31c4af14: "route_v2", d19853937cfed8e9: "shared_accounts_route_v2" };
const ALT = "AddressLookupTab1e1111111111111111111111111";

// base58 of bytes (Bitcoin alphabet), for the per-run random taker only.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const accRead = (a) => (a ? { owner: a.owner, data: b64(a.data) } : null);
/** The mint line of a run: the two providers' reads of `mint` ({ owner, data: base64 } each) judged as S6 and S10 judge
 * them (the kit's solanaMintDisagreement), and said as they are: equal, the same but for the supply a burn moves (card
 * solana-mint-supply-moves), or the first field they differ in. [ok, text]. */
export function mintLine(label, mint, ma, mb) {
  if (!ma || !mb) return [false, `${label} ${mint} not read on both providers`];
  if (ma.owner === mb.owner && ma.data === mb.data) return [true, `${label} ${mint} read equal on both providers, owner ${ma.owner}`];
  const off = solanaMintDisagreement(accRead(ma), accRead(mb));
  if (off) return [false, `${label} ${mint}: the providers disagree on the mint's ${off}`];
  const supply = (a) => Buffer.from(a.data, "base64").readBigUInt64LE(36);
  return [true, `${label} ${mint} read on both providers, the same but for its supply (${supply(ma)} / ${supply(mb)}) or withheld fees, owner ${ma.owner}`];
}

// A fetch that answers the kit's build calls from a shape's recorded calls, in order, and refuses a call the kit makes
// that the record does not hold, so the replay runs the kit's own query, cap search and parse.
function replay(calls) {
  const left = [...calls];
  return async (url) => {
    const c = left.shift();
    if (!c) throw new Error(`the kit asked ${url}, past the recorded calls`);
    if (c.url !== url) throw new Error(`the kit asked ${url}, the record holds ${c.url}`);
    if (c.status === 0) throw new Error(c.error ?? "no answer");
    return new Response(c.body, { status: c.status, headers: { "content-type": "application/json" } });
  };
}

/** The device's assembly of one build on the record's reads: the cap search's judge. */
function assembler(r, req) {
  const [ma] = r.reads?.accounts?.[req.token] ?? [null];
  return (build) => {
    const tables = {};
    for (const t of build.tables) {
      const a = r.reads.accounts[t]?.[0];
      if (a && a.owner === ALT) {
        try { tables[t] = solanaDecodeLookupTable(b64(a.data)); } catch { /* not used: S2 then refuses if the message needs it */ }
      }
    }
    return assembleSolanaSwap(req, build, { blockhash: r.blockhash.blockhash, lastValidBlockHeight: r.blockhash.lastValidBlockHeight, tables, tokenProgram: ma?.owner });
  };
}

const capOf = (url) => Number(new URL(url).searchParams.get("maxAccounts"));
const stepsOf = (found) => found.steps.map((x) => `${x.maxAccounts} ${x.outcome === "fits" ? "fits" : x.outcome === "no_route" ? "no route" : `${x.size} bytes`}`).join(", ");

/** What one side's asks say of its token, from the search's end, its last answer and the market asks: "at40" (routes
 * at 40), "retry" (no route at 40, then a build that fits: the shape), "broken" (the search ended with no route where a
 * market ask fits), "none" (no fitting route within the search's reach), "refused" (Jupiter's own 400 other than "No
 * routes found", which the helper passes on as it is, e.g. "Missing token program for <mint>" on a mint minutes old,
 * read 2026-11-06 00:51Z; its 5xx the helper answers 503, apps/helper/src/proxy/proxy.ts l.321), "upstream" (any
 * other answer: the helper's 429 or 503, no answer, an answer the kit cannot read, an assembly that broke). */
export function kindOf({ found, err }, marketFits, last) {
  if (found) return found.steps[0]?.outcome === "no_route" ? "retry" : "at40";
  if (err instanceof SolanaBuildError && err.code === "no_route") return marketFits ? "broken" : "none";
  if (err instanceof SolanaBuildError && err.code === "too_large") return "none";
  if (err instanceof SolanaBuildError && err.code === "upstream" && last?.status === 400) return "refused";
  return "upstream";
}
const PASSED = { at40: "routes at 40", none: "no fitting route within the search's reach", refused: "Jupiter refuses the token" };

/** The kit's search on a side's recorded asks, on the record's reads: what it found, or the error it ended on. */
async function searchOn(r, req, calls) {
  try {
    return { found: await fetchSolanaJupiterBuildThatFits(r.base, req, assembler(r, req), { fetch: replay(calls ?? []) }) };
  } catch (e) {
    return { err: e };
  }
}
/** The first market ask that answers a route the device assembles within 1,232 bytes, said, or null. */
async function marketFit(r, req, market) {
  for (const c of market ?? []) {
    try {
      const f = await fetchSolanaJupiterBuildThatFits(r.base, req, assembler(r, req), { fetch: replay([c]), startAt: capOf(c.url), maxBuilds: 1 });
      return `maxAccounts=${f.maxAccounts} answers a route that fits in ${f.fitted.size} bytes`;
    } catch { /* no route, over 1,232 bytes or no answer: not a fit */ }
  }
  return null;
}

/** A verdict's exit code: PASS 0, FAIL 1, INCONCLUSIVE 3 (an error exits 2). */
export const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 3 };
/** The line an INCONCLUSIVE run says on its own: no candidate had the shape, so the retry path was not checked. */
export const inconclusiveLine = (n) => `INCONCLUSIVE no token with no route at 40 and a fitting one within the search's reach, buy and sell, among ${n} candidates: the device's retry path was not checked this run`;
/** The check on one recorded run: PASS, FAIL, or INCONCLUSIVE (no candidate had the shape, and nothing else is BAD). */
export async function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.shapes?.length === SHAPES.length && SHAPES.every((s, i) => r.shapes[i]?.name === s.name), `the four shapes: ${(r.shapes ?? []).map((s) => s.name).join("; ")}`);
  const none = !r.mints?.noRoute;
  if (none) lines.push(inconclusiveLine((r.probes ?? []).length));
  // every candidate passed over is held to its own recorded answers: a token of the shape, or one whose search broke,
  // is never passed over (a record from before candidates kept their answers has none to replay, and names its token)
  for (const p of r.probes ?? []) {
    if (p.chosen) continue;
    if (!Array.isArray(p.buy?.calls)) { if (none) say(false, `candidate ${p.mint}: no recorded answers`); continue; }
    const said = [];
    const side = async (name, s, amount) => {
      const req = { side: name, wallet: r.wallet, token: p.mint, amount, slippageBps: SLIPPAGE_BPS };
      const res = await searchOn(r, req, s.calls);
      const k = kindOf(res, res.err ? await marketFit(r, req, s.market) : null, s.calls?.at(-1));
      said.push(`${name} ${res.found ? stepsOf(res.found) : res.err.message}`);
      return k;
    };
    let k = await side("buy", p.buy, BUY_LAMPORTS);
    if (k === "retry" && /^[1-9]\d{0,19}$/.test(String(p.sell?.amount)) && Array.isArray(p.sell?.calls)) k = await side("sell", p.sell, BigInt(p.sell.amount));
    say(k in PASSED, `candidate ${p.mint}: ${said.join("; ")}: ${PASSED[k] ? `${PASSED[k]}, passed over` : `${k === "retry" ? "the token has the shape" : k === "broken" ? "the retry path is broken" : "its answers broke off"}, yet it was passed over`}`);
  }
  for (const kind of none ? ["listed"] : ["listed", "noRoute"]) {
    const mint = r.mints?.[kind];
    const [ma, mb] = r.reads?.accounts?.[mint] ?? [null, null];
    say(...mintLine(`${kind === "listed" ? "listed" : "no-route"} mint`, mint, ma, mb));
  }
  // each call once: a candidate's asks, its market asks, and the shapes' (the chosen token's are its shapes')
  const asked = (s) => [...(s?.calls ?? []), ...(s?.market ?? [])].map((c) => c.sentAt);
  const sent = [...(r.probes ?? []).flatMap((p) => p.sentAt ?? [...asked(p.buy), ...asked(p.sell)]), ...(r.shapes ?? []).flatMap(asked)];
  const most = mostIn(sent.filter(Number.isFinite));
  say(sent.length > 0 && sent.every(Number.isFinite) && most <= JUPITER_PER_MINUTE, `the run's ${sent.length} Jupiter calls, at most ${most} in a counted minute (the helper lends ${JUPITER_PER_MINUTE} on the total alone)${sent.every(Number.isFinite) ? "" : ", some with no send time"}`);
  const bh = r.blockhash;
  say(!!bh && typeof bh.blockhash === "string" && Number.isSafeInteger(bh.lastValidBlockHeight), `the device's blockhash at finalized: ${bh?.blockhash} valid to height ${bh?.lastValidBlockHeight}`);
  for (const [i, s] of (r.shapes ?? []).entries()) {
    const want = SHAPES[i];
    const at = `${s.name}:`;
    if (!want || s.name !== want.name) { say(false, `${at} not a shape of this check`); continue; }
    if (want.token === "noRoute" && none) continue;
    if (s.skipped) { say(false, `${at} not asked: ${s.skipped}`); continue; }
    // card helper-page-jup-429: a 503 the helper answers names its cause (429, held, budget, 5xx, timeout, send, key,
    // answer) in Server-Timing; a bare one (live run 42143211092 at 01:21Z) is its own failure
    const bare = [...(s.calls ?? []), ...(s.market ?? [])].filter((c) => c.status === 503 && !CAUSE.test(c.timing ?? ""));
    if (bare.length > 0) say(false, `${at} ${bare.length} helper 503 with no cause in Server-Timing (a bare 503)`);
    const token = r.mints?.[want.token];
    const req = { side: want.side, wallet: r.wallet, token, amount: BigInt(r.amounts?.[want.token]?.[want.side] || "0"), slippageBps: SLIPPAGE_BPS };
    let found;
    try {
      found = await fetchSolanaJupiterBuildThatFits(r.base, req, assembler(r, req), { fetch: replay(s.calls ?? []) });
    } catch (e) {
      const last = (s.calls ?? []).at(-1);
      // the market asks the check made itself: a route there that fits is one the search should have built
      const m = want.token === "noRoute" ? await marketFit(r, req, s.market) : null;
      const why = `${last?.timing ? `; Server-Timing ${String(last.timing).slice(0, 200)}` : ""}${last?.retryAfter ? `; Retry-After ${String(last.retryAfter).slice(0, 8)}` : ""}`;
      say(false, `${at} ${e instanceof SolanaBuildError ? e.message : `replay: ${e.message}`}${last ? ` (HTTP ${last.status} ${String(last.body).slice(0, 80)}${why})` : ""}${m ? `; ${m}: the retry path is broken` : ""}`);
      continue;
    }
    if (s.calls.length !== found.calls.length) { say(false, `${at} ${s.calls.length} recorded calls, the kit made ${found.calls.length}`); continue; }
    const steps = stepsOf(found);
    // the second token's shapes are the device's retry path: they must start with "No routes found" at 40
    if (want.token === "noRoute" && found.steps[0]?.outcome !== "no_route") { say(false, `${at} the token routes at 40 (${steps}), so this is not the retry path`); continue; }
    const tx = found.fitted;
    const dec = solanaDecodeTransaction(tx.wire);
    const sameHash = dec.message.blockhash === bh.blockhash;
    const build = found.build;
    // S7's minOut: the fitting build's outAmount at the asked slippage, rounded down (read from the answer, so checked
    // as a bounded integer first)
    let out;
    try { out = JSON.parse(s.calls.at(-1).body).outAmount; } catch { out = undefined; }
    if (!/^[1-9]\d{0,19}$/.test(String(out))) { say(false, `${at} outAmount ${String(out).slice(0, 40)} is not a positive integer`); continue; }
    const minOut = (BigInt(out) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    const kind = ROUTES[Buffer.from(build.swap.data).subarray(0, 8).toString("hex")] ?? "an unknown Jupiter instruction";
    const pairs = Object.fromEntries(build.tables.map((t) => [t, (r.reads.accounts[t] ?? [null, null]).map(accRead)]));
    const [ma, mb] = r.reads.accounts[token] ?? [null, null];
    const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut }, {
      tables: pairs,
      mint: [accRead(ma), accRead(mb)],
      rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
      simulations: [null, null],
      writable: noneWritten(tx.wire, pairs),
      reference: null,
    });
    const off = v.results.filter((x) => JUDGED.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`);
    const ms = s.calls.reduce((n, c) => n + c.ms, 0);
    const ok = tx.size <= SOLANA_MAX_TX_BYTES && sameHash && off.length === 0;
    say(ok, `${at} ${tx.size} bytes (limit ${SOLANA_MAX_TX_BYTES}), caps ${steps}, route ${build.route.join(" + ")} by ${kind}, ${dec.message.instructions.length} instructions, ${tx.tablesUsed.length} table(s), CU limit ${tx.cuLimit}, builds ${Math.round(ms)} ms${sameHash ? "" : `, blockhash ${dec.message.blockhash} is not the device's`}${off.length ? `; refused: ${off.join("; ")}` : `; ${JUDGED.join(",")} pass`}`);
  }
  const bad = lines.length === 0 || lines.some((l) => l.startsWith("BAD"));
  const verdict = bad ? "FAIL" : none ? "INCONCLUSIVE" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

async function get(base, path) {
  const r = await fetch(`${base}${path}`, { redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  return { status: r.status, body: await r.text() };
}

/** The run's reads. `sleep` and `now` are the pace's clock (a test's own; real time otherwise). */
export async function read({ base = BASE, token, noRouteToken, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => Date.now() } = {}) {
  base = base.replace(/\/$/, "");
  const readAt = new Date(now()).toISOString();
  const l = await get(base, "/v1/market/lists?chain=solana");
  if (l.status !== 200) throw new Error(`Solana lists: HTTP ${l.status}`);
  const lists = JSON.parse(l.body)?.lists ?? {};
  const rows = (keys) => keys.flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : [])).filter((t) => typeof t?.token === "string" && t.token !== SOLANA_SOL_MINT);
  if (!token) {
    const pick = rows(["trending_1h", "trending", "trending_5m", "graduating", "new"]).find((t) => t.launchpad === "pump.fun" && Number(t.liq_usd ?? 0) >= 50_000);
    if (!pick) throw new Error("no listed pump.fun token with $50k of liquidity");
    token = pick.token;
  }
  const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  // every Jupiter call of the run, paced; the kit's own calls, this fetch only keeps what each answered
  let last = -Infinity;
  const t0 = now();
  let count = 0;
  const paced = async (url, init) => {
    const wait = last + PACE_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    count++;
    const sentAt = last - t0;
    const t = performance.now();
    // the kit's own timeout, started after the pace's wait (the kit's signal was started before it)
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SOLANA_BUILD_TIMEOUT_MS) });
    const body = await res.text();
    return { url, status: res.status, body, ms: performance.now() - t, res, sentAt };
  };
  // a fetch for the kit that keeps every call it makes in `calls`, a call the helper did not answer (the kit's 5 s
  // timeout, a dropped connection) too, as status 0
  const keeper = (calls) => async (url, init) => {
    let c;
    try {
      c = await paced(url, init);
    } catch (e) {
      calls.push({ url, status: 0, body: "", ms: 0, sentAt: last - t0, error: String(e?.message ?? e).slice(0, 120) });
      throw e;
    }
    // card helper-page-jup-429: a non-200's Server-Timing (its cause, proxy.ts Cause) and Retry-After, so a red run is read
    const said = c.status === 200 ? {} : { timing: c.res.headers.get("server-timing"), retryAfter: c.res.headers.get("retry-after") };
    calls.push({ url: c.url, status: c.status, body: c.body, ms: c.ms, sentAt: c.sentAt, ...said });
    return new Response(c.body, { status: c.status, headers: { "content-type": c.res.headers.get("content-type") ?? "" } });
  };
  // the device's reads: the blockhash first, both mints and every table any build names as each build needs them
  const rpcAgain = (rpc) => Object.assign(async (m, p) => {
    // public RPCs answer 429 or time out under load: up to 4 tries each, 1, 2 and 4 s apart (a read, never a judgement)
    for (let i = 0; ; i++) {
      try { return await rpc(m, p); } catch (e) { if (i >= 3 || !/HTTP 429|timeout/i.test(e.message)) throw e; await sleep(1000 * 2 ** i); }
    }
  }, { url: rpc.url });
  const rpcs = RPCS.map((u) => rpcAgain(solanaJsonRpc(u)));
  const blockhash = await readSolanaBlockhash(rpcs[0]);
  // the device's cap search's judge: the assembly on reads made now (the judge assembles again on the record's)
  const live = { reads: { accounts: {} }, blockhash };
  const fitFor = (req) => async (build) => {
    const keys = [req.token, ...build.tables].filter((k) => !live.reads.accounts[k]);
    if (keys.length) Object.assign(live.reads.accounts, await readAccounts(rpcs, keys));
    return assembler(live, req)(build);
  };
  // one side of a trade asked as a device asks it, the kit's search; when it ends with no route, the market asks
  // at MARKET_CAPS it did not reach, up to the first that fits
  const ask = async (mint, side, amount) => {
    const req = { side, wallet, token: mint, amount, slippageBps: SLIPPAGE_BPS };
    const s = { amount: amount.toString(), calls: [], market: [] };
    let res;
    try { res = { found: await fetchSolanaJupiterBuildThatFits(base, req, fitFor(req), { fetch: keeper(s.calls) }) }; } catch (e) { res = { err: e }; }
    let fits = false;
    if (res.err instanceof SolanaBuildError && res.err.code === "no_route") {
      const reached = new Set(s.calls.map((c) => capOf(c.url)));
      for (const cap of MARKET_CAPS.filter((c) => !reached.has(c))) {
        try { await fetchSolanaJupiterBuildThatFits(base, req, fitFor(req), { fetch: keeper(s.market), startAt: cap, maxBuilds: 1 }); fits = true; break; } catch { /* judged on replay */ }
      }
    }
    let out = null;
    try { const o = JSON.parse(s.calls.at(-1)?.body ?? "{}").outAmount; if (res.found && /^[1-9]\d{0,19}$/.test(String(o))) out = String(o); } catch { /* none */ }
    return { s, kind: kindOf(res, fits, s.calls.at(-1)), out };
  };
  // a candidate: its buy, then the sell of what that buy quoted out, the size the sell shape sells; the first whose
  // two sides both take the retry path (or whose search broke) is the token, and its asks are its shapes
  const probes = [];
  let chosen = null;
  const candidate = async (mint) => {
    const buy = await ask(mint, "buy", BUY_LAMPORTS);
    const p = { mint, buy: buy.s };
    let k = buy.kind;
    let sell = null;
    if (k === "retry") {
      if (buy.out === null) { k = "upstream"; } else { sell = await ask(mint, "sell", BigInt(buy.out)); p.sell = sell.s; k = sell.kind; }
    }
    if (k in PASSED) { probes.push(p); return; }
    chosen = { mint, buy: buy.s, sell: sell?.s ?? null };
    probes.push({ mint, chosen: true });
  };
  if (noRouteToken) {
    // the token named: its asks are its shapes, whatever they answer
    const buy = await ask(noRouteToken, "buy", BUY_LAMPORTS);
    const sell = buy.out === null ? null : await ask(noRouteToken, "sell", BigInt(buy.out));
    chosen = { mint: noRouteToken, buy: buy.s, sell: sell?.s ?? null };
  } else {
    const seen = new Set([token]);
    for (const t of rows(["new", "graduating", "trending_1h", "trending", "trending_5m"])) {
      if (chosen || probes.length >= PROBES || count + CANDIDATE_CALLS > PROBE_CALLS) break;
      if (seen.has(t.token)) continue;
      seen.add(t.token);
      await candidate(t.token);
    }
  }
  const mints = { listed: token, noRoute: chosen?.mint ?? null };
  const amounts = { listed: { buy: BUY_LAMPORTS.toString(), sell: "" }, noRoute: { buy: BUY_LAMPORTS.toString(), sell: chosen?.sell?.amount ?? "" } };
  const shapes = [];
  for (const s of SHAPES) {
    if (s.token === "noRoute") {
      const side = s.side === "buy" ? chosen?.buy : chosen?.sell;
      shapes.push(side ? { name: s.name, calls: side.calls, market: side.market } : chosen ? { name: s.name, calls: [], skipped: "the buy built no route to sell" } : { name: s.name, calls: [] });
      continue;
    }
    if (s.side === "sell") {
      // the sell size: what the listed buy quoted out (a size only; nothing signed rests on it)
      let out;
      try { out = JSON.parse(shapes[0].calls.at(-1)?.body ?? "{}").outAmount; } catch { out = undefined; }
      amounts.listed.sell = /^[1-9]\d{0,19}$/.test(String(out)) ? String(out) : "1000000";
    }
    const req = { side: s.side, wallet, token, amount: BigInt(amounts.listed[s.side]), slippageBps: SLIPPAGE_BPS };
    const calls = [];
    await fetchSolanaJupiterBuildThatFits(base, req, fitFor(req), { fetch: keeper(calls) }).catch(() => {}); // judged on replay
    shapes.push({ name: s.name, calls });
  }
  // the reads the judge assembles on: both mints, every candidate's, and every table any answer names
  const names = new Set([mints.listed, ...(mints.noRoute ? [mints.noRoute] : []), ...probes.map((p) => p.mint)]);
  const answers = [...shapes.flatMap((s) => [...s.calls, ...(s.market ?? [])]), ...probes.flatMap((p) => [p.buy, p.sell].flatMap((x) => [...(x?.calls ?? []), ...(x?.market ?? [])]))];
  for (const c of answers) {
    try { for (const t of Object.keys(JSON.parse(c.body).addressesByLookupTableAddress ?? {}).slice(0, 8)) names.add(t); } catch { /* judged later */ }
  }
  const accounts = await readAccounts(rpcs, [...names]);
  return { base, readAt, mints, wallet, amounts, probes, shapes, reads: { rpcs: RPCS, accounts }, blockhash };
}

// Both providers' reads of the keys, at processed: at most 10 keys per getMultipleAccounts (solana-rpc.publicnode.com
// refuses more: "A maximum of 10 accounts is allowed", -32602, read 2026-11-02 05:55Z).
async function readAccounts(rpcs, keys) {
  const chunks = [];
  for (let i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
  const readAll = async (rpc) => {
    const value = [];
    for (const c of chunks) value.push(...(await rpc("getMultipleAccounts", [c, { encoding: "base64", commitment: "processed" }])).value);
    return value;
  };
  const reads = await Promise.all(rpcs.map(readAll));
  return Object.fromEntries(keys.map((k, i) => [k, reads.map((v) => (v[i] ? { owner: v[i].owner, data: v[i].data[0] } : null))]));
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token"), noRouteToken: opt("--no-route-token") });
    // `mints`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { verdict, lines } = await judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict} (${answer.base}, tokens ${answer.mints.listed} and ${answer.mints.noRoute ?? "none of the shape"})`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
