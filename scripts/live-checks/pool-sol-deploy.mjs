#!/usr/bin/env node
// Live check of card pool-sol-deploy: the Blindfill pool program on Solana devnet, immutable, with its SOL pool and
// one test deposit. On two RPCs of two operators, each answering devnet's genesis hash, it reads:
//   - the program account: executable, owned by the upgradeable loader (BPFLoaderUpgradeab1e...), pointing at the
//     programdata account its id derives;
//   - the programdata account: its upgrade authority is none (the 33-byte Option at bytes 12-44 is 0), and its code
//     is the build's: sha256 of the first so_len bytes equals the deployment record's, every byte after them is 0;
//   - the pool account at ["pool"]: owned by the program, POOL_LEN bytes, "bfpool01", its bump the canonical one;
//   - the test deposit's precommitment mark ["pre", precommitment]: owned by the program, 16 bytes, value u64 LE and
//     nonce u64 LE equal to the record's (M353);
//   - both pages holding that deposit's leaves (["page", tree, page_no u32 LE]): the label leaf equals
//     keccak256(scope || nonce) mod p with the scope this program and pool give (contracts/pool-solana/src/context.rs),
//     so the pool was initialised for this program's scope; the state leaf equals the record's commitment, which the
//     deploy script computed as Poseidon(value, label, precommitment) and checked against this leaf when it deployed
//     (contracts/pool-solana/scripts/deploy.mjs; deploy.test.mjs re-checks every committed record).
// Every constant it compares against is pinned here or read from chain; the record gives only the ids, the code's
// sha256 and the deposit.
//   node scripts/live-checks/pool-sol-deploy.mjs [--deployment <file>] [--rpc <url>,<url>] [--record <file>]
//     [--write-record]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every RPC answer read to <file>, for the test's replay. --write-record, on PASS, writes the run
// record scripts/live-checks/pool-sol-deploy.md from the deployment record (Money path: yes, one Tx line per tx).
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
// The two devnet RPCs, each its operator's, both answered getGenesisHash, getTransaction and getAccountInfo on
// 2026-11-02 between 23:12 and 23:14Z: api.devnet.solana.com, the cluster's public RPC (docs.anza.xyz/clusters/available,
// "RPC URL for Devnet: https://api.devnet.solana.com"), and OnFinality's public devnet endpoint, which rate-limits
// bursts (a 429 is waited out below).
export const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
export const OPERATORS = Object.freeze({ "api.devnet.solana.com": "solana", "solana-devnet.api.onfinality.io": "onfinality" });

export const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSTEM = "11111111111111111111111111111111";
// contracts/pool-solana/src/state.rs: POOL_LEN = 49 + 2 * (8 + 1 + 33 * 32); the page header and entry sizes
export const POOL_LEN = 2179;
const OFF_TREES = 49;
const TREE_LEN = 1065;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024n;
export const PRE_MARK_LEN = 16;
const PROGRAMDATA_META = 45; // u32 tag 3, u64 slot, 33-byte Option<Pubkey>
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
/** One JSON-RPC call; a 429 (or a -32029 / -32429 answer) is waited out, up to five tries. */
export async function rpc(fetchFn, url, method, params, sleep = sleepMs) {
  for (let i = 0; ; i++) {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json().catch(() => null);
    const limited = r.status === 429 || [-32029, -32429].includes(j?.error?.code);
    if (limited && i < 5) {
      await sleep(1500 * (i + 1));
      continue;
    }
    if (!j) throw new Error(`${method}: HTTP ${r.status}, no JSON`);
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  }
}
/** An account's { owner, executable, lamports, data } at finalized, or null when it does not exist. */
export async function account(fetchFn, url, addr, sleep) {
  const r = await rpc(fetchFn, url, "getAccountInfo", [addr, { encoding: "base64", commitment: "finalized" }], sleep);
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
/** Two RPCs of two operators; on a local validator (the dry run, cluster "localnet") loopback hosts stand in. */
export function operatorProblems(rpcs, cluster) {
  const two = rpcs.slice(0, 2);
  if (two.length < 2) return [`only ${two.length} RPC(s); want two of two operators`];
  if (cluster === "localnet") return two.every((u) => LOOPBACK.has(hostOf(u))) ? [] : ["a localnet record read on a non-loopback RPC"];
  const ops = new Set(two.map((u) => OPERATORS[hostOf(u)]).filter(Boolean));
  return ops.size < 2 ? [`only ${ops.size} known devnet operator(s) in ${two.join(", ")}; want two`] : [];
}

export async function check({ deployment: d, fetchFn = fetch, rpcs = RPCS, sleep = sleepMs }) {
  const lines = [];
  let ok = true;
  const say = (pass, text) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${text}`);
  };
  const genesis = d.cluster === "devnet" ? DEVNET_GENESIS : d.cluster === "localnet" ? d.genesis_hash : null;
  say(genesis !== null, `the record's cluster is devnet or localnet: ${d.cluster}`);
  for (const p of operatorProblems(rpcs, d.cluster)) say(false, p);
  const prog = d.program_id;
  const pdaData = programDataAddress(prog);
  const pool = poolAddress(prog);
  const scope = scopeOf(prog, pool.address);
  say(pdaData === d.programdata, `programdata ${pdaData} derives from ${prog} and is the record's`);
  say(pool.address === d.pool, `pool ${pool.address} derives from ["pool"] and is the record's`);
  const dep = d.deposit;
  const pre = Buffer.from(dep.precommitment, "hex");
  const nonce = BigInt(dep.nonce);
  const mark = preMarkAddress(prog, pre);
  const slotNo = (nonce - 1n) % PAGE_ENTRIES;
  const pageNo = (nonce - 1n) / PAGE_ENTRIES;
  const label = labelOf(scope, nonce);
  for (const url of rpcs.slice(0, 2)) {
    const at = `on ${url}`;
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
      const mk = await account(fetchFn, url, mark.address, sleep);
      const mv = mk && mk.data.length === PRE_MARK_LEN ? [u64At(mk.data, 0), u64At(mk.data, 8)] : null;
      say(!!mk && mk.owner === prog && !!mv && mv[0] === BigInt(dep.value) && mv[1] === nonce,
        `mark ${mark.address} reads value ${mv?.[0] ?? "?"} nonce ${mv?.[1] ?? "?"}, the record's ${dep.value} and ${nonce} ${at}${mk ? "" : ": missing"}`);
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
    } catch (e) {
      say(false, `read ${at}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { ok, lines };
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
export function runRecord(d, rpcs) {
  const chain = d.cluster === "devnet" ? "solana-devnet" : null;
  if (!chain) throw new Error(`no run record for cluster ${d.cluster}`);
  return [
    `CARD ${KEY} / live: PASS`,
    "Money path: yes",
    ...d.txs.map((t) => `Tx: ${chain} ${t.signature}`),
    "",
    `The run: contracts/pool-solana/scripts/deploy.mjs on Solana devnet, ${d.at}. Its steps, in the order of the Tx lines above: ${d.txs.map((t) => t.step).join(", ")}.`,
    `Program ${d.program_id}, programdata ${d.programdata}, pool ${d.pool}; code ${d.so_len} bytes, sha256 ${d.so_sha256} (${d.build}).`,
    `Upgrade authority: none (set in the deploy itself, --final), read back by this live check on ${rpcs.join(" and ")}.`,
    `Test deposit: ${d.deposit.value} lamports (0.01 SOL), nonce ${d.deposit.nonce}, precommitment ${d.deposit.precommitment}. Its note's secrets lived only in the run, so the 0.01 SOL stays in the pool as a test deposit.`,
    `Funder: a run key, funded with ${d.need} lamports (the printed need) and swept to ${d.return_to} at the end, holding ${d.funder_after} lamports after; its key and the program's key lived only in the run.`,
    "",
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, dflt) => (args.includes(n) ? args[args.indexOf(n) + 1] : dflt);
  try {
    const deployment = JSON.parse(readFileSync(opt("--deployment", DEPLOYMENT), "utf8"));
    const rpcs = opt("--rpc") ? opt("--rpc").split(",") : RPCS;
    const rec = recorder();
    const r = await check({ deployment, rpcs, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    if (r.ok && args.includes("--write-record")) {
      writeFileSync(RECORD, runRecord(deployment, rpcs));
      console.log(`live-check ${KEY}: wrote ${path.relative(process.cwd(), RECORD)}`);
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
