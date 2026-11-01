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
// Each read must answer on both RPCs and agree; any failure, any disagreement and any RPC down throws
// DepositAccountRefused, and nothing is signed.
//
// The gap (V:667-668, SB run (4) not measured): a pending `Pause` multisig request on USDC cannot be read. The deployed
// USDC (321,491 B, sha256 b98ccd53…cfe6, code hash DVJx7F3d…) exports get_next_multisig_request_id and the request
// calls (create, approve, execute, remove) but no view of a request (its export list, read by view_code on
// rpc.mainnet.fastnear.com 2026-11-01T07:27Z at block 222537531), and view_state on it answers TOO_LARGE. So every
// answer says pendingPause: "unread". What bounds it: a halt that lands after U signs fails U's ft_transfer_call
// whole at its first receipt, before any USDC moves, and U keeps its USDC (V 2.5.1 case 2, V:275-283, measured with the
// real USDC wasm halted, RESULT.md:131 `halted_u_call_fails_whole`); the residual is a halt between the move and the
// resolve of a deposit the vault refuses (V 2.5.1 case 3, V:294-318).
//
// The RPCs: the release's NEAR providers RPC_A, RPC_B, RPC_C (M306 (5), research docs/spec/11-merge-notes.md:314; the
// sign page's CSP lists the same three). The kit names the methods (HELPER_RPC_METHODS.near) but no provider; the
// caller passes two of these, from different operators. Retries on a busy answer and the move to the third provider
// are §2.9's (WU-08), not this file's: here one RPC down stops the deposit.
// Nothing here logs. No request carries a key or the words: each read names U or USDC only (§2.9 row 8, W:939).
import { HELPER_RPC_METHODS, VAULT_CONSTANTS, VAULT_TOKEN_CODE_HASH } from "@blindfill/kit";
import { base58, base64 } from "@scure/base";
import { depositId } from "../derive/keys.ts";

/** RPC_A, RPC_B, RPC_C (M306 (5)). */
export const NEAR_RPC_URLS = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org", "https://near.drpc.org"] as const;
const METHOD = "query";
if (!(HELPER_RPC_METHODS.near as readonly string[]).includes(METHOD)) throw new Error(`"${METHOD}" is not on the kit's NEAR method list`);
export const RPC_TIMEOUT_MS = 10_000;
const HALT = "FiatToken: paused";

/** What no deposit's answer can say yet (the header): a pending Pause request on USDC is not readable on chain. */
export const PENDING_PAUSE = "unread" as const;

/** One NEAR provider: runs a `query` with these params and gives back the JSON-RPC answer object. */
export interface NearRpc {
  name: string;
  query(params: Record<string, unknown>): Promise<unknown>;
}

/** A provider by URL. A status other than 200, a body that is not JSON or no answer in time throws. */
export function nearRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = RPC_TIMEOUT_MS): NearRpc {
  return {
    name: url,
    async query(params) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "blindfill", method: METHOD, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

export type RefusalCode = "rpc" | "disagree" | "keys" | "nonce" | "halted" | "balance" | "code_hash";
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
  return { account: u.id, publicKey: `ed25519:${base58.encode(u.publicKey)}` };
}

/** Derives U_{s,i} and reads it (checkDepositAccount). */
export function readDepositAccount(
  seed64: Uint8Array, s: bigint, i: number, amount: bigint, rpcs: readonly [NearRpc, NearRpc], token: string = VAULT_CONSTANTS.TOKEN,
): Promise<DepositAccount> {
  return checkDepositAccount(depositAccount(seed64, s, i).account, amount, rpcs, token);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * The reads of W:416 for the account U (64 hex) and the amount in USDC base units. `token` is the vault's token, the
 * kit's mainnet USDC unless a testnet vault names its own; its code must still be the kit's pin.
 */
export async function checkDepositAccount(
  account: string, amount: bigint, rpcs: readonly [NearRpc, NearRpc], token: string = VAULT_CONSTANTS.TOKEN,
): Promise<DepositAccount> {
  if (typeof account !== "string" || !HEX64.test(account)) throw new Error("U must be a 64-hex implicit account id");
  if (typeof amount !== "bigint" || amount < VAULT_CONSTANTS.MIN_DEPOSIT) throw new Error("the amount must be a bigint at or above MIN_DEPOSIT");
  if (!Array.isArray(rpcs) || rpcs.length !== 2 || rpcs[0] === rpcs[1] || rpcs[0].name === rpcs[1].name)
    throw new Error("two different RPCs are needed");
  const publicKey = `ed25519:${base58.encode(Uint8Array.from(account.match(/../g)!, (h) => parseInt(h, 16)))}`;
  const args = base64.encode(new TextEncoder().encode(JSON.stringify({ account_id: account })));
  const reads = {
    keys: { request_type: "view_access_key_list", account_id: account, finality: "final" },
    balance: { request_type: "call_function", account_id: token, method_name: "ft_balance_of", args_base64: args, finality: "final" },
    code: { request_type: "view_account", account_id: token, finality: "final" },
  };
  const names = Object.keys(reads) as (keyof typeof reads)[];
  const settled = await Promise.all(rpcs.map((r) => Promise.allSettled(names.map((n) => r.query(reads[n])))));
  const answers = settled.map((side, p) =>
    Object.fromEntries(
      side.map((s, k) => {
        if (s.status === "rejected") throw new DepositAccountRefused("rpc", `${rpcs[p].name} did not answer the ${names[k]} read`);
        return [names[k], s.value];
      }),
    ) as Record<keyof typeof reads, unknown>,
  );

  // The halt first: a "FiatToken: paused" error on either RPC's balance read is a halt, whatever the other says.
  for (const [p, a] of answers.entries()) {
    const err = isObj(a.balance) ? (a.balance.error ?? (isObj(a.balance.result) ? a.balance.result.error : undefined)) : undefined;
    if (err !== undefined && JSON.stringify(err).includes(HALT)) throw new DepositAccountRefused("halted", `${rpcs[p].name}: USDC is halted (${HALT})`);
  }

  let height = Number.MAX_SAFE_INTEGER;
  const result = (p: number, n: keyof typeof reads): Obj => {
    const a = answers[p][n];
    const r = isObj(a) ? a.result : undefined;
    if (!isObj(a) || a.error !== undefined || !isObj(r) || r.error !== undefined)
      throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the ${n} read failed`);
    const h = r.block_height;
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0) throw new DepositAccountRefused("rpc", `${rpcs[p].name}: the ${n} read has no block height`);
    height = Math.min(height, h);
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
  if (ka.length === 0) throw new DepositAccountRefused("keys", "U has no key yet (not created)");
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
      v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)));
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

  if (ba < amount) throw new DepositAccountRefused("balance", `U holds ${ba}, under the amount ${amount}`);
  return { account, publicKey, nonce, balance: ba, height, codeHash: ha, halted: false, pendingPause: PENDING_PAUSE };
}
