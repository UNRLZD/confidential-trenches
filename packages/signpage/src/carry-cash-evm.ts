// A leftover's carry to Cash on Base and Robinhood (card leftovers-carry-to-cash): the wallet (U_X = U_{s,i}, or
// W = W_{evm,l,j}) sends what it holds less the send's fee bound to Cash's deposit address in one plain type 2 transfer.
// - The amount (sendable): the wallet's lower balance at the newest block both RPCs hold (pool-carry-evm.ts wReads),
//   less the plain send's bound at 2 x base fee + the tip cap: 21,000 gas and Base's L1 fee bound (the higher of the two
//   RPCs'); on Robinhood (Arbitrum Nitro, whose L1 cost is gas and whose plain send estimates 21,235, read 2026-11-14
//   02:03Z on rpc.mainnet.chain.robinhood.com and rpc-robinhood.globalstake.io) the agreed estimate and a fifth, so a
//   send's own estimate a little above the one read here never leaves every send short.
// - A send: read again on both (balance, nonce at the newest block and at pending, base fee, estimate, L1 fee); short
//   when the lower balance cannot pay the amount and the bound (the sequencer quotes again); checked by the rule
//   (rules/pool.ts checkEvmCashCarry) and run by eth_call on both before the key is derived; signed by
//   signEvmOnwardSend; recorded (keep) before it leaves for both RPCs.
// - A reload reads a recorded send first and never sends again: landed once both read one of its hashes' receipts
//   status 1 at or under their final block; dead once both read the wallet's nonce past the send's at a block final on
//   both (pool-deposit-evm.ts spentFinal, its block kept in the record) with none of its hashes landed; pending otherwise.
// Every read names the wallet alone or the deposit address. Nothing logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { depositIdEvm, freshWallet } from "../../wallet/src/derive/keys.ts";
import { EVM_CHAIN_IDS, type EvmNetwork, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { checkEvmCashCarry, EVM_ADDRESS, EVM_ONWARD_GAS, EVM_ONWARD_GAS_MAX, evmOnwardCodeGas, signEvmOnwardSend, type EvmOnwardSend } from "./rules/pool.ts";
import { EVM_DEPOSIT_PRIORITY_CAP, EVM_DEPOSIT_RESEND_MS, l1FeesOf, spentFinal } from "./pool-deposit-evm.ts";
import { wReads } from "./pool-carry-evm.ts";
import type { CarryEnd, CarryOpen, CarrySender, CarrySource } from "./carry-cash.ts";

export type EvmCarryCashHost = {
  chain: "base" | "robinhood";
  network: EvmNetwork;
  /** The chain's two RPCs, of two operators. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The 64-byte seed; zeroed here once the key is derived. */
  seed64(): Promise<Uint8Array>;
  /** The device's cap on the priority fee, wei per gas (EVM_DEPOSIT_PRIORITY_CAP otherwise). */
  priorityCap?: bigint;
  now?(): number;
};

const lower = (s: string): string => s.toLowerCase();
const hex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const qty = (v: bigint): string => "0x" + v.toString(16);
/** A JSON-RPC quantity from a provider: hostile until read. */
function quantity(x: unknown): bigint {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error("not a quantity");
  return BigInt(x);
}
const HASH = /^0x[0-9a-f]{64}$/;
const DIGITS = /^[0-9]{1,78}$/;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** The wallet's key, derived for one signature; its address must be the source's. */
function keyOf(seed64: Uint8Array, src: CarrySource): { address: string; secretKey: Uint8Array } {
  if (src.kind === "w") {
    const w = freshWallet(seed64, "evm", BigInt(src.l), src.j);
    return { address: w.address, secretKey: w.secretKey };
  }
  const k = depositIdEvm(seed64, BigInt(src.s), src.i);
  return { address: k.address, secretKey: k.secretKey };
}

export function evmCashCarrySender(h: EvmCarryCashHost): CarrySender {
  const { rpcs } = h;
  const nitro = h.chain === "robinhood";
  const tip = h.priorityCap ?? EVM_DEPOSIT_PRIORITY_CAP;
  // l1FeesOf reads only the pin's network
  const r = { h: { rpcs, pin: { network: h.network } as EvmPoolPin } };
  const both = <T>(f: (rpc: EvmRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
  const sleepOf = (signal?: AbortSignal) => (ms: number): Promise<void> =>
    new Promise<void>((ok) => {
      const t = setTimeout(ok, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
    });
  const walletOf = (src: CarrySource): string | null => (src.chain === h.chain && typeof src.address === "string" && EVM_ADDRESS.test(src.address) ? lower(src.address) : null);
  const estimateOf = (call: { from: string; to: string; value: string }, tag: string) => both(async (rpc) => quantity(await rpc("eth_estimateGas", [call, tag])));

  // a recorded send: landed, dead or pending
  const verdict = async (w: string, open: CarryOpen, keep: (o: CarryOpen) => Promise<void>, signal?: AbortSignal): Promise<CarryEnd> => {
    const hashes = open.sends.map((s) => s.hash);
    const nonces = open.sends.map((s) => s.nonce);
    if (!hashes.every((x) => typeof x === "string" && HASH.test(x)) || !nonces.every((n) => typeof n === "string" && DIGITS.test(n))) return "fault";
    const nonce = nonces.map((n) => BigInt(n!)).reduce(max);
    // the nonce past the sends at a block final on both, read before the receipts (a send landing between the two reads
    // is read landed, never dead); its block kept in the record so a reload waits on the same one
    const sp = open.spent;
    const was = sp !== undefined && sp.nonce === nonce.toString() && DIGITS.test(sp.number) && HASH.test(sp.hash) ? { number: BigInt(sp.number), hash: sp.hash } : undefined;
    const s = await spentFinal(rpcs, w, nonce, was, sleepOf(signal), signal);
    if (s.kept !== undefined && (s.kept.number !== was?.number || s.kept.hash !== was?.hash)) await keep({ ...open, spent: { nonce: nonce.toString(), number: s.kept.number.toString(), hash: s.kept.hash } }).catch(() => {});
    const fin = await both(async (rpc) => quantity(((await rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: unknown } | null)?.number));
    const final = min(fin[0], fin[1]);
    let mined = false;
    for (const hash of hashes) {
      const rs = await both(async (rpc) => (await rpc("eth_getTransactionReceipt", [hash])) as { transactionHash?: unknown; status?: unknown; blockNumber?: unknown; blockHash?: unknown } | null);
      const ok = rs.map((x) => x !== null && typeof x === "object" && typeof x.transactionHash === "string" && lower(x.transactionHash) === hash && x.status === "0x1" && typeof x.blockHash === "string");
      if (ok.some(Boolean)) mined = true;
      if (ok[0] && ok[1]) {
        const at = rs.map((x) => quantity(x!.blockNumber));
        if (at[0] === at[1] && lower(rs[0]!.blockHash as string) === lower(rs[1]!.blockHash as string) && at[0]! <= final) return "landed";
      }
    }
    if (s.final !== null && !mined) return "dead";
    if (mined || s.final !== null) return "pending";
    // unsent (the page closed between the record and the send, or a node dropped it): older than the resend window, no
    // RPC knows any of its hashes, and the wallet's newest and pending nonce on both still the send's. Dead, so the
    // sequencer quotes again; the new send takes the same nonce, so at most one of the two can land
    // (pool-carry-evm.ts's unsent, the same rule)
    if (!open.sends.every((x) => typeof x.sentMs === "string" && DIGITS.test(x.sentMs))) return "pending";
    const newest = open.sends.map((x) => BigInt(x.sentMs)).reduce(max);
    if (BigInt(h.now?.() ?? Date.now()) - newest <= EVM_DEPOSIT_RESEND_MS[h.network]) return "pending";
    const known = await both(async (rpc) => {
      for (const x of hashes) if ((await rpc("eth_getTransactionByHash", [x])) !== null) return true;
      return false;
    });
    if (known[0] || known[1]) return "pending";
    const counts = await both(async (rpc) => [quantity(await rpc("eth_getTransactionCount", [w, "latest"])), quantity(await rpc("eth_getTransactionCount", [w, "pending"]))]);
    return counts.every((c) => c[0] === nonce && c[1] === nonce) ? "dead" : "pending";
  };

  return {
    sendable: async (src, signal) => {
      try {
        const w = walletOf(src);
        if (w === null) return null;
        const a = await wReads(rpcs, w, sleepOf(signal), signal);
        const maxFee = 2n * a.baseFee + tip;
        let gas = EVM_ONWARD_GAS;
        if (nitro) {
          const est = await estimateOf({ from: w, to: w, value: "0x0" }, a.tag);
          gas = evmOnwardCodeGas(max(est[0], est[1]));
          if (est[0] < EVM_ONWARD_GAS || gas > EVM_ONWARD_GAS_MAX) return null;
        }
        const l1 = await l1FeesOf(r, gas, a.tag);
        const v = min(a.balance[0], a.balance[1]) - gas * maxFee - max(l1[0], l1[1]);
        return v > 0n ? v : 0n;
      } catch {
        return null;
      }
    },
    send: async (src, open, keep, signal) => {
      let key: Uint8Array | null = null;
      try {
        const w = walletOf(src);
        if (w === null) return "fault";
        if (open.sends.length > 0) return await verdict(w, open, keep, signal);
        if (typeof open.amount !== "string" || !DIGITS.test(open.amount) || typeof open.to !== "string" || !EVM_ADDRESS.test(open.to)) return "fault";
        const amount = BigInt(open.amount);
        const to = open.to;
        const a = await wReads(rpcs, w, sleepOf(signal), signal);
        // no send of its own on its way: the pending nonce is the newest block's on both
        const pending = await both(async (rpc) => quantity(await rpc("eth_getTransactionCount", [w, "pending"])));
        if (pending[0] !== a.nonce || pending[1] !== a.nonce) return "fault";
        const maxFee = 2n * a.baseFee + tip;
        const est = await estimateOf({ from: w, to, value: qty(amount) }, a.tag);
        // the deposit address a plain account on both (the rule refuses code, or two answers that differ)
        const toHasCode = await both(async (rpc) => {
          const code = await rpc("eth_getCode", [to, a.tag]);
          if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) throw new Error("not code");
          return code !== "0x";
        });
        const gasLimit = nitro ? est[0] : EVM_ONWARD_GAS;
        const l1 = await l1FeesOf(r, gasLimit, a.tag);
        if (min(a.balance[0], a.balance[1]) < amount + gasLimit * maxFee + max(l1[0], l1[1])) return "short";
        const tx: EvmOnwardSend = { type: 2, chainId: EVM_CHAIN_IDS[h.network], nonce: a.nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to, value: amount, data: "0x", accessList: [] };
        checkEvmCashCarry(tx, { wallet: w, to, amount, chain: h.chain, network: h.network }, { nonce: a.nonces, balance: a.balance, estimate: est, baseFee: a.baseFees, l1Fee: l1, priorityCap: tip, toHasCode });
        // the very send run on both before the key is derived: a failure on either signs nothing
        const sims = await Promise.allSettled(rpcs.map((rpc) => rpc("eth_call", [{ from: w, to, value: qty(amount), gas: qty(gasLimit) }, a.tag])));
        if (!sims.every((x) => x.status === "fulfilled" && x.value === "0x")) return "fault";
        // a sign out since the reads: nothing signed
        if (signal?.aborted) return "fault";
        const seed = await h.seed64();
        let k: { address: string; secretKey: Uint8Array };
        try {
          k = keyOf(seed, src);
        } finally {
          seed.fill(0);
        }
        key = k.secretKey;
        if (lower(k.address) !== w) return "fault";
        const raw = signEvmOnwardSend(key, tx);
        key.fill(0);
        key = null;
        // recorded before it leaves: a write that fails sends nothing
        await keep({ ...open, sends: [...open.sends, { hash: hex(keccak_256(raw)), value: amount.toString(), sentMs: String(h.now?.() ?? Date.now()), nonce: a.nonce.toString() }] });
        await Promise.allSettled(rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hex(raw)])));
        return "pending";
      } catch {
        return "fault";
      } finally {
        key?.fill(0);
      }
    },
  };
}
