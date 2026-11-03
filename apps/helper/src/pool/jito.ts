// The Jito bundle-only send for a mainnet tag 3 (card helper-pool-senders, M362 (4)). A tag 3 W signed can be made to
// fail on chain after its simulation passed (W moving its own lamports first, a race), and the helper's fee payer pays
// for every failure that lands. Sent bundle-only, a failing tag 3 never lands, so it costs nothing:
//   "For cost efficiency, you can enable revert protection by setting the query parameter bundleOnly=true. With this
//   setting, the transaction is sent exclusively as a single transaction bundle." (docs.jito.wtf/lowlatencytxnsend,
//   read 2026-11-03 02:20Z; "Jito enforces a minimum tip of 1000 lamports for bundles", the same page.)
// One send tries the regional block engines in turn, starting one further on each time so sends spread over them
// ("1 request per second per IP per region", the same page); a 429 or a transport failure goes to the next region, any
// other answer ends the try. Keyless: no x-jito-auth header.

/** The mainnet block engines (docs.jito.wtf/lowlatencytxnsend, read 2026-11-03 02:20Z), each bundle-only. */
export const SOLANA_JITO_BLOCK_ENGINES: readonly string[] = Object.freeze(
  ["mainnet", "amsterdam.mainnet", "dublin.mainnet", "frankfurt.mainnet", "london.mainnet", "ny.mainnet", "slc.mainnet", "singapore.mainnet", "tokyo.mainnet"].map(
    (h) => `https://${h}.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true`,
  ),
);
/** The least tip a bundle carries ("Jito enforces a minimum tip of 1000 lamports for bundles"). */
export const SOLANA_JITO_TIP_MIN = 1_000n;
/** How long one region gets before its try counts as a transport failure [design: a block engine answers in well under 1 s]. */
export const JITO_TIMEOUT_MS = 2_000;
const ANSWER_MAX = 16_384;

/** One whole try: accepted by a region, every region busy or refusing, or every region failing on transport. */
export type JitoSend = { kind: "ok"; region: string } | { kind: "busy" | "refused"; detail: string } | { kind: "transport"; detail: string };
export type JitoSender = { send(base64Tx: string, signature: string): Promise<JitoSend> };
export type JitoFetch = (url: string, init: RequestInit) => Promise<Response>;

type One = { kind: "ok" | "busy" | "transport" | "refused"; detail: string };

async function bounded(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > ANSWER_MAX) {
      void reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function jitoSender(opts: { regions?: readonly string[]; fetch?: JitoFetch; timeoutMs?: number } = {}): JitoSender {
  const regions = opts.regions ?? SOLANA_JITO_BLOCK_ENGINES;
  if (regions.length === 0) throw new Error("no block engine");
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? JITO_TIMEOUT_MS;
  let next = 0;
  async function one(url: string, b64: string, signature: string): Promise<One> {
    let r: Response;
    let text: string;
    try {
      r = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      text = await bounded(r);
    } catch (e) {
      return { kind: "transport", detail: String((e as Error)?.message ?? e).slice(0, 120) };
    }
    if (r.status === 429) return { kind: "busy", detail: "HTTP 429" };
    if (r.status >= 500) return { kind: "transport", detail: `HTTP ${r.status}` };
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      return { kind: "refused", detail: `HTTP ${r.status}, not JSON` };
    }
    const o = (typeof j === "object" && j !== null && !Array.isArray(j) ? j : {}) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (o.error !== undefined) {
      const msg = `${String(o.error?.code)}: ${String(o.error?.message).slice(0, 120)}`;
      return /rate.?limit|too many/i.test(msg) ? { kind: "busy", detail: msg } : { kind: "refused", detail: msg };
    }
    if (!r.ok) return { kind: "refused", detail: `HTTP ${r.status}` };
    if (o.result !== signature) return { kind: "refused", detail: "the answer is not this transaction's signature" };
    return { kind: "ok", detail: "" };
  }
  return {
    async send(b64, signature) {
      const start = next;
      next = (next + 1) % regions.length;
      let transportOnly = true;
      let last = "";
      for (let i = 0; i < regions.length; i++) {
        const url = regions[(start + i) % regions.length]!;
        const t = await one(url, b64, signature);
        if (t.kind === "ok") return { kind: "ok", region: url };
        if (t.kind === "refused") return { kind: "refused", detail: t.detail };
        if (t.kind === "busy") transportOnly = false;
        last = t.detail;
      }
      return transportOnly ? { kind: "transport", detail: last } : { kind: "busy", detail: last };
    },
  };
}
