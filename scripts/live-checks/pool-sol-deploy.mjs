#!/usr/bin/env node
// Live check of card pool-sol-deploy: the Blindfill pool program on Solana devnet, immutable, with its SOL pool and
// one test deposit. On two RPCs of two operators, each answering devnet's genesis hash, it reads:
//   - the program account: executable, owned by the upgradeable loader (BPFLoaderUpgradeab1e...), pointing at the
//     programdata account its id derives;
//   - the programdata account: its upgrade authority is none (the 33-byte Option at bytes 12-44 is 0), and its code
//     is the build's: sha256 of the first so_len bytes equals the deployment record's, every byte after them is 0;
//   - the pool account at ["pool"]: owned by the program, POOL_LEN bytes, "bfpool01", its bump the canonical one;
//   - the test deposit's precommitment mark ["pre", precommitment]: owned by the program, 17 bytes, value u64 LE and
//     nonce u64 LE equal to the record's (M353), then the program's tag byte 1 (card pool-sol-mark-tag);
//   - both pages holding that deposit's leaves (["page", tree, page_no u32 LE]): the label leaf equals
//     keccak256(scope || nonce) mod p with the scope this program and pool give (contracts/pool-solana/src/context.rs),
//     so the pool was initialised for this program's scope; the state leaf equals the record's commitment, which the
//     deploy script computed as Poseidon(value, label, precommitment) and checked against this leaf when it deployed
//     (contracts/pool-solana/scripts/deploy.mjs; deploy.test.mjs re-checks every committed record);
//   - every funder of the run (the record's `funders`, the fee payers of its transactions that are not the return
//     address): 0 lamports at finalized, so no lamport is left behind a run key. When the record names a payer other
//     than the run's funder, each of its transactions is read at finalized: a payer whose every transaction in it is
//     one plain System Transfer into a run key only funded the run (a wallet other than the return address), its
//     balance its own: an info line, and the run record names it apart. Any other payer is a run key: it FAILs while
//     it holds a lamport (card pool-sol-deploy-after-run).
// A mainnet record (card pool-sol-deploy-mainnet, scripts/live-checks/pool-sol-deploy-mainnet.mjs) has no test deposit,
// so the mark and leaf lines are not read; instead, on mainnet's two RPCs of two operators:
//   - the pool exists as above;
//   - the pool buy's lookup table (the record's `table`): owned by the address lookup table program, active, its
//     authority none (frozen: nobody can deactivate or close it), holding exactly the record's `table_addresses` in
//     order, a list that is the kit's own (solanaPoolBuyTableAccounts from its public entry) for this program, its pool
//     and the pages up to entry 2,047 of each tree, only the venue's 9 keys (pump Global's fee recipient and 8 buyback
//     recipients, which Global may change) taken from the list;
//   - the programdata and the table read as the same bytes on both RPCs.
// Every constant it compares against is pinned here or read from chain; the record gives only the ids, the code's
// sha256, the deposit and the table's list.
//   node scripts/live-checks/pool-sol-deploy.mjs [--deployment <file>] [--rpc <url>,<url>] [--record <file>]
//     [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay. --write-record, on PASS, writes the run
// record scripts/live-checks/pool-sol-deploy.md from the deployment record (Money path: yes, one Tx line per tx).
// Runs: once, a contract deploy's read-back (the Solana pool program, no upgrade authority); no host deploy changes it
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "pool-sol-deploy";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = path.join(HERE, "pool-sol-deploy.devnet.json");
export const RECORD = path.join(HERE, "pool-sol-deploy.md");

// @noble/hashes and @noble/curves from the helper's own dependencies (apps/ is outside Blindfill, so this check
// reaches nothing of the kit's but its own copies of the same audited libraries).
// Static names only, so check:imports reads every one (Node 24 loads these ES modules through require).
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");
const { ed25519 } = req("@noble/curves/ed25519.js");

// Devnet's genesis hash, read 2026-11-02 at 23:12Z from api.devnet.solana.com and solana-devnet.api.onfinality.io
// (getGenesisHash), both answering EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// Mainnet-beta's genesis hash (docs.anza.xyz/clusters/available); the deploy script refuses it.
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// The devnet providers the live checks read, in order, each its operator's (card live-check-devnet-pair). A check reads
// on the first two operators that answer (onTwoOperators below): a provider that is out moves the read to the next, and
// fewer than two answering FAILs. Read 2026-11-06 10:53-10:56Z from the Mac (getGenesisHash, getAccountInfo of the pinned program and
// its programdata, getTransaction at finalized of a 3 Nov deploy, deposit and release):
//   - api.devnet.solana.com, the cluster's public RPC (docs.anza.xyz/clusters/available), answered every read;
//   - the helper's /v1/rpc/solana-devnet, the page's own second (packages/signpage/src/pool-testnet.ts TESTNET_RPCS),
//     whose keyed provider is another operator's (apps/helper/src/rpc/rpc.ts RPC_UPSTREAMS "solana-devnet"), answered
//     the account and transaction reads and refused getGenesisHash (400 method_not_allowed), which this card adds to
//     the route's list (apps/helper/src/rpc/methods.ts); a helper that still refuses it is out for a check that reads the
//     genesis, which moves on;
//   - OnFinality's public endpoint answers 1 request a second and 1000 a day per IP (x-ratelimit-limit-day 1000): on
//     GitHub's shared runners it answered no result (sign live run 42201131294, 6 Nov 10:15Z), so it is the last spare.
// Left out: devnet.rpcpool.com and explorer-api.devnet.solana.com are the same node as api.devnet.solana.com (x-rpc-node
// sg140, 74.63.203.93); Tatum's gateway answers 5 reads and then 429 for 60 s; dRPC, Ankr, Alchemy, Helius, Chainstack
// and Shyft answer only with a key.
export const DEVNET_HELPER_RPC = "https://api.confidential.unrealized.trade/v1/rpc/solana-devnet";
export const DEVNET_PROVIDERS = Object.freeze(["https://api.devnet.solana.com", DEVNET_HELPER_RPC, "https://solana-devnet.api.onfinality.io/public"]);
// The devnet deploy's own pair (contracts/pool-solana/scripts/deploy.mjs reads its second here: it needs getGenesisHash
// and getProgramAccounts, which the helper's route refuses), read on 2026-11-02 between 23:12 and 23:14Z. The checks
// read DEVNET_PROVIDERS; a deploy's printed --rpc pair is read through the same walk.
export const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
export const OPERATORS = Object.freeze({ "api.devnet.solana.com": "solana", "api.confidential.unrealized.trade": "the helper's devnet provider", "solana-devnet.api.onfinality.io": "onfinality" });
// The two mainnet RPCs, each its operator's (card pool-sol-deploy-mainnet), both answering mainnet's genesis hash and the
// same rents on 2026-11-05 at 14:35Z: the cluster's public RPC (docs.anza.xyz/clusters/available), first since it alone
// answers getProgramAccounts (the deploy's buffer scan; PublicNode answered it "Indexed requests require a personal
// token" at 14:37Z), and PublicNode's (the pair scripts/live-checks/helper-pool-senders.mjs reads mainnet's rent on).
export const MAINNET_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const MAINNET_OPERATORS = Object.freeze({ "api.mainnet-beta.solana.com": "solana", "solana-rpc.publicnode.com": "publicnode" });

export const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSTEM = "11111111111111111111111111111111";
// contracts/pool-solana/src/state.rs: POOL_LEN = 49 + 2 * (8 + 1 + 33 * 32); the page header and entry sizes
export const POOL_LEN = 2179;
const OFF_TREES = 49;
const TREE_LEN = 1065;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024n;
// contracts/pool-solana/src/state.rs PRE_MARK_LEN and MARK_TAG: value u64 LE ‖ nonce u64 LE ‖ the tag
export const PRE_MARK_LEN = 17;
export const MARK_TAG = 1;
const PROGRAMDATA_META = 45; // u32 tag 3, u64 slot, 33-byte Option<Pubkey>
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
// The only code a mainnet record may name: the reviewed build's sha256, the "Program sha256:" line of
// contracts/pool-review-2.md (79,088 bytes), which CI run 42012187381's pool-solana artifact hashed to on 2026-11-05 at
// 14:46Z. The deploy refuses any other code before a key; this check holds the record to it too.
export const MAINNET_CODE_SHA = "c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162";
const TABLE_META = 56; // u32 type 1, u64 deactivation slot, u64 last extended slot, u8 start index, Option<Pubkey> at 21
// contracts/pool-solana/src/context.rs
const SCOPE_TAG = "blindfill-pool-solana-v1";
const NATIVE_MINT = "So11111111111111111111111111111111111111112";
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const enc = (s) => new TextEncoder().encode(s);
export const hex = (b) => Buffer.from(b).toString("hex");
export const cat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
export const le = (x, n) => {
  const b = new Uint8Array(n);
  for (let i = 0, v = BigInt(x); i < n; i++, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
export const be32 = (x) => {
  const b = new Uint8Array(32);
  for (let i = 31, v = BigInt(x); i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const u64At = (d, o) => Buffer.from(d.subarray(o, o + 8)).readBigUInt64LE();
const sha256 = (b) => new Uint8Array(createHash("sha256").update(b).digest());

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) (s = ALPHABET[Number(n % 58n)] + s), (n /= 58n);
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) out.unshift(Number(n & 0xffn)), (n >>= 8n);
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
/** A 32-byte address from base58, refused otherwise. */
export function address(s) {
  const b = b58decode(s);
  if (b.length !== 32) throw new Error(`not a 32-byte address: ${s}`);
  return b;
}

const onCurve = (b) => {
  try {
    ed25519.Point.fromBytes(b);
    return true;
  } catch {
    return false;
  }
};
/** Solana's find_program_address: the first bump from 255 down whose hash is off the curve. */
export function pda(seeds, program) {
  const prog = address(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(cat(...seeds, Uint8Array.of(bump), prog, enc("ProgramDerivedAddress")));
    if (!onCurve(h)) return { address: b58encode(h), bump };
  }
  throw new Error("no bump");
}

const fieldOf = (...parts) => be32(BigInt("0x" + hex(keccak_256(cat(...parts)))) % P);
/** scope = keccak256(borsh((SCOPE_TAG, program, pool, mint))) mod p, 32 bytes big-endian. */
export const scopeOf = (program, pool) =>
  fieldOf(le(SCOPE_TAG.length, 4), enc(SCOPE_TAG), address(program), address(pool), address(NATIVE_MINT));
/** label = keccak256(scope || nonce as 32 bytes big-endian) mod p. */
export const labelOf = (scope, nonce) => fieldOf(scope, be32(nonce));
export const poolAddress = (program) => pda([enc("pool")], program);
export const preMarkAddress = (program, precommitment) => pda([enc("pre"), precommitment], program);
export const pageAddress = (program, tree, pageNo) => pda([enc("page"), Uint8Array.of(tree), le(pageNo, 4)], program);
export const programDataAddress = (program) => pda([address(program)], LOADER_V3).address;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** One JSON-RPC call, five tries at most: a transient failure (the fetch throws, as on a reset or "fetch failed"; a
 * 429 or a 5xx; a -32029 / -32429 rate answer) is retried with backoff (the devnet run of 90522c4 stopped on one).
 * A JSON-RPC error answer is never retried: it is the node's word. Re-sending a signed transaction is safe, since it
 * keeps its signature. The error thrown after five transient failures has `transient: true`, so a caller can read
 * again later and still stop at once on the node's word. */
export async function rpc(fetchFn, url, method, params, sleep = sleepMs, tries = 5) {
  for (let i = 1; ; i++) {
    let r, j, transient;
    try {
      r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      j = await r.json().catch(() => null);
      transient = r.status === 429 || r.status >= 500 || [-32029, -32429].includes(j?.error?.code) ? new Error(`${method}: HTTP ${r.status} ${JSON.stringify(j?.error ?? null).slice(0, 80)}`) : null;
      // a 2xx whose body never arrived whole (a socket reset while a large account is read) is a reset too
      if (!transient && !j && r.ok) transient = new Error(`${method}: HTTP ${r.status}, no JSON (the body was cut)`);
    } catch (e) {
      transient = new Error(`${method}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    if (transient) {
      if (i >= tries) throw Object.assign(transient, { transient: true });
      await sleep(1500 * i);
      continue;
    }
    if (!j) throw new Error(`${method}: HTTP ${r.status}, no JSON`);
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  }
}
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** A funding's one shape: `t` (getTransaction, encoding json) is one plain System Transfer from its fee payer (u32 2, u64
 * lamports; compute budget instructions beside it allowed). { from, to, lamports }, or null: another payer's transaction
 * of any other shape (paste 2's 3qRUcXSY: a stranger's 1 lamport to each of 18 addresses, the funder among them) is no
 * funding. One rule for the deploy's record, its journal, --sweep-kept and this check. */
export function plainTransfer(t) {
  const keys = t?.transaction?.message?.accountKeys ?? [];
  const own = (t?.transaction?.message?.instructions ?? []).filter((i) => keys[i.programIdIndex] !== COMPUTE_BUDGET);
  if (own.length !== 1) return null;
  const [i] = own;
  const data = b58decode(i.data);
  const isTransfer = keys[i.programIdIndex] === SYSTEM && data.length === 12 && data[0] === 2 && data[1] === 0 && data[2] === 0 && data[3] === 0;
  if (!isTransfer || i.accounts?.length !== 2 || keys[i.accounts[0]] !== keys[0]) return null;
  return { from: keys[0], to: keys[i.accounts[1]], lamports: Buffer.from(data.subarray(4, 12)).readBigUInt64LE() };
}

/**
 * The record's fee payers sorted into the run's keys and the wallets that only funded it, from each of the record's
 * transactions read at finalized on `url` (never from a step's label): the run's funder is a run key, and so is every
 * other payer with a transaction in the record that is not one plain System Transfer into a run key (read until no
 * more join); the payers left funded the run and did nothing else. A payer the record names with no transaction of
 * its own is a run key. The return address is neither. { runKeys, foreign } (arrays).
 */
export async function payersOf(fetchFn, url, d, sleep) {
  const paid = new Map(); // payer -> [plainTransfer | null]
  for (const t of d.txs ?? []) {
    const x = await rpc(fetchFn, url, "getTransaction", [t.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], sleep);
    if (!x || x.meta?.err !== null) throw new Error(`${t.signature} (${t.step}): ${x ? "failed" : "not found"} at finalized on ${url}`);
    const payer = x.transaction.message.accountKeys[0];
    if (payer !== d.return_to) paid.set(payer, [...(paid.get(payer) ?? []), plainTransfer(x)]);
  }
  for (const f of d.funders ?? []) if (f !== d.return_to && !paid.has(f)) paid.set(f, [null]);
  const runKeys = new Set(d.funder ? [d.funder] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, ts] of paid) if (!runKeys.has(p) && ts.some((x) => !x || !runKeys.has(x.to))) runKeys.add(p), (grew = true);
  }
  return { runKeys: [...runKeys], foreign: [...paid.keys()].filter((p) => !runKeys.has(p)) };
}

/** An account's { owner, executable, lamports, data } at `commitment` (finalized unless said), or null when it does
 * not exist. */
export async function account(fetchFn, url, addr, sleep, commitment = "finalized") {
  const r = await rpc(fetchFn, url, "getAccountInfo", [addr, { encoding: "base64", commitment }], sleep);
  const v = r?.value;
  if (!v) return null;
  return { owner: v.owner, executable: v.executable, lamports: v.lamports, data: new Uint8Array(Buffer.from(v.data[0], "base64")) };
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A provider's operator on `cluster`, or null for a host none is known for; on a local validator (the dry run, cluster
 * "localnet") each loopback URL stands in for one. */
export function operatorOf(url, cluster) {
  const h = hostOf(url);
  if (cluster === "localnet") return LOOPBACK.has(h) ? url : null;
  return (cluster === "mainnet" ? MAINNET_OPERATORS : OPERATORS)[h] ?? null;
}
/** The ordered list holds two operators or more, every provider a known operator's; on a local validator loopback
 * hosts stand in. */
export function operatorProblems(rpcs, cluster) {
  if (rpcs.length < 2) return [`only ${rpcs.length} RPC(s); want two of two operators`];
  if (cluster === "localnet") return rpcs.every((u) => LOOPBACK.has(hostOf(u))) ? [] : ["a localnet record read on a non-loopback RPC"];
  const net = cluster === "mainnet" ? "mainnet" : "devnet";
  const ops = new Set(rpcs.map((u) => operatorOf(u, cluster)).filter(Boolean));
  return [
    ...(ops.size < 2 ? [`only ${ops.size} known ${net} operator(s) in ${rpcs.join(", ")}; want two`] : []),
    ...rpcs.filter((u) => !operatorOf(u, cluster)).map((u) => `${u} is no known ${net} operator's`),
  ];
}

/** `fetchFn` as a walk's provider is read: a refusal (a non-2xx answer other than the 429 and 5xx rpc() retries) or a
 * 2xx answer that is no JSON-RPC answer (neither a result nor an error: OnFinality's on GitHub's runners, sign live run
 * 42201131294, which rpc() returned as undefined) throws, so rpc() tries it again and then throws `transient`. */
const strictFetch = (fetchFn) => async (url, init) => {
  const r = await fetchFn(url, init);
  const j = await r.json().catch(() => null);
  const retried = r.status === 429 || r.status >= 500;
  if (!retried && (!r.ok || !j || typeof j !== "object" || !("result" in j || "error" in j))) {
    throw new Error(`HTTP ${r.status}, ${r.ok ? "no JSON-RPC answer" : "refused"}: ${JSON.stringify(j?.error ?? j).slice(0, 80)}`);
  }
  return { ok: r.ok, status: r.status, json: async () => j };
};

/**
 * `read(url, say, fetchFn)` on the first two operators of the ordered list `rpcs` that answer (card
 * live-check-devnet-pair), each read through `fetchFn` held to JSON-RPC answers (strictFetch). A provider whose read
 * throws `transient` (rpc() above: it failed through every try, refused or answered no JSON-RPC answer) is out: one info
 * line, its lines dropped, and the read moves to the next provider of an operator not yet read. Any other throw is the
 * caller's, and a provider's own answer (a result or a JSON-RPC error) is never moved past. Each answering provider's
 * `say(pass, text)` lines are kept, so every assertion stands on both. Fewer than two operators answering FAILs: two
 * stay required. { urls, values, lines: [[pass | null for info, text]] }.
 */
export async function onTwoOperators(rpcs, operatorOf, fetchFn, read) {
  const strict = strictFetch(fetchFn);
  const urls = [], values = [], lines = [], used = new Set();
  for (const url of rpcs) {
    if (urls.length === 2) break;
    const op = operatorOf(url);
    if (op === null || used.has(op)) continue;
    const mine = [];
    let value;
    try {
      value = await read(url, (pass, text) => mine.push([pass, text]), strict);
    } catch (e) {
      if (!e?.transient) throw e;
      lines.push([null, `${url} is out, the read moves to the next operator: ${String(e.message).split("\n")[0]}`]);
      continue;
    }
    used.add(op), urls.push(url), values.push(value), lines.push(...mine);
  }
  if (urls.length < 2) lines.push([false, `two operators answered: ${urls.length} (${urls.join(", ") || "none"}) of ${rpcs.join(", ")}`]);
  return { urls, values, lines };
}

export async function check({ deployment: d, fetchFn = fetch, rpcs = DEVNET_PROVIDERS, sleep = sleepMs, mainnet = false }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  // mainnet mode takes a mainnet record only, on mainnet's operators; the devnet check never takes one
  const genesis = mainnet ? (d.cluster === "mainnet" ? MAINNET_GENESIS : null) : d.cluster === "devnet" ? DEVNET_GENESIS : d.cluster === "localnet" ? d.genesis_hash : null;
  say(genesis !== null, `the record's cluster is ${mainnet ? "mainnet" : "devnet or localnet"}: ${d.cluster}`);
  for (const p of operatorProblems(rpcs, mainnet ? "mainnet" : d.cluster)) say(false, p);
  const prog = d.program_id;
  const pdaData = programDataAddress(prog);
  const pool = poolAddress(prog);
  const scope = scopeOf(prog, pool.address);
  say(pdaData === d.programdata, `programdata ${pdaData} derives from ${prog} and is the record's`);
  say(pool.address === d.pool, `pool ${pool.address} derives from ["pool"] and is the record's`);
  // mainnet: no test deposit; the table instead (its list must hold this program's pool and its first pages)
  const dep = mainnet ? null : d.deposit;
  const nonce = dep ? BigInt(dep.nonce) : 0n;
  const slotNo = (nonce - 1n) % PAGE_ENTRIES;
  const pageNo = (nonce - 1n) / PAGE_ENTRIES;
  const label = dep ? labelOf(scope, nonce) : null;
  if (mainnet) {
    say(d.so_sha256 === MAINNET_CODE_SHA, `the record's code is the reviewed build ${MAINNET_CODE_SHA}: ${d.so_sha256}`);
    const list = Array.isArray(d.table_addresses) ? d.table_addresses : [];
    const own = [pool.address, ...[0, 1].flatMap((tree) => [0n, 1n].map((n) => pageAddress(prog, tree, n).address))];
    say(typeof d.table === "string" && own.every((a) => list.includes(a)), `the record names the pool buy's lookup table ${d.table ?? "(none)"}, its list holding pool ${pool.address} and the pages to entry 2,047 of each tree`);
    // the whole list, rebuilt from the kit's public entry for this program: only the venue's 9 keys (pump Global's fee
    // recipient and its 8 buyback recipients, which Global may change) are taken from the list itself
    const kit = await import("../../packages/kit/src/index.ts");
    const slot = Array.from({ length: 9 }, (_, i) => `venue key ${i}`);
    const template = kit.solanaPoolBuyTableAccounts({ program: prog, pool: pool.address }, { kind: "pump-curve", feeRecipient: slot[0], buybackFeeRecipients: slot.slice(1) }, kit.solanaPoolPages(prog, 1024, 1024));
    const want = template.map((a, i) => (slot.includes(a) ? list[i] : a));
    const first = want.findIndex((a, i) => a !== list[i]);
    say(list.length === want.length && first < 0,
      `the record's table list is the kit's for this program (solanaPoolBuyTableAccounts, pages to entry 2,047), its 9 venue keys taken from the list: ${list.length} addresses, ${want.length} wanted${first < 0 ? "" : `, entry ${first} is ${list[first] ?? "missing"}, not ${want[first] ?? "none"}`}`);
  }
  // on the first two operators that answer (onTwoOperators): each provider's programdata and table bytes and the wallets
  // that only funded the run, as its reads sort them
  const walk = await onTwoOperators(rpcs, (u) => operatorOf(u, mainnet ? "mainnet" : d.cluster), fetchFn, async (url, say, fetchFn) => {
    const at = `on ${url}`;
    const own = { programdata: null, table: null, foreign: null };
    try {
      const g = await rpc(fetchFn, url, "getGenesisHash", [], sleep);
      say(g === genesis, `genesis ${g} is ${d.cluster}'s ${at}`);
      const pa = await account(fetchFn, url, prog, sleep);
      say(!!pa && pa.executable && pa.owner === LOADER_V3 && pa.data.length === 36 && pa.data[0] === 2 && b58encode(pa.data.subarray(4, 36)) === pdaData,
        `${prog} is an executable upgradeable-loader program pointing at ${pdaData} ${at}: ${pa ? `owner ${pa.owner}, executable ${pa.executable}, ${pa.data.length} bytes` : "missing"}`);
      const pd = await account(fetchFn, url, pdaData, sleep);
      if (!pd || pd.owner !== LOADER_V3 || pd.data.length < PROGRAMDATA_META || pd.data[0] !== 3) {
        say(false, `programdata ${pdaData} ${at}: ${pd ? `owner ${pd.owner}, ${pd.data.length} bytes, tag ${pd.data[0]}` : "missing"}`);
      } else {
        own.programdata = hex(pd.data);
        const auth = pd.data[12] === 0 ? null : b58encode(pd.data.subarray(13, 45));
        say(auth === null, `upgrade authority is none ${at}: ${auth ?? "none"}`);
        const code = pd.data.subarray(PROGRAMDATA_META);
        const n = Number(d.so_len);
        const got = code.length >= n ? hex(sha256(code.subarray(0, n))) : `short (${code.length} bytes)`;
        const tail = code.length >= n && code.subarray(n).every((b) => b === 0);
        say(got === d.so_sha256 && tail, `code sha256 of ${n} bytes ${got} equals the build's ${d.so_sha256}, ${code.length - n} bytes after it all 0: ${tail} ${at}`);
      }
      const pl = await account(fetchFn, url, pool.address, sleep);
      const poolOk = !!pl && pl.owner === prog && pl.data.length === POOL_LEN && Buffer.from(pl.data.subarray(0, 8)).toString() === "bfpool01" && pl.data[8] === pool.bump;
      say(poolOk, `pool ${pool.address} is the program's, ${POOL_LEN} bytes, "bfpool01", bump ${pool.bump} ${at}: ${pl ? `owner ${pl.owner}, ${pl.data.length} bytes` : "missing"}`);
      const poolNonce = poolOk ? u64At(pl.data, 9) : -1n;
      const stateSize = poolOk ? u64At(pl.data, OFF_TREES) : -1n;
      const labelSize = poolOk ? u64At(pl.data, OFF_TREES + TREE_LEN) : -1n;
      say(poolNonce >= nonce && stateSize >= nonce && labelSize >= nonce, `pool nonce ${poolNonce}, state size ${stateSize}, label size ${labelSize} reach the deposit's nonce ${nonce} ${at}`);
      if (mainnet) {
        const t = typeof d.table === "string" ? await account(fetchFn, url, d.table, sleep) : null;
        const td = t ? Buffer.from(t.data) : null;
        const shaped = !!t && t.owner === ALT_PROGRAM && td.length >= TABLE_META && (td.length - TABLE_META) % 32 === 0 && td.readUInt32LE(0) === 1;
        if (shaped) own.table = hex(td);
        const tauth = !shaped ? "?" : td[21] === 0 ? null : b58encode(td.subarray(22, 54));
        const active = shaped && td.readBigUInt64LE(4) === 0xffff_ffff_ffff_ffffn;
        const got = shaped ? Array.from({ length: (td.length - TABLE_META) / 32 }, (_, i) => b58encode(td.subarray(TABLE_META + 32 * i, TABLE_META + 32 * i + 32))) : [];
        const list = d.table_addresses ?? [];
        say(shaped && active && tauth === null, `lookup table ${d.table} is the table program's, active, authority none (frozen) ${at}: ${t ? `owner ${t.owner}, authority ${tauth ?? "none"}, active ${active}` : "missing"}`);
        say(shaped && got.length === list.length && got.every((a, i) => a === list[i]), `lookup table ${d.table} holds exactly the record's ${list.length} addresses in order ${at}: ${got.length} held`);
      } else {
      const pre = Buffer.from(dep.precommitment, "hex");
      const mark = preMarkAddress(prog, pre);
      const mk = await account(fetchFn, url, mark.address, sleep);
      const mv = mk && mk.data.length === PRE_MARK_LEN ? [u64At(mk.data, 0), u64At(mk.data, 8), mk.data[16]] : null;
      say(!!mk && mk.owner === prog && !!mv && mv[0] === BigInt(dep.value) && mv[1] === nonce && mv[2] === MARK_TAG,
        `mark ${mark.address} reads value ${mv?.[0] ?? "?"} nonce ${mv?.[1] ?? "?"} tag ${mv?.[2] ?? "?"}, the record's ${dep.value} and ${nonce}, tag ${MARK_TAG} ${at}${mk ? ` (${mk.data.length} bytes)` : ": missing"}`);
      for (const [tree, want, name] of [[1, label, "label"], [0, Buffer.from(dep.commitment, "hex"), "state"]]) {
        const pg = pageAddress(prog, tree, pageNo);
        const a = await account(fetchFn, url, pg.address, sleep);
        const hdr = !!a && a.owner === prog && a.data.length >= PAGE_HEADER && Buffer.from(a.data.subarray(0, 8)).toString() === "bfpage01" &&
          a.data[8] === tree && Buffer.from(a.data.subarray(9, 13)).equals(Buffer.from(le(pageNo, 4))) && (a.data.length - PAGE_HEADER) % PAGE_ENTRY === 0;
        const entries = hdr ? BigInt((a.data.length - PAGE_HEADER) / PAGE_ENTRY) : 0n;
        const at0 = PAGE_HEADER + Number(slotNo) * PAGE_ENTRY;
        const leaf = hdr && entries > slotNo ? a.data.subarray(at0, at0 + 32) : null;
        const root = leaf ? a.data.subarray(at0 + 32, at0 + 64) : null;
        say(!!leaf && Buffer.from(leaf).equals(Buffer.from(want)) && root.some((b) => b !== 0),
          `${name} page ${pageNo} entry ${slotNo} holds ${name === "label" ? "keccak256(scope, nonce) mod p" : "the record's commitment"} ${hex(want)} ${at}: ${leaf ? hex(leaf) : a ? "no such entry" : "missing"}`);
      }
      }
      const funders = d.funders ?? (d.funder ? [d.funder] : []);
      say(funders.length > 0, `the record names the run's funders: ${funders.length} ${at}`);
      // a payer other than the run's funder is sorted by its transactions in the record, read on chain: one that only
      // funded the run (each of its transactions one plain System Transfer into a run key) is a wallet whose balance is
      // its own, an info line; any other is a run key, and a run key holding a lamport FAILs
      const kinds = funders.some((f) => f !== d.funder) ? await payersOf(fetchFn, url, d, sleep) : { runKeys: funders, foreign: [] };
      own.foreign = kinds.foreign.join(",");
      for (const f of [...new Set([...funders, ...kinds.runKeys, ...kinds.foreign])]) {
        const b = (await rpc(fetchFn, url, "getBalance", [f, { commitment: "finalized" }], sleep))?.value;
        if (kinds.foreign.includes(f)) say(null, `fee payer ${f} holds ${b} lamports ${at}: not a run key: each of its transactions in the record is one plain System Transfer into a run key (a funding from a wallet other than the return address ${d.return_to})`);
        else say(b === 0, `funder ${f} holds 0 lamports ${at}: ${b}`);
      }
    } catch (e) {
      if (e?.transient) throw e;
      say(false, `read ${at}: ${String(e.message).split("\n")[0]}`);
    }
    return own;
  });
  for (const [pass, text] of walk.lines) pass === null ? lines.push(`info ${text}`) : say(pass, text);
  const of = (k) => walk.values.map((v) => v[k]).filter((x) => x !== null);
  const bytesOn = { programdata: of("programdata"), table: of("table") };
  const foreignOn = of("foreign");
  if (foreignOn.length === 2 && foreignOn[0] !== foreignOn[1]) say(false, `the record's payers sort differently on the two RPCs: funding wallets ${foreignOn.map((f) => f || "none").join(" and ")}`);
  if (mainnet) {
    for (const [name, b] of Object.entries(bytesOn)) {
      say(b.length === 2 && b[0] === b[1], `the ${name} reads the same bytes on ${walk.urls.join(" and ")}: ${b.length === 2 ? b[0] === b[1] : `${b.length} read`}`);
    }
  }
  return { ok, lines, foreign: foreignOn[0] ? foreignOn[0].split(",") : [], urls: walk.urls };
}

export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = await r.json().catch(() => null);
    answers.push({ url, method, params, status: r.status, json });
    return { ok: r.ok, status: r.status, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

/** The run record's text from a deployment record, after a PASS: every tx of the run, devnet, money path. */
export function runRecord(d, rpcs, foreign = []) {
  if (d.cluster === "mainnet") return mainnetRunRecord(d, rpcs, [], foreign);
  const chain = d.cluster === "devnet" ? "solana-devnet" : null;
  if (!chain) throw new Error(`no run record for cluster ${d.cluster}`);
  return [
    `CARD ${KEY} / live: PASS`,
    "Money path: yes",
    ...d.txs.map((t) => `Tx: ${chain} ${t.signature}`),
    "",
    `The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, ${d.at}. Its steps, in the order of the Tx lines above: ${stepsOf(d.txs)}.`,
    `Program ${d.program_id}, programdata ${d.programdata}, pool ${d.pool}; code ${d.so_len} bytes, sha256 ${d.so_sha256} (${d.build}).`,
    `Upgrade authority: none. --final is two transactions, the deploy and then a SetAuthority to none, both in the Tx lines above; this live check reads the authority none on ${rpcs.join(" and ")}.`,
    `Test deposit: ${d.deposit.value} lamports (0.01 SOL), nonce ${d.deposit.nonce}, precommitment ${d.deposit.precommitment}. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.`,
    `Funders: ${runKeysOf(d, foreign).join(", ")}, run keys, each swept to ${d.return_to} at its run's end; this live check reads each at 0 lamports on both RPCs. The last run was funded with ${d.need} lamports (the printed need). Every key lived only in its run.`,
    ...fundingWallets(foreign),
    "",
  ].join("\n");
}

/** A record's steps line: each step's label without the address an older one carries (a sweep's destination, named on
 * the Funders line), since the money gate reads every tx-shaped word on a line that names the Tx lines as a transaction
 * (a 43-44 character address has a NEAR hash's shape: paste 2's --sweep-kept step, 6 Nov). Only a whole base58 word of
 * 32 to 44 characters goes, whatever stands before it ("(" too); a longer one (a signature) is kept whole, so the gate
 * reads it. The deploy's labels carry no address since card pool-sol-deploy-after-run. */
export const stepsOf = (txs) => txs.map((t) => t.step.replace(/ ?(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g, "")).join(", ");

/** The record's funders that are run keys: all but the wallets `foreign` names (the check sorted them on chain). */
const runKeysOf = (d, foreign) => (d.funders ?? [d.funder]).filter((f) => !foreign.includes(f));
/** The wallets that only funded the run, named apart from the run keys: their balances are their own. */
const fundingWallets = (foreign) =>
  foreign.length ? [`Funding wallets, not run keys: ${foreign.join(", ")}; each only sent the run a plain System Transfer, and its balance is its own.`] : [];

/** The mainnet run record (card pool-sol-deploy-mainnet): every tx of the owner's paste, mainnet, money path. */
export function mainnetRunRecord(d, rpcs, attempts = [], foreign = []) {
  return [
    "CARD pool-sol-deploy-mainnet / live: PASS",
    "Money path: yes",
    ...d.txs.map((t) => `Tx: solana ${t.signature}`),
    "",
    `The run: the owner's paste contracts/pool-solana/scripts/mainnet-deploy.sh (deploy.mjs --mainnet) on Solana mainnet, ${d.at}. Its steps, in the order of the Tx lines above: ${stepsOf(d.txs)}.`,
    `Program ${d.program_id}, programdata ${d.programdata}, pool ${d.pool}; code ${d.so_len} bytes, sha256 ${d.so_sha256} (${d.build}).`,
    `Upgrade authority: none, read on ${rpcs.join(" and ")}. No test deposit on mainnet.`,
    `The pool buy's lookup table ${d.table}: ${d.table_addresses.length} addresses, authority none (frozen), read the same bytes on both RPCs.`,
    `Funders: ${runKeysOf(d, foreign).join(", ")}, run keys, swept to ${d.return_to} at the run's end; this live check reads each at 0 lamports on both RPCs. The run was funded with ${d.need} lamports (the printed need). Every key lived only in its run.`,
    ...fundingWallets(foreign),
    // a paste that stopped before this one: its journal is kept and named here, never as Tx lines (the money gate reads
    // those as this run's transactions)
    ...attempts.map((a) => `Paste ${a.n} (${a.journal.at}) stopped mid-upload and is kept as ${a.file}: ${a.journal.txs.length} transactions, ${a.journal.keys?.state === "removed" ? "its keys removed with every lamport read back at 0 on both RPCs" : `its keys ${a.journal.keys?.state ?? "unrecorded"}`}; this record is paste ${attempts.length + 1}'s.`),
    "",
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : DEVNET_PROVIDERS;
    const rec = recorder();
    const r = await check({ deployment, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    if (r.ok && args.includes("--write-record")) {
      writeFileSync(RECORD, runRecord(deployment, r.urls, r.foreign));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RECORD)}`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
