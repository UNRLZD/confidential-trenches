// The proxy's upstreams (markets paper H2.1, H7 row POST /v1/proxy/{vendor}/{path}): each vendor has a fixed base
// URL, the one header that carries its key, and an exact path allowlist. The proxy is never an open proxy: a path is
// served only when it equals an entry here byte for byte, and the caller never names a host.
//
// `method` is the upstream's: a GET entry forwards the caller's query string and no body; a POST entry forwards the
// caller's JSON body byte for byte and its query string. `cacheMs` is set only for public lists that are the same for
// every caller (H2.1 "Cached" column: token lists, never a quote, a build or a status); a per-user query such as a
// search is never cached, since a cache hit would tell one caller what another asked for.
// The four vendors are the kit's HELPER_PROXY_VENDORS (packages/kit/src/helper/v1.ts), imported from its public entry.
import { HELPER_PROXY_VENDORS, type HelperProxyVendor } from "@blindfill/kit";

export const VENDOR_NAMES = HELPER_PROXY_VENDORS;
export type VendorName = HelperProxyVendor;

export type Upstream = { method: "GET" | "POST"; cacheMs?: number };

export type Vendor = {
  base: string;
  /** The environment variable that holds the key on the host; never a file in the repo, never a request field. */
  env: string;
  /** The header that carries the key as it is. */
  header: string;
  paths: Readonly<Record<string, Upstream>>;
};

const GET: Upstream = { method: "GET" };
const POST: Upstream = { method: "POST" };

export const VENDORS: Readonly<Record<VendorName, Vendor>> = {
  // Jupiter (T2.1, D-S2, D-S3, D-S6, L-01): the swap build, and the public token lists Discover reads
  jupiter: {
    base: "https://api.jup.ag",
    env: "JUPITER_API_KEY",
    header: "x-api-key",
    paths: {
      "/swap/v2/build": GET,
      "/tokens/v2/search": GET,
      "/tokens/v2/recent": { method: "GET", cacheMs: 10_000 },
      "/tokens/v2/toptrending/5m": { method: "GET", cacheMs: 10_000 },
      "/tokens/v2/toptrending/1h": { method: "GET", cacheMs: 10_000 },
      "/tokens/v2/toptrending/6h": { method: "GET", cacheMs: 10_000 },
      "/tokens/v2/toptrending/24h": { method: "GET", cacheMs: 10_000 },
    },
  },
  // Relay (T3.1, LD8, L-10): quote/v2, the device's body passed through unchanged, and the request status
  relay: {
    base: "https://api.relay.link",
    env: "RELAY_API_KEY",
    header: "x-api-key",
    paths: {
      "/quote/v2": POST,
      "/intents/status/v3": GET,
    },
  },
  // LI.FI (the EVM fallback route, L-11): quote and status
  lifi: {
    base: "https://li.quest",
    env: "LIFI_API_KEY",
    header: "x-lifi-api-key",
    paths: {
      "/v1/quote": GET,
      "/v1/status": GET,
    },
  },
  // 1Click (NEAR Intents, L-12, D-X1, wallet D8): quote and status with the partner JWT, and the public token list
  oneclick: {
    base: "https://1click.chaindefuser.com",
    env: "ONECLICK_JWT",
    // the partner JWT "as `X-API-Key`" (docs.near-intents.org 1click-api/authentication.md, read 2026-11-01 03:12Z)
    header: "x-api-key",
    paths: {
      "/v0/quote": POST,
      "/v0/status": GET,
      "/v0/tokens": { method: "GET", cacheMs: 5_000 },
    },
  },
};
