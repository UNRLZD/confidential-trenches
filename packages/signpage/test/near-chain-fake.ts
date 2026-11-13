// One fake NEAR chain for the NEAR reads' tests (card near-quote-under-the-pace): W, its USDC and token, Rhea's
// exchange with two simple pools, and the JSON-RPC answer a provider gives to each of the reads the kit's
// readNearSwapPair, readNearHeld and readNearSwapWallet ask, at the final height or at a block_id. Nothing real.
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { NEAR_RHEA } from "../../kit/src/near/rhea.ts";

export const USDC = NEAR_NETWORKS.mainnet.usdc;
export const WRAP = NEAR_RHEA.mainnet.wrap;
export const EX = NEAR_RHEA.mainnet.exchange;
export const TOKEN = "token.rhealab.near";
export const AMOUNT = 5_000_000n;
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];

/** The chain: its height, W's state, the effects that show once it passes their height, and a provider's answer. */
export function chain() {
  const c = {
    height: 224_000_000,
    exists: false,
    nonce: 40,
    bal: new Map<string, bigint>([[USDC, AMOUNT]]),
    reg: new Set<string>([USDC]),
    // an effect that shows once the chain passes its height
    pending: [] as { at: number; run: () => void }[],
  };
  const pools: Record<number, unknown> = {
    9: { pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, TOKEN], amounts: ["50000000000", "500000000000000000000000"], total_fee: 30, shares_total_supply: "1", amp: 0 },
    4512: { pool_kind: "SIMPLE_POOL", token_account_ids: [USDC, WRAP], amounts: ["1100000000000", "230000000000000000000000000000"], total_fee: 30, shares_total_supply: "1", amp: 0 },
  };
  const later = (run: () => void) => c.pending.push({ at: c.height + 2, run });
  const tick = () => {
    c.height++;
    for (const p of c.pending.filter((x) => x.at <= c.height)) p.run();
    c.pending = c.pending.filter((x) => x.at > c.height);
  };
  const answer = (params: Record<string, unknown>) => {
    const height = "finality" in params ? c.height : (params.block_id as number);
    const base = { block_height: height, block_hash: `H${height}` };
    if (params.request_type === "view_access_key_list") {
      if (!c.exists) return { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "no account" } };
      return { jsonrpc: "2.0", id: "1", result: { ...base, keys: [{ public_key: `ed25519:${"1".repeat(32)}`, access_key: { nonce: c.nonce, permission: "FullAccess" } }] } };
    }
    if (params.request_type === "view_account") return { jsonrpc: "2.0", id: "1", result: { ...base, amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1, storage_paid_at: 0 } };
    const method = String(params.method_name);
    const contract = String(params.account_id);
    const args = JSON.parse(atob(String(params.args_base64)));
    let v: unknown;
    if (contract === EX && method === "metadata") v = { version: "1.9.21", state: "Running", wnear_id: WRAP };
    else if (contract === EX && method === "get_frozenlist_tokens") v = [];
    else if (contract === EX && method === "get_pool_by_ids") v = (args.pool_ids as number[]).map((i) => pools[i]);
    else if (contract === EX && method === "get_lostfound_token") v = "0";
    else if (method === "ft_balance_of") v = String(c.bal.get(contract) ?? 0n);
    else if (method === "storage_balance_of") v = c.reg.has(contract) ? { total: "1250000000000000000000", available: "0" } : null;
    else if (method === "storage_balance_bounds") v = { min: "1250000000000000000000", max: null };
    else return { jsonrpc: "2.0", id: "1", result: { ...base, error: "MethodNotFound", logs: [] } };
    return { jsonrpc: "2.0", id: "1", result: { ...base, logs: [], result: bytes(v) } };
  };
  return { c, later, tick, answer };
}
