// An EVM pool release's send and its read-back on the device (card signpage-evm-pool-buy): the pieces a pool buy, and
// next the pool sell and withdraw (cards signpage-evm-pool-sell, signpage-evm-pool-withdraw), share.
//
// - The calldata: PrivacyPoolSimple.buy(Withdrawal, WithdrawProof, fee, Buy, W's signature) in its one canonical ABI
//   encoding (contracts/pool-evm/src/interfaces/IPrivacyPool.sol; the helper's evmReadBuy refuses any other, card
//   helper-evm-abi-tie), so the helper carries the bytes W signed for, byte for byte. pB is snarkjs's pi_b with each
//   pair swapped (the Solidity verifier's order, as contracts/pool-evm/script/testnet-run-lib.mjs proofArg makes it).
// - The send: POST /v1/pool/evm/send { pool, data, epoch } (apps/helper/src/pool/evm.ts). Its answer is hostile and
//   the bytes have left the device once it is asked, so only two answers say anything: a 429 is a wait (EvmSendBusy,
//   its Retry-After), and a 4xx naming its code is the helper's refusal (EvmSendRefused). Everything else, a 5xx, a 4xx
//   with no code, a 200 with no hash, a redirect, a timeout, a fault, is no answer (EvmSendNoAnswer): the helper may have
//   sent it all the same. A 200's hash is a hint the device never reads a chain by.
// - The read-back, each of two RPCs of two operators on its own: the pool's own release events (Bought, Withdrawn) from
//   the block the device read before the send to the RPC's newest, asked by the pool's address and the two events'
//   topics only, and that newest block's time. No read names W, a nullifier or a transaction: which release is this
//   buy's is matched here, on the device (evmBuyVerdict).
// Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { VaultSnarkjsProof, VaultWithdrawSignals } from "../../kit/src/vault/shapes.ts";
import type { EvmPoolBuy } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { EVM_POOL_EVENTS, evmRelayDataBytes, type EvmRelayData, type EvmRpc } from "../../wallet/src/pool/evm.ts";

const enc = /* @__PURE__ */ new TextEncoder();
const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const lower = (s: string): string => s.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const U256 = 1n << 256n;

/** PrivacyPoolSimple.buy's signature, as the pool compiles it (contracts/pool-evm/abi.json). */
export const EVM_BUY_SIGNATURE = "buy((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256,(address,bytes,uint256,address),bytes)";
const selectorOf = (signature: string): Uint8Array => keccak_256(enc.encode(signature)).subarray(0, 4);
const BUY_SELECTOR = /* @__PURE__ */ selectorOf(EVM_BUY_SIGNATURE);

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
/** The helper's own refusal: a 4xx (not 429) naming its code. Its word only: a broken-in helper may refuse and send all
 *  the same, which the chain shows and the settle reads. */
export class EvmSendRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`pool evm send: HTTP ${status} (${code})`);
    this.status = status;
    this.code = code;
  }
}
/** No answer that says anything (a 5xx, a 4xx with no code, a 200 with no hash, a timeout, a fault): the bytes may be
 *  on their way, so the run reads on. */
export class EvmSendNoAnswer extends Error {
  readonly status: number | null;
  constructor(status: number | null, why: string) {
    super(`pool evm send: no answer (${status === null ? why : `HTTP ${status}, ${why}`})`);
    this.status = status;
  }
}

/** How long a send waits for the helper's answer (a buy's simulation and its two providers' reads). */
export const EVM_SEND_TIMEOUT_MS = 60_000;
/** A Retry-After the device takes, at most (s); a longer one is read as this. */
export const EVM_SEND_RETRY_MAX_S = 60;
const SEND_ANSWER_MAX = /* @__PURE__ */ HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === "/v1/pool/evm/send")!.limitBytes!;
const HASH = /^0x[0-9a-f]{64}$/;
const CODE = /^[a-z_]{1,40}$/;

/** POST /v1/pool/evm/send: the hash the helper names (lowercase, a hint only), or a throw: EvmSendBusy, EvmSendRefused or
 *  EvmSendNoAnswer. The body names the pool, the calldata and the epoch whose fee the proof binds. */
export async function evmPoolSend(helper: string, body: { pool: string; data: Uint8Array; epoch: bigint }, fetchFn: typeof fetch = fetch): Promise<string> {
  const window = new AbortController();
  const t = setTimeout(() => window.abort(new DOMException(`pool evm send: no answer in ${EVM_SEND_TIMEOUT_MS} ms`, "TimeoutError")), EVM_SEND_TIMEOUT_MS);
  try {
    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await fetchFn(`${helper}/v1/pool/evm/send`, {
        ...HELPER_FETCH_INIT,
        redirect: "error",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool: lower(body.pool), data: `0x${hexOf(body.data)}`, epoch: Number(body.epoch) }),
        signal: window.signal,
      });
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new EvmSendNoAnswer(null, (e as { name?: unknown })?.name === "TimeoutError" || window.signal.aborted ? "timeout" : "fault");
    }
    let json: unknown = null;
    try {
      json = bytes.length <= SEND_ANSWER_MAX ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null;
    } catch {
      json = null;
    }
    if (res.status === 429) {
      const header = res.headers.get("retry-after");
      const after = header === null || !/^[0-9]{1,6}$/.test(header.trim()) ? Number.NaN : Number(header.trim());
      throw new EvmSendBusy(Number.isInteger(after) ? Math.min(after, EVM_SEND_RETRY_MAX_S) * 1_000 : 1_000);
    }
    if (res.status >= 400 && res.status <= 499) {
      const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
      if (typeof code === "string" && CODE.test(code)) throw new EvmSendRefused(res.status, code);
      throw new EvmSendNoAnswer(res.status, "no code");
    }
    if (res.status !== 200) throw new EvmSendNoAnswer(res.status, "not 200");
    const hash = (json as { hash?: unknown } | null)?.hash;
    if (typeof hash !== "string" || !HASH.test(lower(hash))) throw new EvmSendNoAnswer(200, "no hash");
    return lower(hash);
  } finally {
    clearTimeout(t);
  }
}

/** A release the pool logged: Bought (the swap ran) or Withdrawn (the swap failed and W got the value less the fee in
 *  ETH), with its recipient, fee recipient, value, fee and spent nullifier; a Bought's token and out. */
export type EvmRelease = {
  kind: "bought" | "withdrawn";
  block: bigint;
  tx: string;
  index: bigint;
  recipient: string;
  feeRecipient: string;
  value: bigint;
  fee: bigint;
  nullifier: bigint;
  token?: string;
  out?: bigint;
};
/** One RPC's read: the pool's releases from `from` to its newest block, and that block's number and time (ms). */
export type EvmReleaseRead = { head: { number: bigint; timeMs: bigint }; releases: EvmRelease[] };

const topicOf = (signature: string): string => `0x${hexOf(keccak_256(enc.encode(signature)))}`;
const TOPIC_BOUGHT = /* @__PURE__ */ topicOf(EVM_POOL_EVENTS.Bought);
const TOPIC_WITHDRAWN = /* @__PURE__ */ topicOf(EVM_POOL_EVENTS.Withdrawn);
const dataWords = (data: string): bigint[] | null => (/^0x([0-9a-f]{64})*$/.test(data) ? (data.slice(2).match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`)) : null);
const big = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
const addressOf = (v: bigint): string | null => (v < 1n << 160n ? `0x${v.toString(16).padStart(40, "0")}` : null);
const hexQ = (v: bigint): string => `0x${v.toString(16)}`;

/** One RPC's newest block number: where a read-back starts, read before the send. */
export async function evmHeadNumber(rpc: EvmRpc): Promise<bigint> {
  const n = big(await rpc("eth_blockNumber", []));
  if (n === null) throw new Error("read-back: not a block number");
  return n;
}

/** One RPC's read of the pool's releases since `from`: its newest block (number and time), then the pool's Bought and
 *  Withdrawn logs from `from` to that block, asked by the pool's address and the two topics only. A log of another
 *  address or topic, a removed one, or one whose fields do not parse is left out; a read that fails throws. */
export async function evmReleaseRead(rpc: EvmRpc, pool: string, from: bigint): Promise<EvmReleaseRead> {
  const b = (await rpc("eth_getBlockByNumber", ["latest", false])) as Record<string, unknown> | null;
  const number = big(b?.number);
  const time = big(b?.timestamp);
  if (number === null || time === null) throw new Error("read-back: not a block");
  const head = { number, timeMs: time * 1_000n };
  if (number < from) return { head, releases: [] };
  const logs = (await rpc("eth_getLogs", [{ address: lower(pool), topics: [[TOPIC_BOUGHT, TOPIC_WITHDRAWN]], fromBlock: hexQ(from), toBlock: hexQ(number) }])) as unknown;
  if (!Array.isArray(logs)) throw new Error("read-back: not a log list");
  const releases: EvmRelease[] = [];
  for (const l of logs as Record<string, unknown>[]) {
    if (typeof l !== "object" || l === null || l.removed === true || typeof l.address !== "string" || lower(l.address) !== lower(pool)) continue;
    const topics = Array.isArray(l.topics) ? (l.topics as unknown[]).map((t) => (typeof t === "string" ? lower(t) : "")) : [];
    const d = typeof l.data === "string" ? dataWords(lower(l.data)) : null;
    const block = big(l.blockNumber);
    const index = big(l.logIndex);
    const tx = typeof l.transactionHash === "string" && HASH.test(lower(l.transactionHash)) ? lower(l.transactionHash) : null;
    const who = big(topics[1]);
    if (d === null || block === null || index === null || tx === null || who === null || block < from || block > number) continue;
    const recipient = addressOf(who);
    const feeRecipient = addressOf(d[0] ?? U256);
    if (recipient === null || feeRecipient === null) continue;
    const base = { block, tx, index, recipient, feeRecipient, value: d[1]!, fee: d[2]!, nullifier: d[3]! };
    if (topics[0] === TOPIC_BOUGHT && d.length === 7) {
      const token = addressOf(d[5]!);
      if (token !== null) releases.push({ kind: "bought", ...base, token, out: d[6]! });
    } else if (topics[0] === TOPIC_WITHDRAWN && d.length === 5) releases.push({ kind: "withdrawn", ...base });
  }
  return { head, releases };
}

/** What this buy is, from its two RPCs' reads: the nullifier's release the same on both (one each, the same block,
 *  transaction, index and fields) is this buy's when it pays W and the pinned fee recipient the chunk less the fee, as
 *  a Bought of the token at least min out (filled) or a Withdrawn (the swap failed: W holds the ETH); any other release
 *  of the nullifier spent the note elsewhere, so this buy can never land (not_landed). No release on either, and both
 *  RPCs' newest block past the proof's deadline: the pool refuses it from then on (not_landed). Else null: read again. */
export type EvmBuyWant = { nullifier: bigint; w: string; feeRecipient: string; token: string; minOut: bigint; value: bigint; fee: bigint; deadlineMs: bigint };
export type EvmBuyVerdict = { end: "filled"; release: EvmRelease & { out: bigint } } | { end: "withdrawn"; release: EvmRelease } | { end: "not_landed"; release: EvmRelease | null } | null;
const sameRelease = (a: EvmRelease, b: EvmRelease): boolean =>
  a.kind === b.kind && a.block === b.block && a.tx === b.tx && a.index === b.index && a.recipient === b.recipient && a.feeRecipient === b.feeRecipient && a.value === b.value && a.fee === b.fee && a.nullifier === b.nullifier && a.token === b.token && a.out === b.out;
export function evmBuyVerdict(reads: readonly [EvmReleaseRead, EvmReleaseRead], want: EvmBuyWant): EvmBuyVerdict {
  const [a, b] = reads.map((r) => r.releases.filter((x) => x.nullifier === want.nullifier)) as [EvmRelease[], EvmRelease[]];
  if (a.length === 0 && b.length === 0) return reads.every((r) => r.head.timeMs > want.deadlineMs) ? { end: "not_landed", release: null } : null;
  if (a.length !== 1 || b.length !== 1 || !sameRelease(a[0]!, b[0]!)) return null;
  const x = a[0]!;
  const paid = x.recipient === lower(want.w) && x.feeRecipient === lower(want.feeRecipient) && x.value === want.value && x.fee === want.fee;
  if (paid && x.kind === "bought" && x.token === lower(want.token) && x.out !== undefined && x.out >= want.minOut) return { end: "filled", release: x as EvmRelease & { out: bigint } };
  if (paid && x.kind === "withdrawn") return { end: "withdrawn", release: x };
  return { end: "not_landed", release: x };
}
