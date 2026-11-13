// A transaction by its hash, from one source that need not be trusted (the helper's keyed route, decision M359): its
// answer is taken only when its fields hash to the hash the device already agreed (a pool round's row: two operators, out of
// the seats, the helper's keyed route and the public history sources, answering it byte for byte), so the source can
// withhold the transaction, never change one field of it.
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { EvmPoolEvent, EvmRpc } from "../../wallet/src/pool/evm.ts";

const lower = (s: string): string => s.toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

// RLP (the Ethereum yellow paper, appendix B)
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) (out.set(x, o), (o += x.length));
  return out;
};
const beBytes = (v: bigint): Uint8Array => {
  if (v < 0n) throw new Error("a negative integer");
  const out: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) out.unshift(Number(x & 0xffn));
  return Uint8Array.from(out);
};
const head = (n: number, short: number): Uint8Array => {
  if (n < 56) return Uint8Array.of(short + n);
  const len = beBytes(BigInt(n));
  return cat(Uint8Array.of(short + 55 + len.length), len);
};
const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(head(b.length, 0x80), b));
const rlpList = (items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(head(body.length, 0xc0), body);
};
const hexBytes = (h: string): Uint8Array => {
  if (!/^0x([0-9a-f]{2})*$/.test(h)) throw new Error("not hex bytes");
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};
const qty = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(v)) throw new Error(`${what}: not a quantity`);
  return BigInt(v);
};
const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

/** The hash of a signed type 2 transaction as an RPC gives it (eth_getTransactionByHash): keccak256(0x02 ‖ rlp([chainId,
 *  nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, input, accessList, yParity, r, s])). Throws on any
 *  other type or a field out of its shape. */
export function evmType2Hash(t: Record<string, unknown>): string {
  if (t?.type !== "0x2") throw new Error("not a type 2 transaction");
  const u = (k: string) => rlpBytes(beBytes(qty(t[k], k)));
  if (typeof t.to !== "string" || !ADDRESS.test(lower(t.to))) throw new Error("to: not an address");
  if (typeof t.input !== "string") throw new Error("input: not hex");
  const list = t.accessList;
  if (!Array.isArray(list)) throw new Error("accessList: not a list");
  const access = rlpList(
    list.map((e: { address?: unknown; storageKeys?: unknown }) => {
      if (typeof e?.address !== "string" || !ADDRESS.test(lower(e.address)) || !Array.isArray(e.storageKeys)) throw new Error("accessList: not an entry");
      return rlpList([rlpBytes(hexBytes(lower(e.address))), rlpList(e.storageKeys.map((k: unknown) => {
        if (typeof k !== "string" || !HASH.test(lower(k))) throw new Error("accessList: not a storage key");
        return rlpBytes(hexBytes(lower(k)));
      }))]);
    }),
  );
  const parity = t.yParity ?? t.v;
  const y = qty(parity, "yParity");
  if (y !== 0n && y !== 1n) throw new Error("yParity: not 0 or 1");
  const fields = [u("chainId"), u("nonce"), u("maxPriorityFeePerGas"), u("maxFeePerGas"), u("gas"), rlpBytes(hexBytes(lower(t.to))), u("value"), rlpBytes(hexBytes(lower(t.input))), access, rlpBytes(beBytes(y)), u("r"), u("s")];
  return hex(keccak_256(cat(Uint8Array.of(2), rlpList(fields))));
}

/** The transaction hash in a round row's bytes (block, block hash, log index, transaction hash, ...), or null. */
export function evmRowTx(e: Pick<EvmPoolEvent, "bytes">): string | null {
  const tx = e.bytes.split(" ")[3];
  return typeof tx === "string" && HASH.test(tx) ? tx : null;
}

/** The transaction at `tx` as `source` gives it, taken only when its fields hash to `tx`: its `to` and `input`. */
export async function evmAgreedTx(source: EvmRpc, tx: string): Promise<{ to: string; input: string }> {
  const t = (await source("eth_getTransactionByHash", [tx])) as Record<string, unknown> | null;
  if (t === null || typeof t !== "object") throw new Error("the source has no such transaction");
  if (evmType2Hash(t) !== lower(tx)) throw new Error("the source's transaction is not the agreed one");
  return { to: lower(String(t.to)), input: lower(String(t.input)) };
}
