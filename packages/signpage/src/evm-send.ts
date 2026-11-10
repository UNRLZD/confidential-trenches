// An EVM pool release's send and its read-back on the device (card signpage-evm-pool-buy): the pieces a pool buy, and
// next the pool sell and withdraw (cards signpage-evm-pool-sell, signpage-evm-pool-withdraw), share.
//
// - The calldata: PrivacyPoolSimple.buy(Withdrawal, WithdrawProof, fee, Buy, W's signature) in its one canonical ABI
//   encoding (contracts/pool-evm/src/interfaces/IPrivacyPool.sol; the helper's evmReadBuy refuses any other, card
//   helper-evm-abi-tie), so the helper carries the bytes W signed for, byte for byte. pB is snarkjs's pi_b with each
//   pair swapped (the Solidity verifier's order, as contracts/pool-evm/script/testnet-run-lib.mjs proofArg makes it).
// - The send: POST /v1/pool/evm/send { pool, data, epoch } (apps/helper/src/pool/evm.ts). Its answer is hostile: a 429
//   is a wait (EvmSendBusy, its Retry-After), any other status a refusal (EvmSendRefused, its code), and a 200 is only a
//   name, { hash }, to read back.
// - The read-back, each of two RPCs of two operators on its own: the transaction under that hash must be this very one
//   (to the pool, the calldata W signed, the chain's id) before its receipt counts; then succeeded or reverted, with the
//   pool's own logs. Nothing else is read, and every read names only the transaction's hash.
// Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultSnarkjsProof, VaultWithdrawSignals } from "../../kit/src/vault/shapes.ts";
import type { EvmPoolBuy } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { EVM_POOL_EVENTS, evmRelayDataBytes, type EvmRelayData, type EvmRpc } from "../../wallet/src/pool/evm.ts";

const enc = new TextEncoder();
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const lower = (s: string): string => s.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const U256 = 1n << 256n;

/** PrivacyPoolSimple.buy's signature, as the pool compiles it (contracts/pool-evm/abi.json). */
export const EVM_BUY_SIGNATURE = "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)";
const BUY_SELECTOR = keccak_256(enc.encode(EVM_BUY_SIGNATURE)).subarray(0, 4);

const word = (v: bigint): Uint8Array => {
  if (typeof v !== "bigint" || v < 0n || v >= U256) throw new Error("calldata: a word out of range");
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const addressWord = (a: string): Uint8Array => {
  if (typeof a !== "string" || !ADDRESS.test(a)) throw new Error("calldata: not an address");
  return word(BigInt(a));
};
const dec = (s: unknown): bigint => {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(s)) throw new Error("calldata: a proof value is not a decimal");
  return BigInt(s);
};
const bytesOf = (h: string): Uint8Array => {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error("calldata: not hex bytes");
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};
/** A dynamic `bytes` tail: its length, then the bytes right-padded to whole words. */
const tail = (b: Uint8Array): Uint8Array[] => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return [word(BigInt(b.length)), padded];
};
const cat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};

/** The pool's WithdrawProof words from snarkjs JSON: pA, pB (each pair swapped), pC, the eight public signals. */
export function evmProofWords(p: VaultSnarkjsProof, signals: VaultWithdrawSignals): Uint8Array[] {
  if (!Array.isArray(signals) || signals.length !== 8) throw new Error("calldata: not eight public signals");
  return [
    dec(p.pi_a[0]), dec(p.pi_a[1]),
    dec(p.pi_b[0][1]), dec(p.pi_b[0][0]), dec(p.pi_b[1][1]), dec(p.pi_b[1][0]),
    dec(p.pi_c[0]), dec(p.pi_c[1]),
    ...signals.map(dec),
  ].map(word);
}

/** buy(Withdrawal{pool, abi.encode(relay)}, proof, fee, Buy{adapter, data, minOut, token}, W's 65-byte signature). */
export function evmBuyCalldata(pool: string, relay: EvmRelayData, proof: VaultSnarkjsProof, signals: VaultWithdrawSignals, fee: bigint, built: EvmPoolBuy, signature: Uint8Array): Uint8Array {
  if (!(signature instanceof Uint8Array) || signature.length !== 65) throw new Error("calldata: not a 65-byte signature");
  const relayBytes = evmRelayDataBytes(relay);
  const buyData = bytesOf(built.data);
  // the head: the Withdrawal's offset, the proof's 16 static words, the fee, the Buy's offset, the signature's offset
  const HEAD = 20;
  const withdrawal = [addressWord(pool), word(0x40n), ...tail(relayBytes)];
  const buy = [addressWord(built.adapter), word(0x80n), word(built.minOut), addressWord(built.token), ...tail(buyData)];
  const words = (parts: Uint8Array[]): bigint => BigInt(parts.reduce((n, p) => n + p.length, 0) / 32);
  const buyAt = BigInt(HEAD) + words(withdrawal);
  const sigAt = buyAt + words(buy);
  return cat([BUY_SELECTOR, word(BigInt(32 * HEAD)), ...evmProofWords(proof, signals), word(fee), word(32n * buyAt), word(32n * sigAt), ...withdrawal, ...buy, ...tail(signature)]);
}

/** The helper's busy answer (429): the same body again after its wait. */
export class EvmSendBusy extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`pool evm send: busy, again in ${retryAfterMs} ms`);
    this.retryAfterMs = retryAfterMs;
  }
}
/** The helper refused the send (any status but 200 and 429): its code when it named one. Its word only: it may have
 *  sent all the same, so a refusal settles nothing about the chain. */
export class EvmSendRefused extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null) {
    super(`pool evm send: HTTP ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/** How long a send waits for the helper's answer (a buy's simulation and its two providers' reads). */
export const EVM_SEND_TIMEOUT_MS = 60_000;
const SEND_ANSWER_MAX = /* @__PURE__ */ HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === "/v1/pool/evm/send")!.limitBytes!;
const HASH = /^0x[0-9a-f]{64}$/;

/** POST /v1/pool/evm/send: the hash the helper names (lowercase), or a throw (EvmSendBusy, EvmSendRefused, or a
 *  transport fault). The body names the pool, the calldata and the epoch whose fee the proof binds. */
export async function evmPoolSend(helper: string, body: { pool: string; data: Uint8Array; epoch: bigint }, fetchFn: typeof fetch = fetch): Promise<string> {
  const window = new AbortController();
  const t = setTimeout(() => window.abort(new DOMException(`pool evm send: no answer in ${EVM_SEND_TIMEOUT_MS} ms`, "TimeoutError")), EVM_SEND_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${helper}/v1/pool/evm/send`, {
      ...HELPER_FETCH_INIT,
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pool: lower(body.pool), data: `0x${hexOf(body.data)}`, epoch: Number(body.epoch) }),
      signal: window.signal,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json: unknown = null;
    try {
      json = bytes.length <= SEND_ANSWER_MAX ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null;
    } catch {
      json = null;
    }
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const after = header === null || header.trim() === "" ? Number.NaN : Number(header);
      throw new EvmSendBusy(Number.isInteger(after) && after >= 0 && after <= 3_600 ? after * 1_000 : 1_000);
    }
    if (res.status !== 200) {
      const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
      throw new EvmSendRefused(res.status, typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : null);
    }
    const hash = (json as { hash?: unknown } | null)?.hash;
    if (typeof hash !== "string" || !HASH.test(lower(hash))) throw new EvmSendRefused(200, "bad_answer");
    return lower(hash);
  } finally {
    clearTimeout(t);
  }
}

/** One RPC's read of a release transaction: none (no transaction under the hash), other (one that is not this very
 *  transaction), pending (this one, no receipt yet), ok or failed (its receipt), with its logs and block. */
export type EvmReadBack = { got: "none" | "other" | "pending" | "ok" | "failed"; logs?: readonly EvmLog[]; block?: bigint };
export type EvmLog = { address: string; topics: readonly string[]; data: string };
/** The very transaction the device sent: its hash, the contract it calls, its calldata and its chain. */
export type EvmSent = { hash: string; to: string; data: Uint8Array; chainId: bigint };

const big = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);

/** One RPC's read-back of `sent`: the transaction under its hash first (to, input and chain id this very one's), then
 *  its receipt. A read that fails throws (the caller reads again). */
export async function evmReadBack(rpc: EvmRpc, sent: EvmSent): Promise<EvmReadBack> {
  const hash = lower(sent.hash);
  const tx = (await rpc("eth_getTransactionByHash", [hash])) as Record<string, unknown> | null;
  if (tx === null || tx === undefined) return { got: "none" };
  if (typeof tx !== "object") throw new Error("read-back: not a transaction");
  const input = typeof tx.input === "string" ? lower(tx.input) : null;
  const mine = typeof tx.hash === "string" && lower(tx.hash) === hash && typeof tx.to === "string" && lower(tx.to) === lower(sent.to) && input === `0x${hexOf(sent.data)}` && big(tx.chainId) === sent.chainId;
  if (!mine) return { got: "other" };
  const rc = (await rpc("eth_getTransactionReceipt", [hash])) as Record<string, unknown> | null;
  if (rc === null || rc === undefined) return { got: "pending" };
  if (typeof rc !== "object" || typeof rc.transactionHash !== "string" || lower(rc.transactionHash) !== hash) return { got: "other" };
  const block = big(rc.blockNumber);
  if (block === null || !Array.isArray(rc.logs)) throw new Error("read-back: not a receipt");
  const logs: EvmLog[] = rc.logs.map((l: Record<string, unknown>) => ({
    address: typeof l?.address === "string" ? lower(l.address) : "",
    topics: Array.isArray(l?.topics) ? l.topics.map((t: unknown) => (typeof t === "string" ? lower(t) : "")) : [],
    data: typeof l?.data === "string" ? lower(l.data) : "",
  }));
  if (rc.status === "0x1") return { got: "ok", logs, block };
  if (rc.status === "0x0") return { got: "failed", block };
  throw new Error("read-back: a receipt with no status");
}

const topicOf = (signature: string): string => `0x${hexOf(keccak_256(enc.encode(signature)))}`;
const TOPIC_BOUGHT = /* @__PURE__ */ topicOf(EVM_POOL_EVENTS.Bought);
const TOPIC_WITHDRAWN = /* @__PURE__ */ topicOf(EVM_POOL_EVENTS.Withdrawn);
const dataWords = (data: string): bigint[] => (/^0x([0-9a-f]{64})*$/.test(data) ? (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`)) : []);

/** What the pool says a release did, from its own logs only: Bought (the swap ran: W's token rose by `out`) or Withdrawn
 *  (the swap failed and W got the chunk less the fee in ETH), for W, this fee recipient and this nullifier; null when the
 *  receipt holds neither from the pool (or more than one). */
export type EvmReleaseOutcome = { kind: "bought"; token: string; out: bigint; value: bigint; fee: bigint } | { kind: "withdrawn"; value: bigint; fee: bigint };
export function evmReleaseOutcome(logs: readonly EvmLog[], pool: string, w: string, feeRecipient: string, nullifier: bigint): EvmReleaseOutcome | null {
  const wTopic = `0x${"0".repeat(24)}${lower(w).slice(2)}`;
  const found: EvmReleaseOutcome[] = [];
  for (const l of logs) {
    if (l.address !== lower(pool) || l.topics[1] !== wTopic) continue;
    const d = dataWords(l.data);
    if (l.topics[0] === TOPIC_BOUGHT && d.length === 7 && d[0] === BigInt(feeRecipient) && d[3] === nullifier && d[5]! < 1n << 160n)
      found.push({ kind: "bought", value: d[1]!, fee: d[2]!, token: `0x${d[5]!.toString(16).padStart(40, "0")}`, out: d[6]! });
    else if (l.topics[0] === TOPIC_WITHDRAWN && d.length === 5 && d[0] === BigInt(feeRecipient) && d[3] === nullifier) found.push({ kind: "withdrawn", value: d[1]!, fee: d[2]! });
  }
  return found.length === 1 ? found[0]! : null;
}
