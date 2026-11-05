// One JSON-RPC request that waits out a rate limit, shared by the money gate (scripts/ci/money-gate.mjs, where it was
// written) and the vault's live checks (scripts/live-checks/vault-skeleton.mjs, vault-testnet-t01.mjs,
// vault-testnet-t04.mjs, vault-mainnet.mjs), so every reader waits the same way, with the same bounds. It imports nothing
// and opens no connection itself: each caller hands it its fetch.

// A rate limit is waited out, never read as an answer: a public RPC may answer HTTP 429 (or code -429) with a
// Retry-After (near.org's archival RPC gave 43 s to 600 s, read 2026-10-31).
// A 429 waits its Retry-After seconds, or 2 s doubling when it gives none (or a date), and asks again, up to
// RATE_TRIES waits in a row; a Retry-After past RATE_CAP seconds is no answer at once. Other trouble (no reply, a
// reply that is not JSON, an HTTP error with no RPC error) is asked 3 times, 2 s and 4 s apart. Each host is asked
// at most once a second.
// A 429 is waited only while the host could add a second operator: once two operators have read a tx ok, or the
// host's own operator has, it is still asked once, but with rateWait off: its 429 is no answer at once (NOT_WAITED),
// never waited and never decisive. A failed or old answer from it still refuses. One operator's read never passes a tx
// alone: a NEAR tx no second operator reads passes only by its light-client proof (proveNearTx), which needs no
// second read on the same operator.
export const RATE_TRIES = 5;
export const RATE_CAP = 600;
export const NOT_WAITED = "rate limited, not waited: its read could add no second operator";
export const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const lastAsked = new Map();
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null; // not a URL (a test's stub name): no host to pace
  }
};

// JSON with every integer past 2^53 kept as its digits: a NEAR tx JSON carries u64s JavaScript numbers cannot hold (a
// Delegate's max_block_height of u64::MAX, read 2026-11-01), and its bytes are rebuilt from them (findTxBytes). Node 24's
// JSON.parse hands a reviver each value's source text.
export const exactJson = (text) => JSON.parse(text, (k, v, ctx) => (typeof v === "number" && !Number.isSafeInteger(v) && /^\d+$/.test(ctx?.source ?? "") ? ctx.source : v));

// A rate limit, never an answer: HTTP 429; a JSON-RPC error code -429 or 429; or dRPC's free endpoint's answer, error
// code 15 with "You reached Public endpoint rate limit, please upgrade to paid plan", with whatever HTTP status it comes
// (its exact shape, captured from a real dRPC answer: scripts/live-checks/vault-testnet-t02.mjs isRateLimit).
export const isRateLimit = (status, j) =>
  status === 429 || j?.error?.code === -429 || j?.error?.code === 429 || (j?.error?.code === 15 && /rate limit/i.test(String(j?.error?.message ?? "")));

export async function rpc(fetchFn, url, method, params, sleep = wait, rateWait = true) {
  let last;
  let rate = 0;
  for (let attempt = 0; attempt < 3; ) {
    const host = hostOf(url);
    if (host) {
      const gap = (lastAsked.get(host) ?? 0) + 1000 - Date.now();
      if (gap > 0) await sleep(gap);
      lastAsked.set(host, Date.now());
    }
    try {
      const r = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = r.status === 429 ? null : typeof r.text === "function" ? exactJson(await r.text()) : await r.json();
      if (isRateLimit(r.status, j)) {
        if (!rateWait) throw Object.assign(new Error(NOT_WAITED), { rate: true, notWaited: true });
        const after = Number(r.headers?.get?.("retry-after") ?? NaN);
        if (Number.isFinite(after) && after > RATE_CAP) throw Object.assign(new Error(`rate limited, Retry-After ${after} s is past the ${RATE_CAP} s cap`), { rate: true });
        if (++rate > RATE_TRIES) throw Object.assign(new Error(`rate limited ${rate} times in a row`), { rate: true });
        await sleep(Number.isFinite(after) && after >= 0 ? after * 1000 : 2000 * 2 ** (rate - 1));
        continue;
      }
      if (!r.ok && !j.error) throw new Error(`HTTP ${r.status}`);
      return j;
    } catch (e) {
      if (e?.rate) throw e;
      last = e;
    }
    if (++attempt < 3) await sleep(2000 * attempt);
  }
  throw last;
}
