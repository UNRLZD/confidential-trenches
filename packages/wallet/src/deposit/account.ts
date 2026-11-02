// U, the one-time NEAR account of one deposit, and the reads that say U is safe to sign from (card
// wallet-deposit-account; docs/plan1/wallet.md §2.4 step 7, W:416, and the vault paper's 2.10 (a), V:666-668, at
// research aa5bc1e). The device derives U = U_{s,i} by the kit's frozen path (../derive depositId, HKDF info
// "onetime/in" ‖ s ‖ i, W:64) and, once U exists, reads on two RPCs:
//   - U's key list: exactly U's own key, full access (an implicit account's id is the hex of that key, D18, D19);
//   - U's key nonce, from that list (the delegate signs nonce + 1, W:416);
//   - U's USDC by ft_balance_of, at or above the amount;
//   - USDC's code hash by view_account, equal to the kit's pin (VAULT_TOKEN_CODE_HASH);
//   - no halt: while USDC is halted, ft_balance_of itself fails with "FiatToken: paused" (research
//     proofs/g1-vault-gas/RESULT.md:153-156, run 20261026T162244Z), so that read is the halt read and such an error is
//     a halt, never a zero balance (W:416).
// Each read must answer on both RPCs and agree, and the six reads' block heights may spread by at most HEIGHT_SPREAD_MAX
// blocks; any failure, any disagreement, any RPC down and any bad input throws DepositAccountRefused, and nothing is
// signed. An empty key list is its own code, not_created: U is not made yet, so the device waits and reads again.
//
// The gap (V:667-668, SB run (4) not measured): a pending `Pause` multisig request on USDC cannot be read. The deployed
// USDC (321,491 B, sha256 b98ccd53…cfe6, code hash DVJx7F3d…) exports get_next_multisig_request_id and the request
// calls (create, approve, execute, remove) but no view of a request (its export list, read by view_code on
// rpc.mainnet.fastnear.com 2026-11-01T07:27Z at block 222537531), and view_state on it answers TOO_LARGE. So every
// answer says pendingPause: "unread". What bounds it: a halt that lands after U signs fails U's ft_transfer_call
// whole at its first receipt, before any USDC moves, and U keeps its USDC (V 2.5.1 case 2, V:275-283, measured with the
// real USDC wasm halted, RESULT.md:131 `halted_u_call_fails_whole`); the residual is a halt between the move and the
// resolve of a deposit the vault refuses (V 2.5.1 case 3, V:294-318). V 2.5.1 case 3's bound, "signs no call while a
// Pause request is pending", is therefore not true of this code (research docs/spec/11-merge-notes.md, M333). An open question for SB run (4)
// (review of 2026-11-01): approve_multisig_request called as a view panics "unwrap on None" for an unknown request id;
// a pending id may answer differently. Not used here.
//
// The network and the RPCs (NEAR_NETWORKS). The caller names the network, never the token: each network has one token
// and two operators. Mainnet: the release's RPC_A, RPC_B, RPC_C (M306 (5), research docs/spec/11-merge-notes.md:314; the
// sign page's CSP lists the same three). RPC_A and RPC_B are one operator, FastNEAR: their `status` answers carry the
// same node keys (read 07:59Z: Be6YJaMr… on both; read 08:02Z: 688aviNn…, E6qPW56a… and Be6YJaMr… on both,
// rotating), while RPC_C is dRPC's own nodes (368TikGm…, 3qsP9433…). Testnet: test.rpc.fastnear.com and
// rpc.testnet.near.org answered with one node key, vknQwA6g…, and near-testnet.drpc.org with Cz6fGcTA… (read
// 08:02Z). So the pair is exactly one FastNEAR URL and the dRPC URL of the network, by exact string; anything else is
// refused as input. The kit names the methods (HELPER_RPC_METHODS.near) but no provider. Retries on a busy answer are
// §2.9's (WU-08), not this file's: here one RPC down stops the deposit.
// Nothing here logs. No request carries a key or the words: each read names U or USDC only (§2.9 row 8, W:939).
import { HELPER_RPC_METHODS, VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { base58, base64 } from "@scure/base";
import { depositId } from "../derive/keys.ts";
import { NEAR_NETWORKS, NEAR_RPC_METHOD, type NearNetwork, nearPairNetwork, nearPairRule, type NearRpc } from "../../../kit/src/near/networks.ts";

// The networks, the pair rule and nearRpc live in the kit (packages/kit/src/near/networks.ts); every caller still imports them here.
export { NEAR_NETWORKS, NEAR_RPC_METHOD, NEAR_RPC_URLS, type NearNetwork, nearPairNetwork, nearPairRule, type NearRpc, nearRpc, RPC_TIMEOUT_MS } from "../../../kit/src/near/networks.ts";

/** The six reads' heights may spread by this many blocks at most (live spread measured by the review: 5-6). */
export const HEIGHT_SPREAD_MAX = 30;
/**
 * The one bound on two providers' "final": the reads' heights may spread HEIGHT_SPREAD_MAX blocks at most, so a
 * provider that names an old block as final cannot date a read, or pick the block both are read at, from the past.
 * Gives the refusal's words, or null within the bound.
 */
export function heightSpreadOver(heights: readonly (number | bigint)[]): string | null {
  const hs = heights.map((h) => BigInt(h));
  const top = hs.reduce((a, b) => (a > b ? a : b));
  const low = hs.reduce((a, b) => (a < b ? a : b));
  return top - low > BigInt(HEIGHT_SPREAD_MAX) ? `the reads' heights spread ${top - low} blocks, over ${HEIGHT_SPREAD_MAX}` : null;
}
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(NEAR_RPC_METHOD)) throw new Error(`"${NEAR_RPC_METHOD}" is not on the kit's NEAR method list`);
const HALT = "FiatToken: paused";

/** What no deposit's answer can say yet (the header): a pending Pause request on USDC is not readable on chain. */
export const PENDING_PAUSE = "unread" as const;

export type RefusalCode = "input" | "rpc" | "disagree" | "height" | "not_created" | "keys" | "nonce" | "halted" | "balance" | "code_hash";
export class DepositAccountRefused extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, detail: string) {
    super(`deposit stopped (${code}): ${detail}`);
    this.name = "DepositAccountRefused";
    this.code = code;
  }
}

/** U's public side: its 64-hex implicit id and its one key. The secret key stays with depositId's caller. */
export interface DepositAccountId {
  account: string;
  publicKey: string; // ed25519:<base58>
}
export interface DepositAccount extends DepositAccountId {
  nonce: number; // U's key nonce, equal on both RPCs; the delegate signs nonce + 1
  balance: bigint; // U's USDC in base units, equal on both RPCs, at or above the amount
  height: number; // the lower block height of every read, for max_block_height (W:416)
  codeHash: string; // USDC's code hash, equal to the kit's pin
  halted: false;
  pendingPause: typeof PENDING_PAUSE;
}

/** U_{s,i} at the kit's frozen path, public side only. */
export function depositAccount(seed64: Uint8Array, s: bigint, i: number): DepositAccountId {
  const u = depositId(seed64, s, i);
  u.secretKey.fill(0); // only the public side is used here; the signer derives its own copy after the reads
  return { account: u.id, publicKey: `ed25519:${base58.encode(u.publicKey)}` };
}

/** Derives U_{s,i} and reads it (checkDepositAccount). */
export function readDepositAccount(
  seed64: Uint8Array, s: bigint, i: number, amount: bigint, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc],
): Promise<DepositAccount> {
  return checkDepositAccount(depositAccount(seed64, s, i).account, amount, network, rpcs);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * The reads of W:416 for the account U (64 hex), the amount in USDC base units, on the network's token, through one
 * FastNEAR RPC and the dRPC RPC of that network (each NearRpc's name is its exact URL), in either order.
 */
export async function checkDepositAccount(
  account: string, amount: bigint, network: NearNetwork, rpcs: readonly [NearRpc, NearRpc],
): Promise<DepositAccount> {
  if (typeof account !== "string" || !HEX64.test(account)) throw new DepositAccountRefused("input", "U must be a 64-hex implicit account id");
  if (typeof amount !== "bigint" || amount < VAULT_CONSTANTS.MIN_DEPOSIT) throw new DepositAccountRefused("input", "the amount must be a bigint at or above MIN_DEPOSIT");
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new DepositAccountRefused("input", `unknown network ${String(network)}`);
  const net = NEAR_NETWORKS[network];
  if (nearPairNetwork(rpcs) !== network) throw new DepositAccountRefused("input", nearPairRule(network));
  const token = net.usdc;
  const publicKey = `ed25519:${base58.encode(Uint8Array.from(account.match(/../g)!, (h) => parseInt(h, 16)))}`;
  const args = base64.encode(new TextEncoder().encode(JSON.stringify({ account_id: account })));
  const reads = {
    keys: { request_type: "view_access_key_list", account_id: account, finality: "final" },
    balance: { request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args, finality: "final" },
    code: { request_type: "view_account", account_id: token, finality: "final" },
  };
  const kinds = Object.keys(reads) as (keyof typeof reads)[];
  const settled = await Promise.all(rpcs.map((r) => Promise.allSettled(kinds.map((n) => r.query(reads[n])))));
  const answers = settled.map((side, p) =>
    Object.fromEntries(
      side.map((s, k) => {
        if (s.status === "rejected") throw new DepositAccountRefused("rpc", `${rpcs[p].name} did not answer the ${kinds[k]} read`);
        return [kinds[k], s.value];
      }),
    ) as Record<keyof typeof reads, unknown>,
  );

  // The halt first: a "FiatToken: paused" error on either RPC's balance read is a halt, whatever the other says.
  for (const [p, a] of answers.entries()) {
    const err = isObj(a.balance) ? (a.balance.error ?? (isObj(a.balance.result) ? a.balance.result.error : undefined)) : undefined;
    if (err !== undefined && JSON.stringify(err).includes(HALT)) throw new DepositAccountRefused("halted", `${rpcs[p].name}: USDC is halted (${HALT})`);
  }

  let height = Number.MAX_SAFE_INTEGER;
  let top = 0;
  const result = (p: number, n: keyof typeof reads): Obj => {
    const a = answers[p][n];
    const r = isObj(a) ? a.result : undefined;
    if (!isObj(a) || a.error !== undefined || !isObj(r) || r.error !== undefined)
      throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the ${n} read failed`);
    const h = r.block_height;
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0) throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the ${n} read has no block height`);
    height = Math.min(height, h);
    top = Math.max(top, h);
    return r;
  };

  // The key list: [{ public_key, nonce, permission }] on each RPC, sorted, so the two compare as sets.
  const keyList = (p: number) => {
    const ks = result(p, "keys").keys;
    if (!Array.isArray(ks)) throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the keys read has no key list`);
    return ks
      .map((k) => {
        const ak = isObj(k) ? k.access_key : undefined;
        if (!isObj(k) || typeof k.public_key !== "string" || !isObj(ak) || ak.permission === undefined)
          throw new DepositAccountRefused("rpc", `${rpcs[p].name}: a malformed key in U's key list`);
        return { key: k.public_key, permission: JSON.stringify(ak.permission), nonce: ak.nonce };
      })
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  };
  const [ka, kb] = [keyList(0), keyList(1)];
  if (JSON.stringify(ka.map(({ key, permission }) => [key, permission])) !== JSON.stringify(kb.map(({ key, permission }) => [key, permission])))
    throw new DepositAccountRefused("disagree", "the two RPCs disagree on U's key list");
  if (ka.length === 0) throw new DepositAccountRefused("not_created", "U has no key yet: not created, wait and read again");
  if (ka.length !== 1) throw new DepositAccountRefused("keys", `U has ${ka.length} keys, not only its own`);
  if (ka[0].key !== publicKey) throw new DepositAccountRefused("keys", "U's key is not U's own");
  if (ka[0].permission !== JSON.stringify("FullAccess")) throw new DepositAccountRefused("keys", "U's key is not a full-access key");

  if (ka[0].nonce !== kb[0].nonce) throw new DepositAccountRefused("disagree", "the two RPCs disagree on U's nonce");
  const nonce = ka[0].nonce;
  // The delegate signs nonce + 1, so both must be exact integers; JSON numbers past 2^53 are not.
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(nonce + 1))
    throw new DepositAccountRefused("nonce", `U's nonce ${String(nonce)} is not an exact integer`);

  const balanceOf = (p: number): bigint => {
    const bytes = result(p, "balance").result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255))
      throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the balance read has no bytes`);
    let v: unknown;
    try {
      v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes)));
    } catch {
      throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the balance is not JSON`);
    }
    if (typeof v !== "string" || !DIGITS.test(v)) throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the balance is not a decimal string`);
    return BigInt(v);
  };
  const [ba, bb] = [balanceOf(0), balanceOf(1)];
  if (ba !== bb) throw new DepositAccountRefused("disagree", "the two RPCs disagree on U's USDC balance");

  const hashOf = (p: number): string => {
    const h = result(p, "code").code_hash;
    if (typeof h !== "string") throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the code read has no code hash`);
    return h;
  };
  const [ha, hb] = [hashOf(0), hashOf(1)];
  if (ha !== hb) throw new DepositAccountRefused("disagree", "the two RPCs disagree on USDC's code hash");
  if (ha !== VAULT_TOKEN_CODE_HASH) throw new DepositAccountRefused("code_hash", `USDC's code hash ${ha} is not the pin`);

  // Every read is in (result() saw all six): a lagging RPC would date the delegate's window from a stale height.
  const spread = heightSpreadOver([top, height]);
  if (spread !== null) throw new DepositAccountRefused("height", spread);
  if (ba < amount) throw new DepositAccountRefused("balance", `U holds ${ba}, under the amount ${amount}`);
  return { account, publicKey, nonce, balance: ba, height, codeHash: ha, halted: false, pendingPause: PENDING_PAUSE };
}
