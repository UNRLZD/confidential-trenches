// Verify's pool rows (card verify-pools): each pool read on its chain's two public RPCs from the device, never through
// the helper, and judged the way model.ts judges the vault: a check is judged only on an answer both RPCs gave, the
// same value (and, on an EVM chain, at the one block with the same block hash); an answer one RPC did not give is
// Unverified on its check, two different answers are RPCs disagree, each amber (neither ok nor danger).
//   - Solana: the program account is the upgradeable loader's, executable, pointing at the pinned programdata; the
//     programdata's upgrade authority is none (its Option byte at 12 is 0) and the sha256 of its code's `codeLen`
//     bytes is the pin, every byte after them 0 (scripts/live-checks/pool-sol-deploy.mjs reads the same bytes).
//   - Base, Robinhood: owner() answers no nonzero owner, the EIP-1967 implementation, admin and beacon slots are 0, and
//     the keccak256 of eth_getCode is the pinned code hash (scripts/live-checks/pool-evm-deploy.mjs reads the same).
// Nothing here throws on an RPC's answer.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { short, type VerifyStatus, type VerifyValue } from "./model.ts";

export type PoolChain = "solana" | "base" | "robinhood";
export const POOL_CHAINS: readonly PoolChain[] = ["solana", "base", "robinhood"];
/** Each pool row's name: its chain's, data as deposit/model.ts CHAIN_NAME draws it, not copy. */
export const CHAIN_NAME: Readonly<Record<PoolChain, string>> = { solana: "Solana", base: "Base", robinhood: "Robinhood" };

/** A Solana pool program as its deploy record names it: program_id, programdata, so_len, so_sha256 (hex). */
export type SolanaPoolPin = { program: string; programdata: string; codeLen: number; codeSha256: string };
/** An EVM pool as its deploy record names it (the PrivacyPoolSimple address) and its runtime code's keccak256. */
export type EvmPoolPin = { address: string; codeHash: string };
export type PoolPin<C extends PoolChain = PoolChain> = {
  chain: C;
  /** The two RPCs the row reads, each another operator's, both on the page's connect-src. */
  rpcs: readonly [string, string];
  pin: C extends "solana" ? SolanaPoolPin : EvmPoolPin;
};
export type PoolPins = { readonly [C in PoolChain]: PoolPin<C> | null };

export type PoolCheckId = "authority" | "owner" | "proxy" | "poolCode";
export type PoolCheck = { id: PoolCheckId; status: VerifyStatus; word: "unverified" | "disagree" | null; values: VerifyValue[] };
export type PoolExplorer = { name: "solscan" | "solanaExplorer" | "basescan" | "blockscout" | "rhExplorer" | "hoodscan"; href: string };
export type PoolRow = { chain: PoolChain; status: VerifyStatus; checks: PoolCheck[]; height: string; rpcs: string[]; explorers: PoolExplorer[] };
export type PoolsView = { state: "loading" } | { state: "read"; rows: PoolRow[] };

/** Each pool's two explorers, at the address its row reads (the program on Solana, the pool contract on EVM). */
export function poolExplorers(chain: PoolChain, address: string): PoolExplorer[] {
  const a = encodeURIComponent(address);
  if (chain === "solana") return [{ name: "solscan", href: `https://solscan.io/account/${a}` }, { name: "solanaExplorer", href: `https://explorer.solana.com/address/${a}` }];
  if (chain === "base") return [{ name: "basescan", href: `https://basescan.org/address/${a}` }, { name: "blockscout", href: `https://base.blockscout.com/address/${a}` }];
  return [{ name: "rhExplorer", href: `https://robinhoodchain.blockscout.com/address/${a}` }, { name: "hoodscan", href: `https://hoodscan.co/address/${a}` }];
}

// ------------------------------------------------------------------------------------------------ the reads
/** One JSON-RPC call to a URL; a status other than 200, a body that is not JSON or no answer in time throws. */
export type PoolRpc = (url: string, method: string, params: unknown[], signal?: AbortSignal) => Promise<unknown>;
export const POOL_READ_MS = 10_000;
export function poolRpc(fetchFn: typeof fetch = fetch): PoolRpc {
  return async (url, method, params, signal) => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(POOL_READ_MS)]) : AbortSignal.timeout(POOL_READ_MS),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  };
}
const failed = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

export const SOLANA_READS = ["accounts"] as const;
export const EVM_READS = ["block", "code", "owner", "implementation", "admin", "beacon"] as const;
export type PoolReadId = (typeof SOLANA_READS)[number] | (typeof EVM_READS)[number];
/** One RPC's answers: each read's whole JSON-RPC answer, or { error } when the call failed. */
export type PoolRpcReads = { name: string; answers: Partial<Record<PoolReadId, unknown>> };
/** What a row read: the block both EVM RPCs were asked at (null on Solana, read at finalized), and each RPC's answers. */
export type PoolReads = { chain: PoolChain; height: number | null; rpcs: [PoolRpcReads, PoolRpcReads] };

// EIP-1967: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1), .admin and .beacon likewise
export const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;
const OWNER = "0x8da5cb5b"; // owner()

const headOf = (a: unknown): number | null => {
  const h = (a as { result?: unknown } | null)?.result;
  return typeof h === "string" && /^0x[0-9a-f]{1,16}$/i.test(h) ? Number(BigInt(h)) : null;
};

/** Reads one pool on its two RPCs: Solana's two accounts at finalized; an EVM pool's six reads at the lower of the two heads. */
export async function readPool(p: PoolPin, rpc: PoolRpc, signal?: AbortSignal): Promise<PoolReads> {
  const ask = (url: string, method: string, params: unknown[]) => rpc(url, method, params, signal).catch(failed);
  if (p.chain === "solana") {
    const pin = p.pin as SolanaPoolPin;
    const one = async (url: string): Promise<PoolRpcReads> => ({
      name: url,
      answers: { accounts: await ask(url, "getMultipleAccounts", [[pin.program, pin.programdata], { encoding: "base64", commitment: "finalized" }]) },
    });
    const [a, b] = await Promise.all(p.rpcs.map(one));
    return { chain: p.chain, height: null, rpcs: [a!, b!] };
  }
  const pin = p.pin as EvmPoolPin;
  const heads = await Promise.all(p.rpcs.map((u) => ask(u, "eth_blockNumber", []).then(headOf)));
  const known = heads.filter((h): h is number => h !== null);
  if (known.length === 0) throw new Error(`Verify read no head on ${p.rpcs.join(" or ")}`);
  const height = Math.min(...known);
  const at = `0x${height.toString(16)}`;
  const one = async (url: string): Promise<PoolRpcReads> => {
    const got = await Promise.all([
      ask(url, "eth_getBlockByNumber", [at, false]),
      ask(url, "eth_getCode", [pin.address, at]),
      ask(url, "eth_call", [{ to: pin.address, data: OWNER }, at]),
      ask(url, "eth_getStorageAt", [pin.address, EIP1967.implementation, at]),
      ask(url, "eth_getStorageAt", [pin.address, EIP1967.admin, at]),
      ask(url, "eth_getStorageAt", [pin.address, EIP1967.beacon, at]),
    ]);
    return { name: url, answers: Object.fromEntries(EVM_READS.map((id, i) => [id, got[i]])) };
  };
  const [a, b] = await Promise.all(p.rpcs.map(one));
  return { chain: p.chain, height, rpcs: [a!, b!] };
}

// ------------------------------------------------------------------------------------------------ the decode
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^0x([0-9a-f]{2})*$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
const ZERO = /^0x0*$/i;
/** A nonzero word as the address in its low 20 bytes (an owner, an implementation, an admin or a beacon). */
const addressOf = (w: string) => `0x${w.slice(-40).toLowerCase()}`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of bytes (Solana's account ids). */
export function base58(b: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of b) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of b) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}
const b64 = (s: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAMDATA_HEADER = 45; // u32 tag 3, u64 slot, Option<Pubkey> (1 + 32)

/** What a check is judged on, decoded from one RPC's answers; undefined is not read (an error, another block, another shape). */
type Decoded = { [K in PoolCheckId]?: { key: string; value: string | null; extra?: string } };

async function sha256Hex(b: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)));
}

/** Solana: the program account and its programdata, both of the upgradeable loader. */
async function decodeSolana(a: unknown, pin: SolanaPoolPin): Promise<{ d: Decoded; slot: number | null }> {
  const d: Decoded = {};
  if (!isObj(a) || a.error !== undefined || !isObj(a.result)) return { d, slot: null };
  const ctx = a.result.context;
  const slot = isObj(ctx) && Number.isSafeInteger(ctx.slot) ? (ctx.slot as number) : null;
  const v = a.result.value;
  if (!Array.isArray(v) || v.length !== 2) return { d, slot };
  const acct = (x: unknown) => (isObj(x) && Array.isArray(x.data) && typeof x.data[0] === "string" && x.data[1] === "base64" ? { owner: x.owner, executable: x.executable, data: b64(x.data[0]) } : null);
  const [prog, pd] = [acct(v[0]), acct(v[1])];
  // the programdata: tag 3, then the Option of the upgrade authority at byte 12
  if (pd?.data && pd.owner === UPGRADEABLE_LOADER && pd.data.length >= PROGRAMDATA_HEADER && pd.data[0] === 3 && pd.data[1] === 0 && pd.data[2] === 0 && pd.data[3] === 0) {
    const opt = pd.data[12];
    if (opt === 0) d.authority = { key: "none", value: null };
    else if (opt === 1) d.authority = { key: base58(pd.data.subarray(13, 45)), value: base58(pd.data.subarray(13, 45)) };
    // the code: the program points at this programdata, and the code's bytes hash to the pin with nothing after them
    const points = prog?.data && prog.owner === UPGRADEABLE_LOADER && prog.executable === true && prog.data.length === 36 && prog.data[0] === 2 && base58(prog.data.subarray(4, 36)) === pin.programdata;
    const code = pd.data.subarray(PROGRAMDATA_HEADER);
    if (code.length >= pin.codeLen) {
      const sha = await sha256Hex(code.subarray(0, pin.codeLen));
      const tail = code.subarray(pin.codeLen).every((x) => x === 0);
      // a program that points elsewhere or a code with bytes after it is danger on this check, whatever its hash
      d.poolCode = { key: `${sha}:${points ? 1 : 0}:${tail ? 1 : 0}`, value: sha, ...(points && tail ? {} : { extra: "bad" }) };
    }
  }
  return { d, slot };
}

/** EVM: one RPC's six answers at `height`; each is read only when the block's answer is at that height. */
function decodeEvm(r: PoolRpcReads, height: number): { d: Decoded; hash: string | null } {
  const d: Decoded = {};
  const res = (id: PoolReadId) => (isObj(r.answers[id]) ? (r.answers[id] as Record<string, unknown>) : null);
  const blk = res("block")?.result;
  const hash = isObj(blk) && typeof blk.hash === "string" && WORD.test(blk.hash) && headOf({ result: blk.number }) === height ? blk.hash.toLowerCase() : null;
  if (hash === null) return { d, hash };
  const code = res("code");
  if (code && typeof code.result === "string" && HEX.test(code.result)) {
    const h = code.result === "0x" ? "0x" : `0x${hex(keccak_256(fromHex(code.result)))}`;
    d.poolCode = { key: h, value: h };
  }
  const own = res("owner");
  if (own) {
    const e = own.error;
    // a revert is the node's answer that there is no owner(); any other error is not read
    if (isObj(e) && (e.code === 3 || /revert/i.test(String(e.message)))) d.owner = { key: "none", value: null };
    else if (e === undefined && typeof own.result === "string" && (own.result === "0x" || WORD.test(own.result))) {
      d.owner = ZERO.test(own.result) ? { key: "none", value: null } : { key: addressOf(own.result), value: addressOf(own.result) };
    }
  }
  const slots = (["implementation", "admin", "beacon"] as const).map((id) => res(id)?.result);
  if (slots.every((s): s is string => typeof s === "string" && WORD.test(s))) {
    const set = slots.findIndex((s) => !ZERO.test(s));
    d.proxy = set < 0 ? { key: "none", value: null } : { key: slots.map(addressOf).join(","), value: addressOf(slots[set]!) };
  }
  return { d, hash };
}

// ------------------------------------------------------------------------------------------------ the view
const RANK: Record<VerifyStatus, number> = { ok: 0, warn: 1, danger: 2 };
const worst = (s: VerifyStatus[]) => s.reduce<VerifyStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const CHECKS: Record<PoolChain, PoolCheckId[]> = { solana: ["authority", "poolCode"], base: ["owner", "proxy", "poolCode"], robinhood: ["owner", "proxy", "poolCode"] };
const NONE = "—";

/** A check judged on one decoded answer against the pin. */
function judgeOne(id: PoolCheckId, x: NonNullable<Decoded[PoolCheckId]>, p: PoolPin): { status: VerifyStatus; values: VerifyValue[] } {
  if (id === "poolCode") {
    const want = p.chain === "solana" ? (p.pin as SolanaPoolPin).codeSha256 : (p.pin as EvmPoolPin).codeHash.toLowerCase();
    const ok = x.value === want && x.extra !== "bad";
    return { status: ok ? "ok" : "danger", values: [{ k: "codeHash", v: short(x.value ?? NONE) }, { k: "release", v: short(want) }] };
  }
  const k = id === "authority" ? "authority" : id === "owner" ? "owner" : "proxy";
  return { status: x.value === null ? "ok" : "danger", values: [{ k, v: x.value === null ? NONE : short(x.value) }] };
}

/** One pool's row from its two RPCs' reads (model.ts's rule: one answer from both, or amber). */
export async function poolRow(reads: PoolReads, p: PoolPin): Promise<PoolRow> {
  let decoded: Decoded[];
  let height: string;
  if (p.chain === "solana") {
    const both = await Promise.all(reads.rpcs.map((r) => decodeSolana(r.answers.accounts, p.pin as SolanaPoolPin)));
    decoded = both.map((x) => x.d);
    const slots = both.map((x) => x.slot).filter((s): s is number => s !== null);
    height = slots.length ? group(String(Math.min(...slots))) : NONE;
  } else {
    const both = reads.rpcs.map((r) => decodeEvm(r, reads.height ?? -1));
    // two block hashes that differ at one height: every check of the row is RPCs disagree
    const forked = both[0]!.hash !== null && both[1]!.hash !== null && both[0]!.hash !== both[1]!.hash;
    decoded = both.map((x) => (forked ? Object.fromEntries(Object.entries(x.d).map(([k, v]) => [k, { ...v!, key: `${x.hash}:${v!.key}` }])) : x.d));
    height = reads.height === null ? NONE : group(String(reads.height));
  }
  const checks = CHECKS[p.chain].map((id): PoolCheck => {
    const [a, b] = [decoded[0]![id], decoded[1]![id]];
    if (a && b && a.key === b.key) return { id, word: null, ...judgeOne(id, a, p) };
    const word = a && b ? "disagree" : "unverified";
    const values = [a, b].flatMap((x, i) => (x ? judgeOne(id, x, p).values.map((v) => ({ ...v, rpc: reads.rpcs[i]!.name })) : []));
    return { id, status: "warn", word, values };
  });
  return { chain: p.chain, status: worst(checks.map((c) => c.status)), checks, height, rpcs: reads.rpcs.map((r) => r.name), explorers: poolExplorers(p.chain, addressOfPin(p)) };
}

const addressOfPin = (p: PoolPin) => (p.chain === "solana" ? (p.pin as SolanaPoolPin).program : (p.pin as EvmPoolPin).address);

/** A row when nothing was read: no pool named on this network, or no head on either RPC. Every check Unverified. */
export function unverifiedPoolRow(chain: PoolChain, p: PoolPin | null, asked: readonly string[]): PoolRow {
  return {
    chain,
    status: "warn",
    checks: CHECKS[chain].map((id) => ({ id, status: "warn", word: "unverified", values: [] })),
    height: NONE,
    rpcs: [...asked],
    explorers: p ? poolExplorers(chain, addressOfPin(p)) : [],
  };
}

/** Every pool row, each read live on its pair; nothing kept between calls. */
export async function livePools(pins: PoolPins, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<PoolsView> {
  const rpc = poolRpc(fetchFn);
  const rows = await Promise.all(
    POOL_CHAINS.map(async (chain) => {
      const p = pins[chain] as PoolPin | null;
      if (p === null) return unverifiedPoolRow(chain, null, []);
      try {
        return await poolRow(await readPool(p, rpc, signal), p);
      } catch (e) {
        if (!signal?.aborted) console.error(e instanceof Error ? e.message : String(e));
        return unverifiedPoolRow(chain, p, p.rpcs);
      }
    }),
  );
  return { state: "read", rows };
}
