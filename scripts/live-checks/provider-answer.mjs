// The one place a live check reads a chain provider's JSON-RPC answer (card live-checks-provider-no-answer). A provider
// that answers nothing usable is that provider's no-answer, named with its host and HTTP status, never a wrong answer
// and never a pass: the check judges on the providers that answered and is INCONCLUSIVE (exit 3) when fewer than two
// did. A no-answer is read again once. scripts/ci/live-checks-provider-answer.mjs refuses a live check that builds a
// JSON-RPC request anywhere else.
//
// A no-answer is: a fetch that failed or timed out; HTTP 429; an empty body; a body that is not JSON or not a JSON-RPC
// answer; a status outside 2xx with no JSON-RPC error inside; a JSON-RPC error that is a rate limit (codes 429 and
// -32005, or the kit's own words, RATE_LIMIT); a JSON-RPC error naming a block or state the provider does not hold yet or
// at all (the kit's NOT_YET and STATELESS: a lagging backend's "header not found", drpc's code 27 "Unknown state. First
// available state is 1", helper live run 42556116812, 9 Nov 03:54Z). A revert (code 3 or "execution reverted…") is
// never one of these: its string is the called contract's. Any other JSON-RPC error is an answer and is judged, on a
// status outside 2xx too (robinhood-rpc.publicnode.com answers a read past its state 403 with a JSON-RPC error inside).
// A lying provider can fake a no-answer and so make a check INCONCLUSIVE, never PASS.
// Runs: once, no check: the shared module the RPC-reading checks import; each of them runs after its own host's deploy

import "../net-window.mjs";

// The kit's words, copied (they are module-private in packages/kit/src/checks/evm/quote.ts: `limited`, `notYet`,
// `stateless`); provider-answer.test.mjs fails when the kit's and these drift apart.
export const RATE_LIMIT = /request limit|rate limit|too many requests|exceeded its compute units per second/i;
export const NOT_YET = /(block|header).*not found|unknown block|unknown state/i;
export const STATELESS = /historical state \S+ is not available|archive requests require a personal token|^unknown state\b/i;
/** The JSON-RPC codes that are a rate limit whatever their words, on every read. */
export const LIMIT_CODES = new Set([429, -32005]);
/** The page's Solana throttle codes (packages/kit/src/trade/solana/send.ts RPC_THROTTLE_CODES: -32029, -32429, -429 and
 *  dRPC's 15), a rate limit whatever their words in a page-mode read's 2xx only, as the page reads them (review of
 *  7921e919..9f6473ac P3-3; delta review P3-1: the EVM checks keep LIMIT_CODES alone). provider-answer.test.mjs fails
 *  when the kit's set and this one differ. */
export const PAGE_THROTTLE_CODES = new Set([-32029, -32429, -429, 15]);

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2, INCONCLUSIVE: 3 });
export const RPC_TIMEOUT_MS = 10_000;

const reverted = (e) => e?.code === 3 || (typeof e?.message === "string" && /^execution reverted/i.test(e.message));
const cut = (s, n = 80) => String(s).slice(0, n).replace(/\s+/g, " ");
/** A fetch that threw: a redirect (a read sent with `redirect: "error"`) named as one (review P3-2), else its code or name. */
const thrown = (host, e) =>
  /redirect/i.test(String(e?.cause?.message ?? ""))
    ? `${host}: no answer (it redirects, and a redirect is not followed: ${cut(e.cause.message)})`
    : `${host}: no answer (${e?.cause?.code ?? e?.name ?? e?.message ?? e})`;
/** A provider's passing fault: a 429 or a 5xx. */
const passing = (status) => status === 429 || (status >= 500 && status <= 599);

/** One HTTP answer, read: `{ result }` or `{ error }` (a JSON-RPC error, judged by the check), or `{ noAnswer }` (why, with
 *  the host and status). `nullNoAnswer`: a null result is the provider not holding the thing yet (a block by number),
 *  marked `nullResult`.
 *  `judgeStateMiss`: a block or state the provider does not hold is judged, for a check whose subject is that the
 *  provider keeps it (evm-buy-hookdata-fee: every fee provider answers a block 600 s old).
 *  `page`: the answer is read as the signing page's Solana reader reads it (send.ts): a 5xx is a passing fault before its
 *  body (delta review P2-1), and a throttle code (PAGE_THROTTLE_CODES) in a 2xx is a rate limit. */
export function classify(host, status, text, { nullNoAnswer = false, judgeStateMiss = false, page = false } = {}) {
  const no = (why) => ({ noAnswer: `${host} HTTP ${status}: ${why}` });
  if (status === 429) return no("429 Too Many Requests");
  if (page && status >= 500 && status <= 599) return no(`a passing fault (${cut(text, 40)})`);
  if (typeof text !== "string" || text.trim() === "") return no("empty body");
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return no(`not JSON (${cut(text, 40)})`);
  }
  if (j === null || typeof j !== "object" || Array.isArray(j) || !("result" in j || "error" in j)) return no("not a JSON-RPC answer");
  const e = j.error;
  if (e !== undefined && e !== null) {
    const m = typeof e?.message === "string" ? e.message : "";
    // a check that judges state misses judges one whatever else its words say ("... not available: rate limit tier")
    if (judgeStateMiss && !reverted(e) && (NOT_YET.test(m) || STATELESS.test(m))) return { error: e };
    const throttle = page && status >= 200 && status <= 299 && PAGE_THROTTLE_CODES.has(e?.code);
    if (!reverted(e) && (LIMIT_CODES.has(e?.code) || throttle || RATE_LIMIT.test(m))) return no(`rate limit ${cut(JSON.stringify(e))}`);
    if (!judgeStateMiss && !reverted(e) && (NOT_YET.test(m) || STATELESS.test(m))) return no(`no state for the read ${cut(JSON.stringify(e))}`);
    return { error: e };
  }
  if (status < 200 || status > 299) return no("not a success");
  if (j.result === null && nullNoAnswer) return { ...no("null result (not held yet)"), nullResult: true };
  return { result: j.result };
}

/** The pause before a no-answer is read again, ms: past a provider's per-second limit ("25/second request limit
 *  reached", mainnet.base.org). The tests set it to 0. */
export const RETRY = { ms: 1000 };

/** One JSON-RPC read of `method` on `url`, read again once on a no-answer. A read with its own `headers` (a page's
 *  Origin: wallet-restore-reads-ux.mjs asks as SIGN_HOST's page does) and `redirect` rule sends them, and gets the HTTP
 *  answer's `status` and Access-Control-Allow-Origin (`acao`) back beside it, for pageRefuses, and its answer is read in
 *  page mode (classify); a read without is as before. */
export async function rpcAnswer(url, method, params, { fetchFn = fetch, timeoutMs = RPC_TIMEOUT_MS, nullNoAnswer = false, judgeStateMiss = false, headers, redirect } = {}) {
  const host = new URL(url).host;
  const once = async () => {
    let r;
    try {
      r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
        ...(redirect === undefined ? {} : { redirect }),
      });
    } catch (e) {
      return { noAnswer: thrown(host, e) };
    }
    const text = await r.text().catch(() => "");
    const a = classify(host, r.status, text, { nullNoAnswer, judgeStateMiss, page: headers !== undefined });
    return headers === undefined ? a : { ...a, status: r.status, acao: r.headers.get("access-control-allow-origin") };
  };
  const a = await once();
  if (a.noAnswer === undefined) return a;
  await new Promise((r) => setTimeout(r, RETRY.ms));
  return once();
}

/** Why a page at `origin` gets nothing from this answer (`rpcAnswer` with the page's headers), or null. An HTTP answer
 *  whose Access-Control-Allow-Origin admits neither `origin` nor * is what the page really gets, a refusal, judged
 *  before the answer's kind and never a no-answer: api.mainnet-beta.solana.com's non-JSON 403 to an Origin header (card
 *  wallet-restore-reads-ux). No HTTP answer (a fetch that failed or timed out), a 429 and a 5xx (a provider's passing
 *  fault, whatever its headers: a gateway's 502 carries none; review P2-1) stay no-answers. An answer read without the page's headers
 *  carries no status and is refused, never taken as admitted. */
export function pageRefuses(url, a, origin) {
  if (a?.status === undefined || a?.status === null) return a?.noAnswer === undefined ? `${new URL(url).host}: not read from ${origin}` : null;
  if (passing(a.status) || a.acao === "*" || a.acao === origin) return null;
  return `${new URL(url).host} HTTP ${a.status}: ${origin} may not read its answer (Access-Control-Allow-Origin ${String(a.acao)})`;
}

const admits = (acao, origin) => acao === "*" || acao === origin;

/** The CORS preflight a page's browser sends before its JSON-RPC POST (its content-type, application/json, is not a
 *  simple one): OPTIONS with the page's Origin, POST and content-type asked for (review P3-1: a provider that admits the
 *  POST but refuses the preflight is one the page cannot read). Read again once on a passing fault (no answer, a 429, a
 *  5xx), then that fault is its `noAnswer`. Gives the status, Access-Control-Allow-Origin and -Allow-Headers. */
export async function preflight(url, origin, { fetchFn = fetch, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const host = new URL(url).host;
  const once = async () => {
    let r;
    try {
      r = await fetchFn(url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // a browser never follows a preflight's redirect: the page's refusal, not a no-answer (delta review P3-2)
      if (/redirect/i.test(String(e?.cause?.message ?? ""))) return { redirected: cut(e.cause.message) };
      return { noAnswer: thrown(host, e) };
    }
    await r.arrayBuffer().catch(() => {});
    const p = { status: r.status, acao: r.headers.get("access-control-allow-origin"), allowHeaders: r.headers.get("access-control-allow-headers") };
    return passing(r.status) ? { noAnswer: `${host} HTTP ${r.status}: the CORS preflight met a passing fault`, ...p } : p;
  };
  const a = await once();
  if (a.noAnswer === undefined) return a;
  await new Promise((r) => setTimeout(r, RETRY.ms));
  return once();
}

/** Why a page at `origin` may not send its JSON-RPC POST after this preflight (preflight()), or null: not a 2xx, an
 *  Access-Control-Allow-Origin that admits neither `origin` nor *, or an Access-Control-Allow-Headers naming neither
 *  content-type nor *; a redirect (a 3xx, or one the fetch refused) too, since a browser never follows a preflight's.
 *  A preflight's no-answer is null (the caller's no-answer); none read is a refusal. */
export function preflightRefuses(url, p, origin) {
  const host = new URL(url).host;
  if (p?.redirected !== undefined) return `${host}: its CORS preflight redirects (${p.redirected}), and a browser never follows a preflight's redirect`;
  if (p?.noAnswer !== undefined) return null;
  if (typeof p?.status !== "number") return `${host}: no CORS preflight read from ${origin}`;
  if (p.status < 200 || p.status > 299) return `${host} HTTP ${p.status}: refuses the CORS preflight from ${origin}`;
  if (!admits(p.acao, origin)) return `${host} HTTP ${p.status}: its CORS preflight does not admit ${origin} (Access-Control-Allow-Origin ${String(p.acao)})`;
  const allowed = String(p.allowHeaders ?? "").split(",").map((h) => h.trim().toLowerCase());
  if (!allowed.includes("content-type") && !allowed.includes("*")) return `${host} HTTP ${p.status}: its CORS preflight does not allow content-type (Access-Control-Allow-Headers ${String(p.allowHeaders)})`;
  return null;
}

/** The verdict of a check from its BAD lines and its no-answers: FAIL on any wrong answer, else INCONCLUSIVE where a
 *  group had fewer than two providers answering, else PASS. */
export function verdictOf(bad, quiet) {
  return bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
}
