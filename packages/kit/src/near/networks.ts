// The NEAR networks the release reads, and the one rule for a pair of their RPCs (split out of the wallet's deposit/account.ts
// by card signpage-withdraw-form, which re-exports all of it, and moved here by card app-verify-pair-rule so the kit's
// entry can export the pair rule without the kit importing the wallet). This module imports nothing: the signing page
// takes the table, the pair rule and nearRpc from here and so carries no kit code it does not use. Each
// network has one USDC contract (`usdc`, the vault's asset), the release's vault (null until written) and two
// operators: the pair is exactly one of its FastNEAR URLs and its dRPC URL (the wallet's deposit/account.ts header has the
// node-key reads that show the two FastNEAR URLs are one operator). What this file copies from the kit is held to it by
// test/near-networks.test.ts (this package): mainnet's usdc equals VAULT_CONSTANTS.TOKEN, and NEAR_RPC_METHOD is on
// HELPER_RPC_METHODS.near.

/** RPC_A, RPC_B, RPC_C (M306 (5)): mainnet. */
export const NEAR_RPC_URLS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"] as const;
Object.freeze(NEAR_RPC_URLS);
/**
 * One USDC contract and two operators per network. Its code must be VAULT_TOKEN_CODE_HASH on both: the testnet token
 * (contracts/vault/deployments/testnet-usdc.json, account_id) was deployed from mainnet USDC's own wasm (its wasm_from:
 * view_code of mainnet USDC on two RPCs, equal bytes), and its code_hash is DVJx7F3d… (the file; read on
 * test.rpc.fastnear.com and near-testnet.drpc.org 2026-11-01T08:02Z).
 */
export const NEAR_NETWORKS = {
  // vault: the release's vault on this network, the only receiver a deposit call names (wallet.md:898, "the vault id
  // written into the release"); null until the release writes one, and the device signs no deposit call there.
  // Mainnet: contracts/vault/deployments/mainnet-v1.json, account_id: the keyless vault deployed 7 Nov, registered on
  // mainnet USDC (scripts/live-checks/vault-mainnet-deploy.mjs reads both). Testnet: contracts/vault/deployments/testnet-v1.json,
  // account_id: a keyless vault whose config() names this token as its asset, registered on it (its registration_tx;
  // scripts/live-checks/vault-testnet-t01.mjs reads both).
  // usdc: the vault's asset, the token contract. Mainnet's is the kit's VAULT_CONSTANTS.TOKEN, copied here so the
  // signing page carries no kit code for it; test/near-networks.test.ts holds the two equal.
  // archival: the network's archival RPCs, read only for a tx both of the pair no longer keep (the wallet's moveout.ts
  // recordState: a held move out the pair forgot is read here before it is settled), every one asked and only an equal
  // word from all counted. One operator, FastNEAR (scripts/ci/near-rpc-operators.mjs): near.org's archival
  // first, the keyless public one the NEAR docs list (docs.near.org/api/rpc/providers), then FastNEAR's own, whose docs
  // call it paid. Both answered keyless with CORS * on 8 Nov 2026: `tx` with wait_until NONE read a 2 Nov testnet tx
  // FINAL and an unsent hash UNKNOWN_TRANSACTION, where the pair keeps about 100,000 to 230,000 mainnet blocks.
  mainnet: { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", vault: "vault.confidential.unrlzd.near", fastnear: [NEAR_RPC_URLS[0], NEAR_RPC_URLS[1]], drpc: NEAR_RPC_URLS[2], archival: ["https://archival-rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"] }, // near-rpc-operators: one operator (the archival list, every one asked)
  testnet: {
    usdc: "bf-usdc-20261101t022248.testnet", // gitleaks:allow (a public account id)
    vault: "vault.bf-vt-20261102t071444.testnet", // gitleaks:allow (a public account id)
    fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"], // near-rpc-operators: one operator (alternatives; the pair is one of these and drpc)
    drpc: "https://near-testnet.drpc.org",
    archival: ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"], // near-rpc-operators: one operator (the archival list, every one asked)
  },
} as const;
// Frozen, so no code on the page can point a network at another USDC contract, vault or RPC after load.
for (const net of Object.values(NEAR_NETWORKS)) Object.freeze(Object.freeze(net).fastnear), Object.freeze(net.archival);
Object.freeze(NEAR_NETWORKS);
export type NearNetwork = keyof typeof NEAR_NETWORKS;
export const RPC_TIMEOUT_MS = 10_000;
/** The one JSON-RPC method nearRpc sends; the wallet's test holds it to the kit's NEAR method list (HELPER_RPC_METHODS). */
export const NEAR_RPC_METHOD = "query";

/** One NEAR provider: runs a `query` with these params and gives back the JSON-RPC answer object; `signal` aborts it. */
export interface NearRpc {
  name: string;
  query(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

/** An HTTP answer that is not the provider's JSON-RPC one: its status, and its Retry-After in ms when it sent one. */
export type RpcHttpError = Error & { status: number; retryAfterMs?: number };
/** The error a provider's HTTP status throws (message "HTTP <status>"), with its Retry-After (seconds or a date) read. */
export function rpcHttpError(res: { status: number; headers: { get(name: string): string | null } }, now = Date.now()): RpcHttpError {
  const e = Object.assign(new Error(`HTTP ${res.status}`), { status: res.status }) as RpcHttpError;
  const ra = res.headers.get("retry-after")?.trim();
  if (ra) {
    const ms = /^[0-9]+$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - now;
    if (Number.isFinite(ms) && ms >= 0) e.retryAfterMs = ms;
  }
  return e;
}

/**
 * The network whose release pair `rpcs` is, or null: exactly one of its FastNEAR URLs and its dRPC URL, in either
 * order, each provider named by the exact URL it reads (nearRpc's name). The one rule for every path that reads NEAR
 * on two RPCs: two hosts of one operator are one read, so two of them, or any other name, give null.
 */
export function nearPairNetwork(rpcs: unknown): NearNetwork | null {
  if (!Array.isArray(rpcs) || rpcs.length !== 2) return null;
  const names = rpcs.map((r: unknown) => (typeof r === "object" && r !== null && typeof (r as NearRpc).query === "function" ? (r as NearRpc).name : undefined));
  for (const network of Object.keys(NEAR_NETWORKS) as NearNetwork[]) {
    const net = NEAR_NETWORKS[network];
    const fast = (n: unknown) => (net.fastnear as readonly unknown[]).includes(n);
    if ((fast(names[0]) && names[1] === net.drpc) || (names[0] === net.drpc && fast(names[1]))) return network;
  }
  return null;
}
/** The refusal's words for a pair that is not the network's (or, with none named, not any network's). */
export function nearPairRule(network?: NearNetwork): string {
  const nets = network === undefined ? (Object.keys(NEAR_NETWORKS) as NearNetwork[]) : [network];
  return `the RPCs must be one of ${nets.map((n) => `${NEAR_NETWORKS[n].fastnear.join(", ")} and ${NEAR_NETWORKS[n].drpc}`).join("; or ")}, exactly`;
}

/**
 * A provider by URL. A status other than 200 or 408 throws rpcHttpError (its status and Retry-After kept, so a reader
 * can tell a provider's "busy" from a wrong answer), as do a body that is not JSON and no answer in time. A 408's JSON
 * body is given back as the answer: dRPC's free plan answers a view it stopped for time that way, HTTP 408 with
 * {"error":{"message":"Request timeout on the free plan, please upgrade to paid plan","code":30}} (near.drpc.org and
 * near-testnet.drpc.org, read 2026-11-06 05:47Z), and the vault's page reads ask for the same page again after a wait
 * (the kit's vaultViewBusy); to every other reader it is a JSON-RPC error like any other.
 */
// `timeoutMs` null: the fetch bounds each request itself (the wallet's pacedFetch, whose deadline starts when the
// request's pace slot comes, so a wait in the pace queue never spends it: card wallet-id-reader-paced, delta review 2 P1)
export function nearRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs: number | null = RPC_TIMEOUT_MS): NearRpc {
  return {
    name: url,
    async query(params, signal) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: NEAR_RPC_METHOD, params }),
        signal: timeoutMs === null ? (signal ?? null) : signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200 && res.status !== 408) throw rpcHttpError(res);
      return await res.json();
    },
  };
}
