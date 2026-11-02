// POST /v1/pool/evm/send (card helper-pool-senders; v2 M3): the helper's EVM sender carries a pool withdraw the device
// built, byte for byte as its calldata, or refuses it. The sender is an operating key holding only gas, read from the
// host's environment; it signs one EIP-1559 transaction to the pool with value 0 and exactly the calldata received, and
// takes only the fee the proof's context caps, paid to the release's fee recipient.
//
// The body: { "pool": "0x<the pool>", "data": "0x<calldata>", "epoch": <the start, ms, of the epoch whose fee the
// proof binds> }. Checks, each a refusal before any send (422 unless named):
//   bad_shape        not withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256) in its one
//                    canonical ABI encoding (every offset, length and padding as the encoder writes them, nothing
//                    after), or over EVM_BODY_DATA_MAX (400);
//   not_pool         the withdrawal's processooor is not the pool the body names, which this helper carries;
//   fee_recipient    the request pays the fee to anyone but this release's fee recipient;
//   epoch_off        the epoch is not inside the proof's life (deadlineMs - POOL_LIFE_MAX_MS up to the deadline), is
//                    later than the epoch now, or the chain has no block in it yet;
//   fee_off          the fee is not the fee this helper publishes for that epoch (M352 (2): max(the floor,
//                    2 x EVM_WITHDRAW_GAS x the base fee of the epoch's first block), on its step);
//   fee_over_cap     the fee is over the request's feeCap (the pool refuses it too: FeeOverCap);
//   simulation_failed eth_call of the exact transaction from the sender reverts, or its gas is over EVM_GAS_MAX;
//   upstream (503)   a read could not be made, or the two providers name different chains.
// A nullifier is sent once (./once.ts): a repeat gets the first hash and sends nothing, unless that send reverted. Each
// send's maxFeePerGas is at most fee / gas limit, so the sender never pays more gas than the fee.
// Answer: 200 { hash }. pool-evm-buy adds buy() with W's EIP-712 signature: its selector goes in SELECTORS with its own
// decoder, and the same fee, recipient, simulation and send rules apply.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaJsonRpc } from "@blindfill/kit";
import { epochStartOf, POOL_EPOCH_MS } from "./fee.ts";
import { oncePerNullifier } from "./once.ts";

/** POST /v1/pool/evm/send's body limit, and the calldata's (a withdraw is 4 + 32 x 26 = 836 bytes). */
export const POOL_EVM_BODY_MAX = 4_096;
export const EVM_BODY_DATA_MAX = 1_024;
/** The most gas the helper pays for one withdraw: the measured Privacy Pools withdrawal is 611,391 (M349), so 2.5x [design]. */
export const EVM_GAS_MAX = 1_500_000n;

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const selectorOf = (sig: string): string => hex(keccak_256(new TextEncoder().encode(sig)).subarray(0, 4));
export const WITHDRAW_SIGNATURE = "withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)";
export const WITHDRAW_SELECTOR = selectorOf(WITHDRAW_SIGNATURE);

const word = (d: Uint8Array, i: number): bigint => BigInt(`0x${hex(d.subarray(4 + 32 * i, 4 + 32 * (i + 1))) || "0"}`);
const W_OFFSET = 18n * 32n; // the Withdrawal tuple's tail starts after 1 + 16 + 1 head words
const RELAY_WORDS = 6; // recipient, feeRecipient, feeCap, deadlineMs, refundPrecommitment, salt
const WITHDRAW_LEN = 4 + 32 * (18 + 3 + RELAY_WORDS);
const isAddressWord = (w: bigint) => w >> 160n === 0n;
const addr = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}`;

export type EvmWithdraw = { processooor: string; recipient: string; feeRecipient: string; feeCap: bigint; deadlineMs: bigint; fee: bigint; nullifier: string };

/** A withdraw's calldata read back; throws unless it is exactly the one canonical encoding. */
export function evmReadWithdraw(d: Uint8Array): EvmWithdraw {
  if (d.length !== WITHDRAW_LEN || hex(d.subarray(0, 4)) !== WITHDRAW_SELECTOR) throw new Error("not withdraw's calldata");
  if (word(d, 0) !== W_OFFSET) throw new Error("the withdrawal's offset");
  const fee = word(d, 17);
  const processooor = word(d, 18);
  if (!isAddressWord(processooor) || word(d, 19) !== 64n || word(d, 20) !== BigInt(32 * RELAY_WORDS)) throw new Error("the withdrawal's layout");
  const r = (i: number) => word(d, 21 + i);
  if (!isAddressWord(r(0)) || !isAddressWord(r(1)) || r(3) >> 64n !== 0n || (r(5) & ((1n << 128n) - 1n)) !== 0n) throw new Error("the relay data's padding");
  // pubSignals[1], existingNullifierHash: head word 1 + 2 (pA) + 4 (pB) + 2 (pC) + 1
  const nullifier = word(d, 10).toString(16).padStart(64, "0");
  return { processooor: addr(processooor), recipient: addr(r(0)), feeRecipient: addr(r(1)), feeCap: r(2), deadlineMs: r(3), fee, nullifier };
}

// ---- RLP and the EIP-1559 transaction ----

type Rlp = Uint8Array | Rlp[];
const big = (n: bigint): Uint8Array => (n === 0n ? new Uint8Array() : unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0")));
function rlpLen(len: number, short: number): Uint8Array {
  if (len < 56) return Uint8Array.of(short + len);
  const l = big(BigInt(len));
  return Uint8Array.of(short + 55 + l.length, ...l);
}
export function rlp(x: Rlp): Uint8Array {
  if (x instanceof Uint8Array) return x.length === 1 && x[0]! < 0x80 ? x : Uint8Array.from([...rlpLen(x.length, 0x80), ...x]);
  const body = x.map(rlp);
  const n = body.reduce((s, b) => s + b.length, 0);
  return Uint8Array.from([...rlpLen(n, 0xc0), ...body.flatMap((b) => [...b])]);
}

export type EvmTx = { chainId: bigint; nonce: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; gas: bigint; to: string; data: Uint8Array };

/** The signed type-2 transaction (EIP-1559): value 0, no access list. */
export function signEvmTx(tx: EvmTx, key: Uint8Array): { raw: Uint8Array; hash: string } {
  const fields: Rlp[] = [big(tx.chainId), big(tx.nonce), big(tx.maxPriorityFeePerGas), big(tx.maxFeePerGas), big(tx.gas), unhex(tx.to.slice(2)), new Uint8Array(), tx.data, []];
  const digest = keccak_256(Uint8Array.from([2, ...rlp(fields)]));
  const sig = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const recovery = sig[0]!;
  const r = BigInt(`0x${hex(sig.subarray(1, 33))}`);
  const s = BigInt(`0x${hex(sig.subarray(33, 65))}`);
  const raw = Uint8Array.from([2, ...rlp([...fields, big(BigInt(recovery)), big(r), big(s)])]);
  return { raw, hash: `0x${hex(keccak_256(raw))}` };
}

/** The address of a secp256k1 private key. */
export function evmAddressOf(key: Uint8Array): string {
  return `0x${hex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12))}`;
}

// ---- The epoch fee (M352 (2)) ----

/**
 * The withdraw's gas the fee is priced on: Privacy Pools' withdrawal, 611,391, measured twice by the CO (M349). A
 * constant, never a reading, so every caller and every restart prices an epoch the same.
 */
export const EVM_WITHDRAW_GAS = 611_391n;
/** The coarse step every EVM fee is rounded up to, in wei: 0.00001 ETH [design]. */
export const EVM_FEE_STEP = 10n ** 13n;
/** The longest a proof lives, ms: the device's cap on deadline_ms (wallet withdraw/request.ts WITHDRAW_DEADLINE_MAX_MS). */
export const POOL_LIFE_MAX_MS = 600_000;
/** How many epochs' fees each sender remembers [design: well past one proof life of 10 epochs]. */
const EPOCH_MEMORY = 64;

export type EvmBlock = { number: bigint; timestamp: bigint; hash: string; baseFeePerGas: bigint };
const blockOf = (v: unknown): EvmBlock => {
  const b = v as { number?: unknown; timestamp?: unknown; hash?: unknown; baseFeePerGas?: unknown } | null;
  if (typeof b?.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(b.hash)) throw new Error("not a block");
  return { number: qty(b.number), timestamp: qty(b.timestamp), hash: b.hash, baseFeePerGas: qty(b.baseFeePerGas) };
};
const tag = (n: bigint) => `0x${n.toString(16)}`;

/**
 * The first block at or after `seconds`, read on `rpc`: null when the newest block is still before it. Steps back from
 * the newest block, doubling, until a block is before it, then halves the gap.
 */
export async function evmFirstBlockAtOrAfter(rpc: EvmRpc, seconds: bigint): Promise<EvmBlock | null> {
  const at = async (n: bigint | "latest") => blockOf(await rpc("eth_getBlockByNumber", [n === "latest" ? n : tag(n), false]));
  let hi = await at("latest");
  if (hi.timestamp < seconds) return null;
  let step = hi.timestamp - seconds + 1n;
  let lo: EvmBlock | null = null;
  for (;;) {
    if (hi.number === 0n) return hi;
    const n = hi.number > step ? hi.number - step : 0n;
    const b = await at(n);
    if (b.timestamp < seconds) {
      lo = b;
      break;
    }
    hi = b;
    step *= 2n;
  }
  while (hi.number - lo.number > 1n) {
    const mid = await at((lo.number + hi.number) / 2n);
    if (mid.timestamp >= seconds) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The epoch's fee: max(floor, 2 x EVM_WITHDRAW_GAS x the base fee of the epoch's first block), rounded up to the step. */
export function evmEpochFee(floor: bigint, baseFeePerGas: bigint): bigint {
  const gas = 2n * EVM_WITHDRAW_GAS * baseFeePerGas;
  const stepped = ((gas + EVM_FEE_STEP - 1n) / EVM_FEE_STEP) * EVM_FEE_STEP;
  return stepped > floor ? stepped : floor;
}

// ---- The sender ----

export type EvmRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type PoolEvmCode = "bad_shape" | "not_pool" | "fee_recipient" | "fee_off" | "fee_over_cap" | "epoch_off" | "simulation_failed" | "upstream";
export type PoolEvmAnswer = { status: number; body: { hash: string } | { error: { code: PoolEvmCode; detail?: string } } };
export type EvmFeeAnswer = { chain: "evm"; network: string; pool: string; fee_recipient: string; epoch_ms: number; epoch_start_ms: number; block: string; fee: string; step: string };

export type EvmPoolSender = {
  readonly network: string;
  readonly pool: string;
  readonly sender: string;
  /** GET /v1/pool/fee: the epoch's fee (the epoch holding `atMs`), in wei; null while the chain has no block in it yet. */
  fee(atMs: number): Promise<EvmFeeAnswer | null>;
  carry(body: unknown): Promise<PoolEvmAnswer>;
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x([0-9a-f]{2})+$/;
const qty = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(v)) throw new Error("not a quantity");
  return BigInt(v);
};

/**
 * One pool's sender. `floor` is the least fee, in wei (the pool's asset is the chain's native coin, PrivacyPoolSimple);
 * `feeRecipient` is where the release takes it. Sends one at a time, so each takes the next nonce; one per nullifier.
 */
export function evmPoolSender(
  cfg: { network: string; pool: string; senderKey: Uint8Array; floor: bigint; feeRecipient?: string; memory?: number },
  providers: readonly [EvmRpc, EvmRpc],
  now: () => number = Date.now,
): EvmPoolSender {
  const pool = cfg.pool.toLowerCase();
  if (!ADDRESS.test(pool)) throw new Error("the pool must be an address");
  const sender = evmAddressOf(cfg.senderKey);
  const feeRecipient = (cfg.feeRecipient ?? sender).toLowerCase();
  if (!ADDRESS.test(feeRecipient)) throw new Error("the fee recipient must be an address");
  const [a, b] = providers;
  let chainId: Promise<bigint> | null = null;
  let nextNonce = -1n;
  let queue: Promise<unknown> = Promise.resolve();
  const once = oncePerNullifier<PoolEvmAnswer>(cfg.memory);
  const fees = new Map<number, Promise<{ block: EvmBlock; fee: bigint } | null>>();
  const no = (status: number, code: PoolEvmCode, detail?: string): PoolEvmAnswer => ({ status, body: { error: { code, ...(detail ? { detail } : {}) } } });
  const chain = (): Promise<bigint> => {
    chainId ??= Promise.all([a("eth_chainId", []), b("eth_chainId", [])]).then(([x, y]) => {
      if (qty(x) !== qty(y)) throw new Error("the providers name different chains");
      return qty(x);
    });
    return chainId.catch((e) => {
      chainId = null;
      throw e;
    });
  };
  /** The epoch's first block, on provider A and the same hash on B, and its fee; cached once both agree. */
  const feeOf = (epochStartMs: number): Promise<{ block: EvmBlock; fee: bigint } | null> => {
    const known = fees.get(epochStartMs);
    if (known) return known;
    const p = (async () => {
      const block = await evmFirstBlockAtOrAfter(a, BigInt(Math.ceil(epochStartMs / 1000)));
      if (block === null) return null;
      const same = blockOf(await b("eth_getBlockByNumber", [tag(block.number), false]));
      if (same.hash !== block.hash) throw new Error("the providers hold different blocks");
      return { block, fee: evmEpochFee(cfg.floor, block.baseFeePerGas) };
    })();
    fees.set(epochStartMs, p);
    p.then((v) => v === null && fees.delete(epochStartMs), () => fees.delete(epochStartMs));
    while (fees.size > EPOCH_MEMORY) fees.delete(fees.keys().next().value as number);
    return p;
  };
  const carry = async (body: unknown): Promise<PoolEvmAnswer> => {
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 3) return no(400, "bad_shape");
    const { pool: p, data, epoch } = body as { pool?: unknown; data?: unknown; epoch?: unknown };
    if (p !== pool || typeof data !== "string" || data.length > 2 + 2 * EVM_BODY_DATA_MAX || !HEX.test(data)) return no(400, "bad_shape");
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || epoch % POOL_EPOCH_MS !== 0) return no(400, "bad_shape");
    const bytes = unhex(data.slice(2));
    let w: EvmWithdraw;
    try {
      w = evmReadWithdraw(bytes);
    } catch (e) {
      return no(400, "bad_shape", (e as Error).message);
    }
    if (w.processooor !== pool) return no(422, "not_pool");
    if (w.feeRecipient !== feeRecipient) return no(422, "fee_recipient");
    // the proof's epoch: inside its life (at most POOL_LIFE_MAX_MS before its deadline, before the deadline) and never
    // later than the epoch now
    const deadline = Number(w.deadlineMs);
    if (epoch < deadline - POOL_LIFE_MAX_MS || epoch >= deadline || epoch > epochStartOf(now())) return no(422, "epoch_off");
    let epochFee: { block: EvmBlock; fee: bigint } | null;
    try {
      epochFee = await feeOf(epoch);
    } catch {
      return no(503, "upstream");
    }
    if (epochFee === null) return no(422, "epoch_off", "no block in the epoch yet");
    if (w.fee !== epochFee.fee) return no(422, "fee_off", `fee ${w.fee}, published ${epochFee.fee} for epoch ${epoch}`);
    if (w.fee > w.feeCap) return no(422, "fee_over_cap", `fee ${w.fee}, cap ${w.feeCap}`);
    // one send per nullifier (./once.ts): a repeat gets the first hash, unless that send reverted on chain
    const prior = once.get(w.nullifier);
    if (prior) {
      const first = await prior;
      const hash = (first.body as { hash?: string }).hash;
      const rc = hash ? await a("eth_getTransactionReceipt", [hash]).catch(() => null) : null;
      if ((rc as { status?: unknown } | null)?.status !== "0x0") return first;
      once.forget(w.nullifier);
    }
    return once.run(w.nullifier, () => {
      const run = queue.then(() => simulateSignSend(data, bytes, w.fee));
      queue = run.catch(() => {});
      return run;
    });
  };
  async function simulateSignSend(data: string, bytes: Uint8Array, fee: bigint): Promise<PoolEvmAnswer> {
    const call = { from: sender, to: pool, data, value: "0x0" };
    let id: bigint, gas: bigint, base: bigint, tip: bigint, pending: bigint;
    try {
      id = await chain();
      try {
        await a("eth_call", [call, "latest"]);
        gas = qty(await a("eth_estimateGas", [call, "latest"]));
      } catch (e) {
        return no(422, "simulation_failed", String((e as Error).message).slice(0, 200));
      }
      const [block, t, n] = await Promise.all([a("eth_getBlockByNumber", ["latest", false]), a("eth_maxPriorityFeePerGas", []), a("eth_getTransactionCount", [sender, "pending"])]);
      base = qty((block as { baseFeePerGas?: unknown })?.baseFeePerGas);
      tip = qty(t);
      pending = qty(n);
    } catch {
      return no(503, "upstream");
    }
    gas = (gas * 12n) / 10n;
    if (gas > EVM_GAS_MAX) return no(422, "simulation_failed", `gas ${gas} over ${EVM_GAS_MAX}`);
    // the sender never pays more gas than the fee: maxFeePerGas at most fee / gas limit; past that the transaction
    // waits in the mempool until the base fee comes back under it
    const cap = fee / gas;
    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;
    const maxPriorityFeePerGas = tip < maxFeePerGas ? tip : maxFeePerGas;
    const nonce = pending > nextNonce ? pending : nextNonce;
    const { raw, hash } = signEvmTx({ chainId: id, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to: pool, data: bytes }, cfg.senderKey);
    const sent = await Promise.allSettled([a("eth_sendRawTransaction", [`0x${hex(raw)}`]), b("eth_sendRawTransaction", [`0x${hex(raw)}`])]);
    if (sent.every((s) => s.status === "rejected")) return no(503, "upstream");
    nextNonce = nonce + 1n;
    return { status: 200, body: { hash } };
  }
  return {
    network: cfg.network,
    pool,
    sender,
    async fee(atMs) {
      const epoch = epochStartOf(atMs);
      const f = await feeOf(epoch);
      if (f === null) return null;
      return { chain: "evm", network: cfg.network, pool, fee_recipient: feeRecipient, epoch_ms: POOL_EPOCH_MS, epoch_start_ms: epoch, block: tag(f.block.number), fee: f.fee.toString(), step: EVM_FEE_STEP.toString() };
    },
    carry,
  };
}

/** Per network: the pool, the sender's key (0x + 64 hex, gas only), the fee's floor (wei), its recipient, two RPC URLs. */
export const POOL_EVM_ENV = {
  base: ["POOL_EVM_ADDRESS_BASE", "POOL_EVM_SENDER_KEY_BASE", "POOL_EVM_FEE_BASE", "POOL_EVM_FEE_RECIPIENT_BASE", "POOL_EVM_RPCS_BASE"],
  robinhood: ["POOL_EVM_ADDRESS_ROBINHOOD", "POOL_EVM_SENDER_KEY_ROBINHOOD", "POOL_EVM_FEE_ROBINHOOD", "POOL_EVM_FEE_RECIPIENT_ROBINHOOD", "POOL_EVM_RPCS_ROBINHOOD"],
  "base-sepolia": ["POOL_EVM_ADDRESS_BASE_SEPOLIA", "POOL_EVM_SENDER_KEY_BASE_SEPOLIA", "POOL_EVM_FEE_BASE_SEPOLIA", "POOL_EVM_FEE_RECIPIENT_BASE_SEPOLIA", "POOL_EVM_RPCS_BASE_SEPOLIA"],
} as const;

/** The EVM pool senders the host's environment sets, by pool address; a network with none of its names set is off. */
export function evmPoolSendersFromEnv(env: Record<string, string | undefined>): Map<string, EvmPoolSender> {
  const out = new Map<string, EvmPoolSender>();
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    const [pool, key, fee, feeTo, rpcs] = names.map((n) => env[n] ?? "");
    if (pool === "" && key === "" && fee === "" && feeTo === "" && rpcs === "") continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool!)) throw new Error(`${names[0]} must be an address`);
    if (!/^0x[0-9a-f]{64}$/.test(key!)) throw new Error(`${names[1]} must be 0x and 64 lowercase hex`);
    if (!/^[1-9][0-9]{0,37}$/.test(fee!)) throw new Error(`${names[2]} must be a whole number of wei`);
    const urls = rpcs!.split(",");
    if (urls.length !== 2 || urls[0] === urls[1]) throw new Error(`${names[4]} must be two different RPC URLs`);
    const providers = urls.map((u) => solanaJsonRpc(u)) as unknown as [EvmRpc, EvmRpc]; // a plain JSON-RPC client
    const s = evmPoolSender({ network, pool: pool!, senderKey: unhex(key!.slice(2)), floor: BigInt(fee!), ...(feeTo === "" ? {} : { feeRecipient: feeTo! }) }, providers);
    out.set(s.pool, s);
  }
  return out;
}
