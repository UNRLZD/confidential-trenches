// An EVM token's contract risk from GoPlus's keyless token_security API (https://api.gopluslabs.io/api/v1/token_security/
// {chainId}?contract_addresses=..., read 2026-11-14 04:05Z: Base, 8453, and Robinhood, 4663, each answered 200 in
// 0.4-0.8 s with no key; /api/v1/supported_chains lists both). It fills the EVM token page's grid cells no other source
// here reads (evm/token.ts): the honeypot check, the buy and sell tax, whether the contract can mint and whether it can
// pause or blacklist transfers (the EVM's freeze), and the creator's share; and the holders count and top 10 where
// GeckoTerminal's info gives none.
//
// Pace: GoPlus's free tier is "150 CU per minute" and "30k CU per day" (gopluslabs.io/security-api, read 2026-11-14
// 04:0xZ); three calls sent back to back from the Mac answered one non-JSON reply. One call every 2 s at most for the
// whole process (limits.ts HOST_PACE_MS, the paced fetch's schedule), each token's answer held RISK_MS: a token's
// contract flags change rarely, and a page opened again within it asks nothing. A page waits for a first read at most
// RISK_WAIT_MS; past it the page answers without these cells and the read lands for the next page read.
//
// Display only: nothing here feeds a signature (a buy's own route and quote are the device's reads). Every answer is
// hostile input: size bounded, the token's own key only, every flag exactly "0" or "1", every share a number in 0..1.
import { pacedFetch, type Fetch } from "./near/views.ts";

export const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security";
/** GoPlus's chain ids for the EVM chains the helper serves. */
export const GOPLUS_CHAIN: Readonly<Record<string, number>> = { base: 8453, robinhood: 4663 };
export const SRC = "goplus";
/** A token's answer is held this long. */
export const RISK_MS = 10 * 60_000;
/** A page waits at most this long for a token's first read [design: GoPlus answered in 0.4-0.8 s; the app reads an EVM
 *  token's page once (terminal token/source.ts following), so a first read that lands later shows on the next open]. */
export const RISK_WAIT_MS = 1_500;
const CACHE_MAX = 2_000;
const ANSWER_MAX = 512 * 1024;
const TIMEOUT_MS = 6_000;

/** The grid's cells GoPlus gives, each null when its answer names none. Shares in basis points. */
export type ContractRisk = {
  honeypot: boolean | null;
  tax: { buy_bps: number; sell_bps: number } | null;
  mint_auth: boolean | null;
  freeze_auth: boolean | null;
  dev_bps: number | null;
  holders: number | null;
  top10_bps: number | null;
  as_of_ms: number;
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** "1" true, "0" false, anything else unknown. */
const flag = (v: unknown): boolean | null => (v === "1" ? true : v === "0" ? false : null);
/** A share written as a fraction of 1 ("0.05" is 5%) as basis points, or null. */
function frac(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,3}(\.\d{1,30})?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 10_000) : null;
}

/** GoPlus's answer for `token` (lowercase 0x address) as the grid's cells, or null when it names no such token. */
export function contractRisk(answer: unknown, token: string, asOfMs: number): ContractRisk | null {
  const a = obj(answer);
  if (a.code !== 1) return null;
  const r = obj(obj(a.result)[token]);
  if (Object.keys(r).length === 0) return null;
  const buy = frac(r.buy_tax);
  const sell = frac(r.sell_tax);
  const paused = flag(r.transfer_pausable);
  const blacklist = flag(r.is_blacklisted);
  const holders = typeof r.holder_count === "string" && /^\d{1,12}$/.test(r.holder_count) ? Number(r.holder_count) : null;
  const top = Array.isArray(r.holders) ? r.holders.slice(0, 10).map((h) => frac(obj(h).percent)) : [];
  return {
    honeypot: flag(r.is_honeypot),
    tax: buy === null || sell === null ? null : { buy_bps: buy, sell_bps: sell },
    mint_auth: flag(r.is_mintable),
    // the EVM's freeze: the contract's admin can pause every transfer or blacklist an address
    freeze_auth: paused === true || blacklist === true ? true : paused === false && blacklist === false ? false : null,
    dev_bps: frac(r.creator_percent),
    holders,
    top10_bps: top.length > 0 && top.every((b) => b !== null) ? Math.min(10_000, top.reduce((s, b) => s! + b!, 0)!) : null,
    as_of_ms: asOfMs,
  };
}

export type GoPlusDeps = { fetch?: Fetch; now?: () => number; wait?: (ms: number) => Promise<void> };

export function createGoPlus(deps: GoPlusDeps = {}) {
  const fetchFn: Fetch = deps.fetch ?? pacedFetch();
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms).unref?.()));
  const held = new Map<string, { at: number; risk: ContractRisk | null }>();
  const reading = new Map<string, Promise<void>>();

  async function read(chain: string, token: string, key: string): Promise<void> {
    const id = GOPLUS_CHAIN[chain]!;
    const r = await fetchFn(`${GOPLUS}/${id}?contract_addresses=${token}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) throw new Error(`goplus ${r.status}`);
    const body = await r.text();
    if (body.length > ANSWER_MAX) throw new Error("goplus answer too large");
    const at = now();
    const risk = contractRisk(JSON.parse(body), token, at);
    if (!held.has(key) && held.size >= CACHE_MAX) held.delete(held.keys().next().value!);
    held.set(key, { at, risk });
  }

  return {
    /** The token's cells: held ones under RISK_MS at once; otherwise one read (shared by every caller), waited for at
     *  most RISK_WAIT_MS when nothing is held. Null when nothing good is held. */
    async risk(chain: string, token: string): Promise<ContractRisk | null> {
      if (!Object.hasOwn(GOPLUS_CHAIN, chain) || !/^0x[0-9a-f]{40}$/.test(token)) return null;
      const key = `${chain}:${token}`;
      const had = held.get(key);
      if (had !== undefined && now() - had.at <= RISK_MS) return had.risk;
      let p = reading.get(key);
      if (p === undefined) {
        p = read(chain, token, key)
          .catch(() => undefined)
          .finally(() => reading.delete(key));
        reading.set(key, p);
      }
      if (had !== undefined) return had.risk; // the held cells serve while the new read runs
      await Promise.race([p, wait(RISK_WAIT_MS)]);
      return held.get(key)?.risk ?? null;
    },
  };
}
export type GoPlus = ReturnType<typeof createGoPlus>;
