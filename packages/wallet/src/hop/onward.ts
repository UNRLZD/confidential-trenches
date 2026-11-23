// A hop's second leg (card wallet-hop-onward): A_{l,j}, the fresh NEAR account the vault paid a hop's rung to
// (hop/out.ts, fund_recipient true), moves all its USDC to the deposit address of a confidential 1Click quote whose
// output goes to U_X, the pool's one-time deposit wallet on chain X; a failed swap refunds to A on NEAR. A signs one
// NEP-366 delegate of one ft_transfer and the release's relayer carries it (apps/helper/src/bind/onward.ts, which
// registers the deposit address itself), so A needs no NEAR. Nothing is signed until the request is the hop's own, the
// quote passes the kit's 1Click check, its min out holds the pool's floor, 1Click itself does not know the address as a
// public swap, and A, read at one block on two RPCs, holds exactly the quoted amount under its own key alone.
import { checkOneClickQuote, HELPER_BIND_ONWARD_CODES, type OneClickPricing, type OneClickRequest, VAULT_CONSTANTS } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { DEPOSIT_WINDOW, encodeDelegateAction, type DelegateFields, NEP366_PREFIX, NONCE_RANGE_MULTIPLIER, sendDepositDelegate, type BindAnswer } from "../deposit/delegate.ts";
import { MOVE_GAS, readMoveOut, type MoveOutRpc } from "../deposit/moveout.ts";
import { DEPOSIT_QUOTE_DEADLINE_MS, hopQuoteRequest, POOL_DEPOSIT_MIN_OUT, type PoolDepositChain } from "../deposit/quote.ts";
import { armAccount, depositId, depositIdEvm } from "../derive/keys.ts";

export type HopOnwardRefusalCode = "input" | "request" | "quote" | "floor" | "public" | "read" | "amount" | "nonce";
export class HopOnwardRefused extends Error {
  readonly code: HopOnwardRefusalCode;
  constructor(code: HopOnwardRefusalCode, detail: string) {
    super(`hop onward not signed (${code}): ${detail}`);
    this.name = "HopOnwardRefused";
    this.code = code;
  }
}

export interface HopOnwardArgs {
  seed64: Uint8Array;
  /** A_{l,j}: the hop's rung (hop/out.ts HopRung l and j). */
  l: bigint;
  j: number;
  /** U_X: deposit i of chain X's pool of scope s. */
  chain: PoolDepositChain;
  s: bigint;
  i: number;
  /** The request asked (hopQuoteRequest) and 1Click's answer to it, hostile input until checked. */
  request: OneClickRequest;
  answer: unknown;
  /** The kit's 1Click check: the prices both sides were read at, the assets' decimals, the clock (ms). */
  check: { pricing: OneClickPricing; decimalsIn: number; decimalsOut: number; now?: number };
  /** The least X's coin the deposit may bring, at or above the pool ladder's least rung (POOL_DEPOSIT_MIN_OUT). */
  floor: bigint;
  /** true only when 1Click does not know the address as a public swap (its keyless /status answers 404). */
  hidden: (depositAddress: string) => Promise<boolean>;
  rpcs: readonly [MoveOutRpc, MoveOutRpc];
}

/** What goes to the relayer, and what the device keeps to follow it. */
export interface SignedHopOnward {
  /** borsh(SignedDelegateAction) in standard base64: POST /v1/bind's one body field. */
  signed_delegate: string;
  sender_id: string;
  receiver_id: string;
  deposit_address: string;
  amount: bigint;
  nonce: bigint;
  max_block_height: bigint;
  public_key: string; // ed25519:<base58>
}

const DIGITS = /^[1-9][0-9]{0,38}$/;

// borsh(SignedDelegateAction) over NEP-366's signable message, as deposit/delegate.ts signs a deposit. Module private,
// as that one is: the only signer here is hopOnward, which reads A first.
function signDelegate(d: DelegateFields, secretKey: Uint8Array): Uint8Array {
  const delegate = encodeDelegateAction(d);
  const signable = new Uint8Array(4 + delegate.length);
  new DataView(signable.buffer).setUint32(0, NEP366_PREFIX, true);
  signable.set(delegate, 4);
  const signed = new Uint8Array(delegate.length + 65);
  signed.set(delegate);
  signed[delegate.length] = 0; // KeyType::ED25519
  signed.set(ed25519.sign(sha256(signable), secretKey), delegate.length + 1);
  return signed;
}

// U_X's address on X, public side only: base58 of the ed25519 key on Solana, EIP-55 on Base and Robinhood.
function uxOf(seed64: Uint8Array, chain: PoolDepositChain, s: bigint, i: number): string {
  if (chain === "solana") {
    const k = depositId(seed64, s, i);
    k.secretKey.fill(0);
    return base58.encode(k.publicKey);
  }
  const k = depositIdEvm(seed64, s, i);
  k.secretKey.fill(0);
  return k.address;
}

/**
 * A_{l,j}'s one transfer of all its USDC to the deposit address of a checked hop quote, signed once every check passed.
 * Refuses, before anything is signed (HopOnwardRefused, by code): a request that is not hopQuoteRequest's own for this
 * A and this U_X ("request"); an answer the kit's 1Click check refuses ("quote"); a min out under `floor` or a floor
 * under the pool's least rung ("floor"); an address 1Click knows as a public swap ("public"); A unread, read
 * differently on the two RPCs, or holding a key other than its own ("read"); USDC other than the quoted amount
 * ("amount"); a nonce at the end of its range ("nonce"). A's secret key and the seed's copy are zeroed on every path.
 */
export async function hopOnward(args: HopOnwardArgs): Promise<SignedHopOnward> {
  if (!(args?.seed64 instanceof Uint8Array) || args.seed64.length !== 64) throw new HopOnwardRefused("input", "seed64 must be 64 bytes");
  const { l, j, chain, s, i, floor } = args;
  if (typeof l !== "bigint" || l < 0n || !Number.isSafeInteger(j) || j < 0) throw new HopOnwardRefused("input", "l and j name a rung");
  if (typeof s !== "bigint" || s < 0n || !Number.isSafeInteger(i) || i < 0) throw new HopOnwardRefused("input", "s and i name a deposit wallet");
  if (typeof chain !== "string" || !Object.hasOwn(POOL_DEPOSIT_MIN_OUT, chain)) throw new HopOnwardRefused("input", "no pool on this chain");
  const request = args.request as unknown as Record<string, unknown>;
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new HopOnwardRefused("request", "no request");
  // the request read once, its own keys only: what is checked is what is signed from
  const req: Record<string, unknown> = {};
  for (const k of Object.keys(request)) req[k] = request[k];
  const seed = Uint8Array.from(args.seed64);
  let a: ReturnType<typeof armAccount> | undefined;
  try {
    a = armAccount(seed, l, j);
    const ux = uxOf(seed, chain, s, i);
    seed.fill(0);

    // 1. the request is hopQuoteRequest's own for this A and this U_X, every key and value
    const amount = typeof req.amount === "string" && DIGITS.test(req.amount) ? BigInt(req.amount) : null;
    const asked = typeof req.deadline === "string" ? Date.parse(req.deadline) - DEPOSIT_QUOTE_DEADLINE_MS : NaN;
    if (amount === null || !Number.isSafeInteger(asked)) throw new HopOnwardRefused("request", "no amount or deadline");
    let own: Record<string, unknown>;
    try {
      own = hopQuoteRequest(chain, ux, a.id, amount, asked) as unknown as Record<string, unknown>;
    } catch (e) {
      throw new HopOnwardRefused("request", e instanceof Error ? e.message : String(e));
    }
    const keys = Object.keys(own);
    if (Object.keys(req).length !== keys.length || keys.some((k) => !Object.hasOwn(req, k) || req[k] !== own[k]))
      throw new HopOnwardRefused("request", "the request is not this hop's: A pays, U_X receives, a refund goes back to A on NEAR, confidential");

    // 2. the kit's 1Click check: the signature under the pinned keys, the echo, the fees, the price, the deadline
    let depositAddress: string | undefined, minAmountOut: bigint;
    try {
      ({ depositAddress, minAmountOut } = checkOneClickQuote(own as unknown as OneClickRequest, args.answer, {
        path: "partner",
        pricing: args.check.pricing,
        decimalsIn: args.check.decimalsIn,
        decimalsOut: args.check.decimalsOut,
        intoVault: false,
        now: args.check.now,
      }));
    } catch (e) {
      throw new HopOnwardRefused("quote", e instanceof Error ? e.message : String(e));
    }
    // a NEAR deposit address is a 64-hex implicit account, the receiver of a plain ft_transfer
    if (typeof depositAddress !== "string" || !/^[0-9a-f]{64}$/.test(depositAddress)) throw new HopOnwardRefused("quote", "no NEAR deposit address");

    // 3. the pool's floor
    if (typeof floor !== "bigint" || floor < POOL_DEPOSIT_MIN_OUT[chain]) throw new HopOnwardRefused("floor", "the floor is under the pool's least rung");
    if (minAmountOut < floor) throw new HopOnwardRefused("floor", `min out ${minAmountOut} is under the floor ${floor}`);

    // 4. 1Click does not know the address as a public swap
    if ((await args.hidden(depositAddress)) !== true) throw new HopOnwardRefused("public", "1Click knows this address as a public swap");

    // 5. A at one block on both RPCs, its own key alone, holding exactly the quoted amount
    const token = VAULT_CONSTANTS.TOKEN;
    const read = await readMoveOut(a.id, depositAddress, token, args.rpcs);
    if (read === null) throw new HopOnwardRefused("read", "A was not read the same at one block on both RPCs under its own key alone");
    if (read.usdc !== amount) throw new HopOnwardRefused("amount", `A holds ${read.usdc}, the quote moves ${amount}`);
    const nonce = read.nonce + 1n;
    if (nonce >= BigInt(read.height) * NONCE_RANGE_MULTIPLIER) throw new HopOnwardRefused("nonce", "nonce + 1 is at or above the read height x 1,000,000");

    // 6. one ft_transfer on the token, args exactly {receiver_id, amount} (the relayer's bad_msg), 1 yocto
    const max_block_height = BigInt(read.height) + BigInt(DEPOSIT_WINDOW);
    const signed = signDelegate(
      {
        sender_id: a.id,
        receiver_id: token,
        method_name: "ft_transfer",
        args: new TextEncoder().encode(JSON.stringify({ receiver_id: depositAddress, amount: amount.toString() })),
        gas: MOVE_GAS.ft_transfer,
        deposit: 1n,
        nonce,
        max_block_height,
        public_key: a.publicKey,
      },
      a.secretKey,
    );
    return { signed_delegate: base64.encode(signed), sender_id: a.id, receiver_id: token, deposit_address: depositAddress, amount, nonce, max_block_height, public_key: `ed25519:${base58.encode(a.publicKey)}` };
  } finally {
    seed.fill(0);
    a?.secretKey.fill(0);
  }
}

/**
 * Hands the signed transfer to the release's relayer, as a deposit's call goes (sendDepositDelegate): a tx hash, an
 * onward code at its own status (HELPER_BIND_ONWARD_CODES), a busy code with its wait, or a throw.
 */
export function sendHopOnward(signed: Pick<SignedHopOnward, "signed_delegate">, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<BindAnswer> {
  return sendDepositDelegate(signed, fetchFn, signal, HELPER_BIND_ONWARD_CODES);
}
