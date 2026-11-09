// Who runs an EVM RPC (card robinhood-mainnet-rpcs, review L-2): two reads count as two only when two operators answer
// them. One function for every place that pairs EVM RPCs: the kit's pool lists (their tests), the helper's
// POOL_EVM_RPCS_* check at its start, and the card's live check.
// - A host the curated map names is its operator. The map holds every EVM host of the money gate's map
//   (scripts/ci/rpc-operators.mjs, each cited there; a kit test holds the two to one answer) and the pool lists' own.
// - Any other host is its domain, the last two labels (robinhood.com, pocket.network), lower case, a trailing dot
//   dropped, or that domain's alias where one operator answers under another's domain (EVM_RPC_DOMAIN_ALIASES): by
//   domain, never by host, so a second host of an aliased domain is never a second operator. A two-part suffix (co.uk)
//   makes two operators read as one, which refuses a pair, never passes one.
// - An IP host is its address as the URL parser writes it (127.1 and 2130706433 are 127.0.0.1, [0:0:0:0:0:0:0:1] is
//   [::1]), an IPv4-mapped IPv6 address its IPv4 one; never its port.
// - Anything but an http or https URL has none (null).
import { deepFreeze } from "../../freeze.ts";

/** host -> operator, named by its own domain, the form a host the map leaves out gets, so the two never split one
 *  operator in two. */
// pure: an app that never asks for an operator (the signing page) bundles none of the map
export const EVM_RPC_OPERATORS: Readonly<Record<string, string>> = /* @__PURE__ */ deepFreeze({
  // the money gate's (scripts/ci/rpc-operators.mjs), Base, Robinhood and their test networks
  "mainnet.base.org": "base.org",
  "base.drpc.org": "drpc.org",
  "rpc.mainnet.chain.robinhood.com": "robinhood.com",
  "robinhood-rpc.publicnode.com": "publicnode.com",
  "sepolia.base.org": "base.org",
  "base-sepolia-rpc.publicnode.com": "publicnode.com",
  "rpc.testnet.chain.robinhood.com": "robinhood.com",
  "robinhood-sepolia-rpc.publicnode.com": "publicnode.com",
  // the pool lists' (buy-unpinned.ts poolProviders, feeProviders)
  "robinhood.api.pocket.network": "pocket.network",
  "robinhood.drpc.org": "drpc.org",
  "robinhood-testnet.drpc.org": "drpc.org",
  "base-rpc.publicnode.com": "publicnode.com",
  "base.api.pocket.network": "pocket.network",
});

/** domain -> the operator it answers for (card robinhood-mainnet-rpcs, delta review L-2): every host under it. */
export const EVM_RPC_DOMAIN_ALIASES: Readonly<Record<string, string>> = /* @__PURE__ */ deepFreeze({
  // Robinhood's own RPC is a CNAME of customer-origin.offchainlabs.com (dig rpc.mainnet.chain.robinhood.com,
  // 2026-11-07 02:5xZ): Offchain Labs runs its node, so no host of theirs is a second operator beside it
  "offchainlabs.com": "robinhood.com",
  // rpc.degenprotocol.io answers in Pocket's own words ("-32602: eth_getLogs block range too large (max 10001
  // blocks)", read 2026-11-07 01:46Z): counted as Pocket's, so none of its hosts pairs with Pocket
  "degenprotocol.io": "pocket.network",
});

const V4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** The operator of RPC `url`, or null when it is not an http or https URL. */
export function evmRpcOperator(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return null;
  const named = Object.hasOwn(EVM_RPC_OPERATORS, host) ? EVM_RPC_OPERATORS[host] : undefined;
  if (named !== undefined) return named;
  const m = V4_MAPPED.exec(host);
  if (m) {
    const n = (parseInt(m[1]!, 16) << 16) | parseInt(m[2]!, 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const domain = host.split(".").slice(-2).join(".");
  const alias = Object.hasOwn(EVM_RPC_DOMAIN_ALIASES, domain) ? EVM_RPC_DOMAIN_ALIASES[domain] : undefined;
  return alias ?? domain;
}
