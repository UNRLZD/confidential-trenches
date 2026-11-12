// What the device reads of its fresh NEAR wallet W before W signs a Rhea classic swap, on both providers at one block
// (the quote's rule, ../../near/rhea.ts: each provider's final height, at most RHEA_QUOTE_LAG_MAX apart, every read at
// the lower one, the bytes and the block hash equal on both):
//   - W's key list: exactly W's own key (the implicit account's, nothing added), and its nonce: the delegates sign
//     nonce + 1, + 2, ... (the wallet's signNearSwapDelegates);
//   - ft_balance_of(W) on the token W sends: what W holds to sell or spend;
//   - storage_balance_of(W) and storage_balance_bounds on the token W receives: whether W must register first, and at
//     what deposit (nearSwapCalls' `registered` and `storageMin`);
//   - get_lostfound_token(W, the token W receives) on the exchange: a payout an earlier swap could not make, claimed
//     in the same run (nearSwapCalls' `lostfound`; account_lostfound.rs).
// A W the relayer has not created yet has no key list: refused "rpc", nothing to sign. Every answer is hostile: each
// field in its form, the key list W's alone, the bounds' min at most NEAR_SWAP_STORAGE_MAX.
import { NEAR_NETWORKS, nearPairNetwork, nearPairRule, type NearNetwork, type NearRpc } from "../../near/networks.ts";
import { answer, equalBytes, finalOf, json, NEAR_RHEA, nearFinal, rheaQuote, RheaQuoteRefused, view, type Answer, type NearFinal, type RheaQuote, type RheaQuoteArgs } from "../../near/rhea.ts";
import { deepFreeze } from "../../freeze.ts";
import { NEAR_SWAP_STORAGE_MAX } from "./swap.ts";

const IMPLICIT = /^[0-9a-f]{64}$/;
const U128_TEXT = /^(0|[1-9]\d{0,38})$/;
const U128_MAX = (1n << 128n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const u128 = (x: unknown): bigint | null => (typeof x === "string" && U128_TEXT.test(x) && BigInt(x) <= U128_MAX ? BigInt(x) : null);

/** ed25519:<base58 of the 32 key bytes>: the one key an implicit account's id names. */
function implicitKey(id: string): string {
  let n = BigInt(`0x${id}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (let i = 0; i < id.length && id.slice(i, i + 2) === "00"; i += 2) s = `1${s}`;
  return `ed25519:${s}`;
}

export type NearSwapWalletArgs = {
  network: NearNetwork;
  rpcs: readonly [NearRpc, NearRpc];
  wallet: string;
  side: "buy" | "sell";
  token: string;
  /** The two providers' final height already read (nearFinal, on these providers): W is read at it. */
  final?: NearFinal;
  signal?: AbortSignal;
};

/** W at one block on both providers. */
export type NearSwapWalletState = {
  account: string;
  height: number;
  blockHash: string;
  /** W's key nonce */
  nonce: bigint;
  /** W's balance of the token it sends (USDC on a buy, the token on a sell) */
  held: bigint;
  /** W is registered on the token it receives */
  registered: boolean;
  /** that token's storage_balance_bounds.min */
  storageMin: bigint;
  /** W's lost-found of that token on the exchange */
  lostfound: bigint;
};

export async function readNearSwapWallet(a: NearSwapWalletArgs): Promise<NearSwapWalletState> {
  const { network, rpcs, wallet, side, token, signal } = a;
  if (!(network in NEAR_RHEA)) throw new RheaQuoteRefused("input", `unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new RheaQuoteRefused("input", nearPairRule(network));
  if (typeof wallet !== "string" || !IMPLICIT.test(wallet)) throw new RheaQuoteRefused("input", "W is a 64-hex NEAR-implicit id");
  if (side !== "buy" && side !== "sell") throw new RheaQuoteRefused("input", "side is buy or sell");
  const usdc = NEAR_NETWORKS[network].usdc;
  if (typeof token !== "string" || token === usdc || token === "") throw new RheaQuoteRefused("input", "the token is not USDC");
  const exchange = NEAR_RHEA[network].exchange;
  const [sent, received] = side === "buy" ? [usdc, token] : [token, usdc];

  // the two final heights of one moment (nearFinal), every read after them at the lower
  const { height } = await finalOf(network, rpcs, a.final, signal);
  const at = { block_id: height };
  let blockHash = "";
  const same = (what: string, x: { height: number; hash: string }, y: { height: number; hash: string }) => {
    if (x.height !== height || y.height !== height) throw new RheaQuoteRefused("rpc", `${what}: an answer not at block ${height}`);
    if (x.hash !== y.hash || (blockHash !== "" && x.hash !== blockHash)) throw new RheaQuoteRefused("disagree", `${what}: two blocks at height ${height}`);
    blockHash = x.hash;
  };
  const both = async (what: string, params: Obj): Promise<unknown> => {
    const [x, y] = (await Promise.all(rpcs.map((r) => answer(r, params, signal)))) as [Answer, Answer];
    same(what, x, y);
    if (x.failed !== y.failed || !equalBytes(x.bytes, y.bytes)) throw new RheaQuoteRefused("disagree", `${what}: the providers' answers differ`);
    return json(x, what);
  };
  const keys = async (): Promise<bigint> => {
    const read = async (r: NearRpc) => {
      let v: unknown;
      try {
        v = await r.query({ request_type: "view_access_key_list", account_id: wallet, ...at }, signal);
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        throw new RheaQuoteRefused("rpc", `${r.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (isObj(v) && isObj(v.error)) throw new RheaQuoteRefused("rpc", `${r.name}: W's keys: ${String(v.error.message ?? v.error.name).slice(0, 200)}`);
      const res = isObj(v) ? v.result : undefined;
      if (!isObj(res) || !Number.isSafeInteger(res.block_height) || typeof res.block_hash !== "string") throw new RheaQuoteRefused("rpc", `${r.name}: W's keys: not a key list`);
      const list = res.keys;
      if (!Array.isArray(list) || list.length !== 1 || !isObj(list[0]) || list[0].public_key !== implicitKey(wallet) || !isObj(list[0].access_key) || list[0].access_key.permission !== "FullAccess")
        throw new RheaQuoteRefused("rpc", `${r.name}: W's keys are not its own key alone`);
      const n = list[0].access_key.nonce;
      const nonce = typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : typeof n === "string" && /^\d{1,20}$/.test(n) ? BigInt(n) : null;
      if (nonce === null || nonce > U64_MAX) throw new RheaQuoteRefused("rpc", `${r.name}: W's key nonce`);
      return { height: res.block_height as number, hash: res.block_hash, nonce };
    };
    const [x, y] = await Promise.all(rpcs.map(read));
    same("W's keys", x!, y!);
    if (x!.nonce !== y!.nonce) throw new RheaQuoteRefused("disagree", "W's key nonce differs");
    return x!.nonce;
  };
  const [nonce, bal, reg, bounds, lost] = await Promise.all([
    keys(),
    both("ft_balance_of", view(sent, "ft_balance_of", { account_id: wallet }, at)),
    both("storage_balance_of", view(received, "storage_balance_of", { account_id: wallet }, at)),
    both("storage_balance_bounds", view(received, "storage_balance_bounds", {}, at)),
    both("get_lostfound_token", view(exchange, "get_lostfound_token", { account_id: wallet, token_id: received }, at)),
  ]);
  const held = u128(bal);
  if (held === null) throw new RheaQuoteRefused("rpc", "ft_balance_of: not a u128");
  if (reg !== null && !(isObj(reg) && u128(reg.total) !== null)) throw new RheaQuoteRefused("rpc", "storage_balance_of: not a storage balance");
  const storageMin = isObj(bounds) ? u128(bounds.min) : null;
  if (storageMin === null || storageMin > NEAR_SWAP_STORAGE_MAX) throw new RheaQuoteRefused("rpc", "storage_balance_bounds: min missing or over the cap");
  const lostfound = u128(lost);
  if (lostfound === null) throw new RheaQuoteRefused("rpc", "get_lostfound_token: not a u128");
  return deepFreeze({ account: wallet, height, blockHash, nonce, held, registered: reg !== null, storageMin, lostfound });
}

/** W and the quote at one block: what W signs from and what it signs against. */
export type NearSwapPair = { state: NearSwapWalletState; quote: RheaQuote; /** with `baseline`: what W holds of it at the block */ baseline?: bigint };

/**
 * W read and the quote of `amountIn` at ONE block (card near-quote-under-the-pace): the two providers' final heights read
 * once (nearFinal), then W's views and the quote's views at the lower, both on both providers, every rule of each as
 * when read alone, and the block hash one. So the quote is never older than the read W signs from and never later than
 * it, at any request pace (before, a read and a quote read one after the other on a paced provider were 26 or more blocks
 * apart, past the signer's NEAR_SWAP_READ_AGE_MAX, and the buy never got a pair). `baseline`: a token whose balance of
 * W's is read at the same block (a buy's floor is measured from it).
 */
export async function readNearSwapPair(a: NearSwapWalletArgs & Pick<RheaQuoteArgs, "amountIn" | "pools"> & { baseline?: string }): Promise<NearSwapPair> {
  const { network, rpcs, wallet, side, token, amountIn, pools, signal } = a;
  const final = await nearFinal(network, rpcs, signal);
  const [state, quote, baseline] = await Promise.all([
    readNearSwapWallet({ network, rpcs, wallet, side, token, final, ...(signal ? { signal } : {}) }),
    rheaQuote({ network, rpcs, side, token, amountIn, pools, final, ...(signal ? { signal } : {}) }),
    a.baseline === undefined ? Promise.resolve(undefined) : readNearHeld({ network, rpcs, wallet, token: a.baseline, final, ...(signal ? { signal } : {}) }),
  ]);
  if (state.height !== quote.height || state.blockHash !== quote.blockHash || (baseline !== undefined && (baseline.height !== state.height || baseline.blockHash !== state.blockHash)))
    throw new RheaQuoteRefused("disagree", "W's read and the quote are not of one block");
  return deepFreeze({ state, quote, ...(baseline === undefined ? {} : { baseline: baseline.held }) });
}

/** What W holds of one token and whether it is registered on another, at one block on both providers. */
export type NearHeld = { account: string; height: number; blockHash: string; held: bigint; /** with `on` only */ registered?: boolean };

/**
 * W's balance of `token` (and, with `on`, whether W is registered on `on`) at one block on both providers, the bytes and
 * the block hash equal: the waits that only ask "has it arrived" (a registration read back, what a swap paid), two or
 * three reads a provider where W's whole read is six. Nothing W signs is taken from it.
 */
export async function readNearHeld(a: { network: NearNetwork; rpcs: readonly [NearRpc, NearRpc]; wallet: string; token: string; on?: string; final?: NearFinal; signal?: AbortSignal }): Promise<NearHeld> {
  const { network, rpcs, wallet, token, signal } = a;
  if (!(network in NEAR_RHEA)) throw new RheaQuoteRefused("input", `unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network) throw new RheaQuoteRefused("input", nearPairRule(network));
  if (typeof wallet !== "string" || !IMPLICIT.test(wallet)) throw new RheaQuoteRefused("input", "W is a 64-hex NEAR-implicit id");
  if (typeof token !== "string" || token === "" || (a.on !== undefined && (typeof a.on !== "string" || a.on === ""))) throw new RheaQuoteRefused("input", "a token account id");
  const { height } = await finalOf(network, rpcs, a.final, signal);
  const at = { block_id: height };
  let blockHash = "";
  const both = async (what: string, params: Obj): Promise<unknown> => {
    const [x, y] = (await Promise.all(rpcs.map((r) => answer(r, params, signal)))) as [Answer, Answer];
    if (x.height !== height || y.height !== height) throw new RheaQuoteRefused("rpc", `${what}: an answer not at block ${height}`);
    if (x.hash !== y.hash || (blockHash !== "" && x.hash !== blockHash)) throw new RheaQuoteRefused("disagree", `${what}: two blocks at height ${height}`);
    blockHash = x.hash;
    if (x.failed !== y.failed || !equalBytes(x.bytes, y.bytes)) throw new RheaQuoteRefused("disagree", `${what}: the providers' answers differ`);
    return json(x, what);
  };
  const [bal, reg] = await Promise.all([
    both("ft_balance_of", view(token, "ft_balance_of", { account_id: wallet }, at)),
    a.on === undefined ? Promise.resolve(null) : both("storage_balance_of", view(a.on, "storage_balance_of", { account_id: wallet }, at)),
  ]);
  const held = u128(bal);
  if (held === null) throw new RheaQuoteRefused("rpc", "ft_balance_of: not a u128");
  if (reg !== null && !(isObj(reg) && u128(reg.total) !== null)) throw new RheaQuoteRefused("rpc", "storage_balance_of: not a storage balance");
  return deepFreeze({ account: wallet, height, blockHash, held, ...(a.on === undefined ? {} : { registered: reg !== null }) });
}
