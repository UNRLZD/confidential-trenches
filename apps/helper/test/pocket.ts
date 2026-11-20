// Pocket's batch size, as every fake provider at its hosts answers it (card helper-rpc-batch-learns-reader-size).
// base.api.pocket.network and robinhood.api.pocket.network answer a JSON-RPC batch of more than 5 calls HTTP 413, plain
// text "request entity too large: the batch has more items than this window allows" (batches of 6 to 1,000 eth_chainId,
// read from the Mac 2026-11-18 20:41Z and again 23:20Z); 5 or fewer are answered. A fake that takes more holds nothing.

/** The most calls a batch Pocket answers. */
export const POCKET_MOST = 5;
const HOSTS = new Set(["base.api.pocket.network", "robinhood.api.pocket.network"]);

/** Pocket's refusal of a post of `n` calls to `url`, or null where it is no Pocket host or the batch is within 5. */
export function pocketRefusal(url: string, n: number): Response | null {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  if (!HOSTS.has(host) || n <= POCKET_MOST) return null;
  return new Response("request entity too large: the batch has more items than this window allows\n", { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The calls in a JSON-RPC post's body: its array's length, or 1. */
export const callsIn = (body: unknown): number => {
  const parsed: unknown = JSON.parse(String(body));
  return Array.isArray(parsed) ? parsed.length : 1;
};
