// A provider URL's company and its name on /v1/health (card near-pair-on-keyed-providers): pure functions of a URL,
// kept apart from rpc.ts so the token watch (token-status/status.ts), which the vault's sandbox suite reads, imports
// them without rpc.ts's limits, slots and vendor tables. rpc.ts re-exports companyOf, operatorOf and providerName.

/**
 * A keyed URL's company as /v1/health names it: its host's last two labels (quiknode.pro, drpc.org, fastnear.com,
 * helius-rpc.com), an IP address or a one-label host as it is. Not the whole host: /v1/health answers 1 KB at most (the
 * kit's HELPER_V1_PATHS row), and twelve QuickNode endpoint names (about 45 characters each) would pass it; the company
 * is what one key per company needs to show.
 */
export function companyOf(host: string): string {
  const h = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(h) || h.startsWith("[")) return h;
  return h.split(".").slice(-2).join(".");
}
/** Each company's other domain, folded into the one companyOf names for it: dRPC's keyed endpoints are lb.drpc.live
 *  (drpc.org/docs/gettingstarted/firstrequest), its keyless ones *.drpc.org; Grove is Pocket Network Inc. renamed, so its
 *  *.rpc.grove.city portal is Pocket's, as the kit's EVM operator map counts it (packages/kit/src/trade/evm/rpc-operator.ts). */
const SAME_COMPANY: Readonly<Record<string, string>> = { "drpc.live": "drpc.org", "grove.city": "pocket.network" };
/** The company that runs a provider URL (companyOf, its other domains folded in): two answers "agree" only from two of
 *  these (review M1 of 424dce1e: dRPC's key 1 and key 2 are one operator answering twice). */
export function operatorOf(url: string): string {
  const c = companyOf(new URL(url).host);
  return SAME_COMPANY[c] ?? c;
}
/** A keyed name's key of several at one company, as /v1/health names it (" key2" for a chain's _DRPC_2), else none: each
 *  is its own account, so the live check counts each as its own keyed provider. */
export const keyTag = (name: string): string => {
  const n = /_DRPC_([1-9])$/.exec(name)?.[1];
  return n === undefined ? "" : ` key${n}`;
};
/** A URL with no part where a provider puts a key: no user, no password, no query value, no path segment of 16
 *  characters or more. */
export const isKeyless = (u: URL): boolean => u.username === "" && u.password === "" && [...u.searchParams.values()].every((v) => v === "") && u.pathname.split("/").every((s) => s.length < 16);
/** A provider as /v1/health names it (card near-pair-on-keyed-providers: X-Helper-Near-Pair): "<company's domain>[
 *  key<n>][ keyless]", the keyed lists' form less the state; never a path, a query or a key. `name`: the environment
 *  name it was set under. */
export const providerName = (name: string, url: string): string => {
  const u = new URL(url);
  return `${companyOf(u.host)}${keyTag(name)}${isKeyless(u) ? " keyless" : ""}`;
};

