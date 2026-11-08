// BlockVectra's Robinhood reader is opt-in. No discovery, key lookup or Plans request happens here.
import type { Pace } from "../limits/limits.ts";

export const BLOCKVECTRA_URL = "https://api.blockvectra.com/v1/robinhood_mainnet";
export const BLOCKVECTRA_ENV = "ROBINHOOD_RPC_URL_BLOCKVECTRA";
const KEY_ENV = "ROBINHOOD_RPC_KEY_BLOCKVECTRA";
const DAY_ENV = "RPC_DAY_BLOCKVECTRA";
const PROFILE_ENV = "RPC_BLOCKVECTRA_PRICING_PROFILE";

// Public Plans captured 2026-11-08 16:20 UTC. A client budgeting snapshot, not installed prices,
// remaining allowance, a server cap or a billing guarantee. Operators can replace it explicitly.
const SNAPSHOT = {
  asOf: "2026-11-08T16:20:00Z",
  method_weights: [
    { method: "*", cu_weight: 10 },
    { method: "data.address_balances", cu_weight: 25 },
    { method: "data.address_transactions", cu_weight: 25 },
    { method: "data.address_transfers", cu_weight: 25 },
    { method: "data.block", cu_weight: 5 },
    { method: "data.block_by_hash", cu_weight: 5 },
    { method: "data.block_traces", cu_weight: 200 },
    { method: "data.block_transactions", cu_weight: 10 },
    { method: "data.chains", cu_weight: 1 },
    { method: "data.dex_prices", cu_weight: 15 },
    { method: "data.dex_swaps", cu_weight: 25 },
    { method: "data.nft", cu_weight: 5 },
    { method: "data.nfts_by_owner", cu_weight: 25 },
    { method: "data.status_freshness", cu_weight: 1 },
    { method: "data.stock", cu_weight: 15 },
    { method: "data.stocks", cu_weight: 15 },
    { method: "data.token", cu_weight: 5 },
    { method: "data.token_holders", cu_weight: 25 },
    { method: "data.token_transfers", cu_weight: 25 },
    { method: "data.tokens_batch", cu_weight: 10 },
    { method: "data.transaction", cu_weight: 5 },
    { method: "data.transaction_trace", cu_weight: 200 },
    { method: "debug_trace*", cu_weight: 100 },
    { method: "eth_blockNumber", cu_weight: 1 },
    { method: "eth_call", cu_weight: 15 },
    { method: "eth_chainId", cu_weight: 1 },
    { method: "eth_createAccessList", cu_weight: 20 },
    { method: "eth_estimateGas", cu_weight: 20 },
    { method: "eth_getBlockByNumber", cu_weight: 5 },
    { method: "eth_getBlockReceipts", cu_weight: 10 },
    { method: "eth_getLogs", cu_weight: 30 },
    { method: "eth_getProof", cu_weight: 10 },
    { method: "eth_sendRawTransaction", cu_weight: 30 },
    { method: "eth_simulateV1", cu_weight: 20 },
    { method: "eth_subscribe", cu_weight: 1 },
    { method: "eth_unsubscribe", cu_weight: 1 },
    { method: "push.address_day", cu_weight: 33 },
    { method: "push.history", cu_weight: 25 },
    { method: "push.log", cu_weight: 150 },
    { method: "push.native_transfer", cu_weight: 150 },
    { method: "push.token_transfer", cu_weight: 150 },
    { method: "trace_*", cu_weight: 100 },
    { method: "ws.logs", cu_weight: 30 },
    { method: "ws.newHeads", cu_weight: 5 },
  ],
};

/** Validate a replacement client profile. Dispatch is exact, then longest prefix, then `*`.
 * A positive wildcard is required: an unlisted method is never treated as free. */
export function blockvectraPrice(profile: unknown): (method: string) => number {
  const bad = () => new Error(`BlockVectra ${PROFILE_ENV} must contain asOf and unique positive method_weights including *`);
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) throw bad();
  const p = profile as { asOf?: unknown; method_weights?: unknown };
  if (typeof p.asOf !== "string" || !Number.isFinite(Date.parse(p.asOf)) || !Array.isArray(p.method_weights) || p.method_weights.length < 1 || p.method_weights.length > 256) throw bad();
  const weights = new Map<string, number>();
  for (const row of p.method_weights) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw bad();
    const { method, cu_weight: weight } = row as { method?: unknown; cu_weight?: unknown };
    if (typeof method !== "string" || !/^(?:\*|[a-zA-Z][a-zA-Z0-9_.]*(?:\*)?)$/.test(method) || weights.has(method) || !Number.isSafeInteger(weight) || (weight as number) <= 0) throw bad();
    weights.set(method, weight as number);
  }
  if (!weights.has("*")) throw bad();
  const prefixes = [...weights].filter(([m]) => m !== "*" && m.endsWith("*")).sort(([a], [b]) => b.length - a.length);
  return (method) => weights.get(method) ?? prefixes.find(([m]) => method.startsWith(m.slice(0, -1)))?.[1] ?? weights.get("*")!;
}

export type Blockvectra = { key: string; pace: Pace };
export function blockvectraFromEnv(env: Record<string, string | undefined>): Blockvectra | undefined {
  const names = [BLOCKVECTRA_ENV, KEY_ENV, DAY_ENV, PROFILE_ENV];
  if (names.every((n) => env[n] === undefined || env[n] === "")) return undefined;
  // Compare the original string: URL normalisation would erase an explicit :443, among other variants.
  if (env[BLOCKVECTRA_ENV] !== BLOCKVECTRA_URL) throw new Error(`BlockVectra ${BLOCKVECTRA_ENV} must be the exact Robinhood keyed endpoint`);
  const key = env[KEY_ENV];
  if (key === undefined || !/^[!-~]{8,512}$/.test(key)) throw new Error(`BlockVectra ${KEY_ENV} must be a nonempty header key without whitespace`);
  const day = env[DAY_ENV];
  if (day === undefined || !/^[1-9][0-9]{0,12}$/.test(day)) throw new Error(`BlockVectra ${DAY_ENV} must be an explicit positive whole number of CU a day`);
  let profile: unknown = SNAPSHOT;
  if (env[PROFILE_ENV] !== undefined && env[PROFILE_ENV] !== "") {
    try { profile = JSON.parse(env[PROFILE_ENV]!); } catch { throw new Error(`BlockVectra ${PROFILE_ENV} must be a JSON pricing profile`); }
  }
  return { key, pace: { perS: 100, burst: 400, unit: "call", batch: 1, group: "blockvectra", day: Number(day), methodCost: blockvectraPrice(profile) } };
}

/** Only a fully configured exact target can receive the key. Call sites also set redirect:error. */
export function blockvectraHeaders(config: Blockvectra | undefined, url: string): Record<string, string> {
  return config !== undefined && url === BLOCKVECTRA_URL ? { "x-api-key": config.key } : {};
}

/** A reflected key is a failed provider answer, never a value, error or statistic to publish. */
export function blockvectraLeaks(config: Blockvectra | undefined, text: string): boolean {
  if (config === undefined) return false;
  const key = config.key;
  const forms = [key, encodeURIComponent(key), Buffer.from(key).toString("base64").replace(/=+$/, ""), Buffer.from(key).toString("base64url")];
  const hasKey = (value: string) => forms.some((s) => value.includes(s));
  if (hasKey(text)) return true;
  // Compare decoded strings, not re-serialized JSON: quotes and backslashes in a key stay escaped there.
  if (!text.includes("\\")) return false;
  let leaked = false;
  try {
    JSON.parse(text, (name, value: unknown) => {
      if (hasKey(name) || (typeof value === "string" && hasKey(value))) leaked = true;
      return value;
    });
  } catch { return true; }
  return leaked;
}
