// The planted provider answers every RPC-reading live check's test replays (card live-checks-provider-no-answer): each
// kind of no-answer provider-answer.mjs must name and leave out, and the answers it must keep and judge. Test data only.
const rpcErr = (code, message) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });
const ok = (result) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

/** Each kind of no-answer: [name, HTTP status, body] */
export const NO_ANSWERS = Object.freeze([
  ["an empty body", 200, ""],
  ["a 429", 429, ""],
  ["a 429 with a JSON-RPC body", 429, rpcErr(-32000, "slow down")],
  ["not JSON", 200, "<html>bad gateway</html>"],
  ["not a JSON-RPC answer", 200, JSON.stringify({ ok: true })],
  ["a 502 with no JSON-RPC error", 502, "Bad Gateway"],
  ["a 500 with a result", 500, ok("0x1")],
  ["code 429", 200, rpcErr(429, "Too Many Requests")],
  ["code -32005", 200, rpcErr(-32005, "limit exceeded")],
  ["mainnet.base.org -32011 request limit reached (buy-unpinned.ts:241)", 200, rpcErr(-32011, "request limit reached")],
  ["mainnet.base.org 25/second request limit reached (quote.ts:4268)", 200, rpcErr(-32000, "25/second request limit reached")],
  ["blastapi compute units per second (quote.ts:4269)", 200, rpcErr(-32000, "Your app has exceeded its compute units per second capacity")],
  ["rate limit", 200, rpcErr(-32000, "rate limit exceeded")],
  ["too many requests", 200, rpcErr(-32000, "Too many requests, try later")],
  ["drpc code 27 Unknown state (helper live run 42556116812)", 200, rpcErr(27, "Unknown state. First available state is 1")],
  ["a lagging backend's header not found", 200, rpcErr(-32000, "header not found")],
  ["block not found", 200, rpcErr(-32000, "block not found: canonical hash")],
  ["unknown block", 200, rpcErr(-32000, "unknown block")],
  ["historical state not available", 200, rpcErr(-32000, "historical state 0xabc is not available")],
  ["a 403 with a state miss inside (robinhood-rpc.publicnode.com)", 403, rpcErr(-32000, "historical state 0xabc is not available")],
  ["a 403 with a rate limit inside", 403, rpcErr(-32000, "request limit reached")],
]);

/** A 403 that carries a real JSON-RPC error: judged, never a no-answer (review P3-2) */
export const JUDGED_403 = Object.freeze([403, rpcErr(-32601, "the method eth_call does not exist/is not available")]);

/** A fetch that answers `plant` (a [status, body]) for every read on `host` and `real(url, request)` elsewhere */
export function plantedFetch(host, plant, real) {
  return async (url, init) => {
    if (new URL(url).host === host) return new Response(plant[1], { status: plant[0] });
    return real(url, JSON.parse(init.body));
  };
}
