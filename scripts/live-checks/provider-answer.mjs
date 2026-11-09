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

import "../net-window.mjs";

// The kit's words, copied (they are module-private in packages/kit/src/checks/evm/quote.ts: `limited`, `notYet`,
// `stateless`); provider-answer.test.mjs fails when the kit's and these drift apart.
export const RATE_LIMIT = /request limit|rate limit|too many requests|exceeded its compute units per second/i;
export const NOT_YET = /(block|header).*not found|unknown block|unknown state/i;
export const STATELESS = /historical state \S+ is not available|archive requests require a personal token|^unknown state\b/i;
const LIMIT_CODES = new Set([429, -32005]);

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2, INCONCLUSIVE: 3 });
export const RPC_TIMEOUT_MS = 10_000;

const reverted = (e) => e?.code === 3 || (typeof e?.message === "string" && /^execution reverted/i.test(e.message));
const cut = (s, n = 80) => String(s).slice(0, n).replace(/\s+/g, " ");

/** One HTTP answer, read: `{ result }` or `{ error }` (a JSON-RPC error, judged by the check), or `{ noAnswer }` (why, with
 *  the host and status). `nullNoAnswer`: a null result is the provider not holding the thing yet (a block by number).
 *  `judgeStateMiss`: a block or state the provider does not hold is judged, for a check whose subject is that the
 *  provider keeps it (evm-buy-hookdata-fee: every fee provider answers a block 600 s old). */
export function classify(host, status, text, { nullNoAnswer = false, judgeStateMiss = false } = {}) {
  const no = (why) => ({ noAnswer: `${host} HTTP ${status}: ${why}` });
  if (status === 429) return no("429 Too Many Requests");
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
    if (!reverted(e) && (LIMIT_CODES.has(e?.code) || RATE_LIMIT.test(m))) return no(`rate limit ${cut(JSON.stringify(e))}`);
    if (!judgeStateMiss && !reverted(e) && (NOT_YET.test(m) || STATELESS.test(m))) return no(`no state for the read ${cut(JSON.stringify(e))}`);
    return { error: e };
  }
  if (status < 200 || status > 299) return no("not a success");
  if (j.result === null && nullNoAnswer) return no("null result (not held yet)");
  return { result: j.result };
}

/** The pause before a no-answer is read again, ms: past a provider's per-second limit ("25/second request limit
 *  reached", mainnet.base.org). The tests set it to 0. */
export const RETRY = { ms: 1000 };

/** One JSON-RPC read of `method` on `url`, read again once on a no-answer. */
export async function rpcAnswer(url, method, params, { fetchFn = fetch, timeoutMs = RPC_TIMEOUT_MS, nullNoAnswer = false, judgeStateMiss = false } = {}) {
  const host = new URL(url).host;
  const once = async () => {
    let r;
    try {
      r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { noAnswer: `${host}: no answer (${e?.cause?.code ?? e?.name ?? e?.message ?? e})` };
    }
    const text = await r.text().catch(() => "");
    return classify(host, r.status, text, { nullNoAnswer, judgeStateMiss });
  };
  const a = await once();
  if (a.noAnswer === undefined) return a;
  await new Promise((r) => setTimeout(r, RETRY.ms));
  return once();
}

/** The verdict of a check from its BAD lines and its no-answers: FAIL on any wrong answer, else INCONCLUSIVE where a
 *  group had fewer than two providers answering, else PASS. */
export function verdictOf(bad, quiet) {
  return bad ? "FAIL" : quiet ? "INCONCLUSIVE" : "PASS";
}
