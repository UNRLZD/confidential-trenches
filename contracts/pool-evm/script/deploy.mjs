#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deploys the Blindfill EVM pool to Base Sepolia or Robinhood testnet, or with --mainnet to Base or Robinhood (or an
// anvil fork of one, the dry run), with no admin: the withdrawal verifier, the pool, the v4 adapter, the v3 adapter
// (of the testnets Base Sepolia only; both mainnets, M365) and the sell delegate. The deployer is a run key made in memory; it is never printed or passed to another process, and written
// only on a mainnet run, to its 0700 key folder until swept.
//
//   node contracts/pool-evm/script/deploy.mjs --chain <base-sepolia|robinhood-testnet> --return <address>
//     [--only SellDelegate] [--rpc <url>] [--out <file>] [--no-build]
//   node contracts/pool-evm/script/deploy.mjs --write-build      rewrites scripts/live-checks/pool-evm-deploy.build.json
//     from forge's output (out/), after a forge build; its `frozen` map (code already deployed from an older build,
//     pinned to the addresses that hold it) is kept as it is
//
// --only SellDelegate (card evm-sell-v4) deploys the sell delegate alone, constructed with the chain's WETH and v4
// PoolManager, with every step below the same (a fresh run key at nonce 0, so the delegate is CREATE(key, 0)); its
// record goes to scripts/live-checks/evm-selldelegate-exact-debit.<chain>.json (or --out), and its live check is
// evm-selldelegate-exact-debit.mjs (card evm-selldelegate-exact-debit's redeploy; evm-sell-v4's records keep theirs).
//
//   node contracts/pool-evm/script/deploy.mjs --mainnet --chain <base|robinhood> --return <address> [--rpc <loopback> --out <file>]
//   node contracts/pool-evm/script/deploy.mjs --mainnet --chain <base|robinhood> --sweep-kept <journal> [--return <address>]
//     the owner's paste (script/mainnet-deploy.sh, card pool-evm-deploy-mainnet) and its sweep form. A mainnet run
//     differs from a testnet run in these, each refused before a key is made: the RPC is the chain's first in
//     pool-evm-deploy.mjs MAINNETS (or a loopback fork of it with --out, the rehearsal); the record goes to
//     contracts/pool-evm/deployments/<chain>.json, and once it exists the run is refused, naming the live check, as it
//     is when origin/main holds that record or the kit pins a pool for the chain (deployedElsewhere); --return must
//     also hold ETH on both RPCs (the wallet the owner funds from); each contract's init code must be MAINNET_INIT's,
//     and those checked bytes are the ones sent; the max fee (the lower of both RPCs') must be at most MAX_FEE_CAP.
//     Then: the run key, made in memory, is kept in a 0700 folder (keysBase(), file 0600), written with the journal just
//     before the run's try (a throw before it leaves no key behind), until the cleanup reads it at
//     most DUST on both RPCs with every nonce it signed landed, and never removed after a stop before the funding was
//     read; the run's journal (the record's path, .journal.json) holds every transaction it signs, written before
//     the send and in the finally, and the key's state. A stopped run that made a contract keeps its key; while a
//     journal's key is kept the same paste (the same --return, no other) resumes with that key: each contract the
//     stopped run made is reused once its receipt and its code on both RPCs read back as the build's (one that landed
//     but does not read back stops the resume before any funding, and the pool is reused only with its verifier), and
//     only the rest is deployed, at the key's next nonces; or --sweep-kept sends the key's rest back to that journal's
//     return address, and no other, then removes the key: any journal whose key is not removed ("kept", or "in use" after
//     a run killed outright), the return wallet's balance not asked; a journal that signed nothing (a run stopped in its
//     funding wait) is watched for WAITS.lateFunding and its key kept until the need its run asked for has landed. A journal whose key is removed is moved aside by
//     the next run. The record is written once every deploy is made, before the sweep, and again with the sweep; a
//     run that made fewer writes none. The journal and the record are each written whole (writeAtomic). Each contract's
//     code is read again on both RPCs. The funding line asks for the need less what the key holds, in wei and, exactly,
//     in ETH, and for nothing when the key holds the need (a resume's kept key). Each RPC call is tried RPC_TRIES times.
//
// Steps:
//  1. The chain from eth_chainId: the named testnet's id, on its RPC or on a loopback URL (an anvil fork of it, the dry
//     run, which needs --out so it never writes the real record). A mainnet id is refused: that deploy is the owner's.
//     --return must not be the zero address, must pass its EIP-55 checksum when mixed case, and must have no code on
//     the chain's two RPCs (the fork's one URL on a dry run).
//  2. The build: forge build --root contracts/pool-evm (CI's command), and each contract's runtime checked against
//     pool-evm-deploy.build.json (length, keccak256 with the immutables zeroed), so the code sent is the code pinned.
//  3. The run key, made in memory by @noble/curves; its address is printed, the key never is. Its nonce must be 0, so
//     every contract's address is known before the first transaction: CREATE from the key at nonces 0, 1, ...
//  4. The need, printed with its parts: each deploy's eth_estimateGas plus 20%, each at the nonce its deploy will have
//     (state overrides: the key's nonce, and for the pool the verifier's code at its address, since the pool's
//     constructor checks it), at a max fee of twice the base fee plus the tip; on Base Sepolia each transaction's L1
//     fee bound (GasPriceOracle.getL1FeeUpperBound); and the sweep's own fee. Then it waits until the key holds that
//     much (the line "deploy: waiting for <wei> wei ... at <address>" is what the funder, or the dry run's stand-in
//     wallet, reads).
//  5. The deploys, one EIP-1559 transaction each, signed here and sent with eth_sendRawTransaction. Each must succeed
//     and make its expected address, and the code read there must be the build's. Each transaction is kept before it
//     is sent, so a send whose answer is lost is still waited for and recorded ("already known" on a resend is taken).
//  6. Always, in a finally. SIGINT, SIGTERM or SIGHUP stop the run at its next step; later signals never cut the sweep
//     short; a stop during the funding wait watches the balance for WAITS.lateFunding first, so a transfer in flight
//     is swept too. The settle: until the key's latest nonce covers every nonce it signed, a pending transaction is
//     sent again, and one pending longer than WAITS.stuck is replaced at its nonce by a cancel (0 to the key itself,
//     both fee terms 12.5% and at least 1 wei above the highest the key sent at that nonce; a refused send never
//     counts). A sweep at a nonce with something pending (after a settle that ran out) is priced the same way. Then the sweep: the key's balance, less the transfer's fee bound (the L1 fee bound
//     read on each pass, doubled), goes to --return, again while what is left is more than two such bounds; a failed
//     pass is retried with backoff over WAITS.sweep. Every hash is printed.
//  7. Writes the deployment record (scripts/live-checks/pool-evm-deploy.<chain>.json, evm-selldelegate-exact-debit.<chain>.json with
//     --only SellDelegate, or --out) with every
//     transaction that landed, in nonce order, and prints the live check to run next.
import "../../../scripts/net-window.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUILD_FILE, CHAINS, DUST, MAINNETS, MAINNET_IDS, RPC_TRIES, bytes, chainOf, deploymentFile, hex, keccak, rpc, runtimeOf, selector, word,
} from "../../../scripts/live-checks/pool-evm-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POOL_DIR = path.join(HERE, "..");
const REPO = path.join(POOL_DIR, "../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const { secp256k1 } = await import(pathToFileURL(req.resolve("@noble/curves/secp256k1.js")).href);

// The contracts in deploy order, each with its constructor's arguments on a chain (the pool's is the verifier's
// address the run computes).
export const ORDER = ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate"];
const argsOf = (name, chain, addrs) => ({
  WithdrawalVerifier: [],
  PrivacyPoolSimple: [addrs.WithdrawalVerifier],
  UniswapV4Adapter: [chain.poolManager.address, chain.weth.address],
  UniswapV3Adapter: [chain.router?.address],
  SellDelegate: [chain.weth.address, chain.poolManager.address],
})[name];
// The contracts a run may deploy alone (--only): the sell delegate, whose constructor needs no other contract of the run
// (card evm-selldelegate-exact-debit; evm-sell-v4's records stay under their own key)
export const ALONE = Object.freeze({ SellDelegate: { key: "evm-selldelegate-exact-debit" } });
export const onlyFile = (name, chain) => path.join(REPO, "scripts/live-checks", `${ALONE[name].key}.${chain}.json`);
const GAS_MARGIN = (g) => (g * 12n) / 10n;
const OP_ORACLE = "0x420000000000000000000000000000000000000f"; // the OP Stack GasPriceOracle predeploy
const SWEEP_TX_BYTES = 200n; // an EIP-1559 transfer signed is about 110 bytes
// Each RPC call's tries: pool-evm-deploy.mjs RPC_TRIES (67.5 s of waits, past Robinhood's 61 s throttle window), the
// same for this run and for the live check the paste runs after it
export { RPC_TRIES };
// A mainnet run's max fee per gas (twice the base fee plus the tip, the lower of the two RPCs') is refused above this,
// before any key: a broken or lying RPC answer, not a busy chain. 2 gwei is about 200 times Base's (base fee 5,002,715
// wei, tip 1,000,000) and about 44 times Robinhood's (base fee 22,646,000 wei, tip 0), read on both RPCs of each on
// 2026-11-06 00:07Z, and above anvil's own 1 gwei tip, so a fork's rehearsal runs as the paste does.
export const MAX_FEE_CAP = 2n * 10n ** 9n;
/** Writes `text` to `file` whole or not at all: a temporary file beside it, then a rename over it */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---- the mainnets (card pool-evm-deploy-mainnet) ----
// Each contract's init code (forge's bytecode.object, before the constructor's arguments) as the build pinned in
// pool-evm-deploy.build.json makes it: its length and keccak256. solc 0.8.28 with contracts/pool-evm/foundry.toml builds
// these bytes on any host (the metadata hashes the sources, not the paths), so a mainnet run takes no other: a
// constructor changed, or code from another commit, is refused before a key is made. Read from forge build --root
// contracts/pool-evm (forge 1.8.6 on a Linux build host, 2026-11-05 17:27Z); the verifier's, the pool's and both
// adapters' are also the init code of the 3 Nov testnet deploys built on the Mac (their transactions' input, read
// 2026-11-05 17:39Z). The sell delegate's is pool review round 3's (it pays the fee to the fee recipient W signs),
// read from forge build --force --root contracts/pool-evm at the merge of main 7dfb6336 (forge 1.7.1 on the Mac,
// 2026-11-05 23:38Z), where the other four read as above. test/deploy-run.test.mjs fails when forge's out/ differs
// (CI builds with forge 1.7.1).
export const MAINNET_INIT = Object.freeze({
  WithdrawalVerifier: { length: 1975, keccak: "0x381df6043b0354b2ff24f5620391b26cb95612f896a258266f3bf798de21910f" },
  PrivacyPoolSimple: { length: 10142, keccak: "0x50a3d2fa107766537bc20545d46f052b8a355d0986a1e6a11eb55bfff0c733fb" },
  UniswapV4Adapter: { length: 4578, keccak: "0xedc0d3a854fc280089da75b2ed4baf8e3495fdb80eed6632ddfe5421ac96b6ef" },
  UniswapV3Adapter: { length: 2269, keccak: "0x1460db6407c61d6d70d3d423a04a46a512f5df9c00978987cd9f38a267db4f05" },
  SellDelegate: { length: 9479, keccak: "0x60ae724bd23ec2c11ee8faf40a6027b43e256e7719efe8d85646ed7079fc3132" },
});
/** Why `code` is not `name`'s pinned init code, or null when it is */
export function initProblems(name, code) {
  const pin = MAINNET_INIT[name];
  if (!pin) return `${name}: no pinned init code`;
  const b = bytes(code);
  const k = keccak(b);
  return b.length === pin.length && k === pin.keccak ? null : `${name}: init code keccak256 ${k} (${b.length} bytes), not the pinned ${pin.keccak} (${pin.length} bytes)`;
}
/**
 * Why `chainName`'s pool counts as deployed beyond this checkout, or null: origin/main holds its record (fetched first),
 * or the kit pins a pool for it. A paste in another clone of the repository is refused as one in this folder is.
 */
export async function deployedElsewhere(chainName, { git = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" }) } = {}) {
  const file = path.relative(REPO, deploymentFile(chainName));
  // main's record unread is its own refusal, never "deployed already"
  if (git("fetch", "-q", "origin", "main").status !== 0) throw new Error("git fetch origin main failed, so main's record could not be read: nothing was sent; run the paste again once the fetch works");
  if (git("rev-parse", "--verify", "-q", "origin/main").status !== 0) throw new Error("origin/main is not in this checkout, so main's record could not be read: nothing was sent");
  if (git("cat-file", "-e", `origin/main:${file}`).status === 0) return `origin/main holds ${file}`;
  const { evmPoolVenues } = await import(pathToFileURL(path.join(REPO, "packages/kit/src/index.ts")).href);
  const pool = evmPoolVenues()[chainName]?.pool;
  return pool ? `the kit pins the ${chainName} pool ${pool}` : null;
}
/** A record's journal: the record's path with .journal.json */
export const journalOf = (out) => out.replace(/\.json$/, "") + ".journal.json";
/** The paste's sweep form for a mainnet chain's journal */
export const sweepCommand = (chainName) => `sh contracts/pool-evm/script/mainnet-deploy.sh ${chainName} --sweep-kept`;
/**
 * Where a mainnet run's key folder lives: $XDG_STATE_HOME/pool-evm-deploy, ~/.local/state/pool-evm-deploy by default,
 * made 0700 (the Solana deploy's rule, contracts/pool-solana/scripts/deploy.mjs keysBase). A kept folder must outlast the
 * run: never OS temp (macOS empties it), never inside a git repo or worktree (one stray `git add` and a key is in
 * history), never under ~/.confidential-trenches. Refused when it would be.
 */
export function keysBase(env = process.env, home = homedir()) {
  const base = path.resolve(env.XDG_STATE_HOME || path.join(home, ".local/state"), "pool-evm-deploy");
  const real = (p) => {
    for (let q = p; ; q = path.dirname(q)) {
      try {
        return path.join(realpathSync(q), path.relative(q, p));
      } catch {
        if (q === path.dirname(q)) return p;
      }
    }
  };
  const under = (p, d) => {
    const r = path.relative(real(d), real(p));
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  for (const t of [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]) {
    if (under(base, t)) throw new Error(`the key folder ${base} is in an OS temp folder (${t}), which is emptied: set XDG_STATE_HOME elsewhere`);
  }
  if (under(base, path.join(home, ".confidential-trenches"))) throw new Error(`the key folder ${base} is under ~/.confidential-trenches`);
  for (let q = path.dirname(base); ; q = path.dirname(q)) {
    if (existsSync(path.join(q, ".git"))) throw new Error(`the key folder ${base} is inside the git repo or worktree ${q}`);
    if (q === path.dirname(q)) break;
  }
  return base;
}

// ---- encoding and signing (EIP-1559, EIP-155 chain ids) ----
const big = (x) => BigInt(x);
/** a non-negative integer as RLP wants it: big-endian, no leading zero bytes, 0 as empty */
export function intBytes(n) {
  n = BigInt(n);
  if (n === 0n) return new Uint8Array(0);
  const h = n.toString(16);
  return bytes(h.length % 2 ? "0" + h : h);
}
/** RLP of a byte string or a list */
export function rlp(x) {
  const prefix = (n, off) => {
    if (n < 56) return Uint8Array.of(off + n);
    const l = intBytes(n);
    return Uint8Array.of(off + 55 + l.length, ...l);
  };
  if (Array.isArray(x)) {
    const body = Buffer.concat(x.map(rlp));
    return Uint8Array.from(Buffer.concat([prefix(body.length, 0xc0), body]));
  }
  const b = typeof x === "string" ? bytes(x) : x;
  if (b.length === 1 && b[0] < 0x80) return Uint8Array.from(b);
  return Uint8Array.from(Buffer.concat([prefix(b.length, 0x80), b]));
}
export const addressOf = (sk) => hex(bytes(keccak(secp256k1.getPublicKey(sk, false).subarray(1))).subarray(12));
/** CREATE's address: keccak256(rlp([sender, nonce]))[12:] */
export const createAddress = (sender, nonce) => hex(bytes(keccak(rlp([bytes(sender), intBytes(nonce)]))).subarray(12));
/** The signed raw EIP-1559 transaction and its hash; `to` null makes a contract */
export function signTx(sk, t) {
  const fields = [t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas].map(intBytes);
  const unsigned = [...fields, t.to ? bytes(t.to) : new Uint8Array(0), intBytes(t.value ?? 0n), bytes(t.data ?? "0x"), []];
  const digest = bytes(keccak(Uint8Array.of(2, ...rlp(unsigned))));
  const sig = secp256k1.sign(digest, sk, { prehash: false, format: "recovered" }); // [recovery, r, s], low s
  const raw = Uint8Array.of(2, ...rlp([...unsigned, intBytes(sig[0]), intBytes(BigInt(hex(sig.subarray(1, 33)))), intBytes(BigInt(hex(sig.subarray(33, 65))))]));
  return { raw: hex(raw), hash: keccak(raw) };
}
const addrArg = (a) => word(BigInt(a));

// ---- the build ----
/** Each contract's runtime as pool-evm-deploy.build.json pins it, from forge's out/ */
export function buildOf(outDir = path.join(POOL_DIR, "out")) {
  const contracts = {};
  for (const name of ORDER) {
    const a = JSON.parse(readFileSync(path.join(outDir, `${name}.sol`, `${name}.json`), "utf8"));
    const refs = a.deployedBytecode.immutableReferences ?? {};
    const immutables = Object.keys(refs).sort((x, y) => Number(x) - Number(y)).map((id) => {
      for (const r of refs[id]) if (r.length !== 32) throw new Error(`${name}: an immutable of ${r.length} bytes`);
      return refs[id].map((r) => r.start);
    });
    const r = runtimeOf(a.deployedBytecode.object, immutables);
    contracts[name] = { length: r.length, masked: r.masked, immutables };
  }
  return contracts;
}
const initOf = (name) => JSON.parse(readFileSync(path.join(POOL_DIR, "out", `${name}.sol`, `${name}.json`), "utf8")).bytecode.object;

// ---- the run ----
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLoopback = (u) => LOOPBACK.has(new URL(u).hostname);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (wei) => `${Number(wei) / 1e18} ETH`;
/** wei as ETH, exactly: the funding line's figure in the chain's own unit */
export const ethExact = (wei) => {
  const s = BigInt(wei).toString().padStart(19, "0");
  const f = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${f ? `.${f}` : ""} ETH`;
};
const ZERO = "0x0000000000000000000000000000000000000000";
// The waits (ms): a deploy's receipt; how long a sent transaction may sit before it is replaced; how long the settle
// before a sweep waits for the run key's transactions to land; the sweep's whole retry window; the balance watch after
// a stop during the funding wait (a funding transfer still in flight lands and is swept too).
export const WAITS = Object.freeze({ receipt: 180_000, stuck: 90_000, settle: 900_000, sweep: 1_800_000, lateFunding: 60_000, poll: 5_000 });
// a replacement pays at least 10% more on both fee terms, and strictly more (geth's txpool price bump and its
// strictly-greater check); 12.5%, rounded up and at least +1 (a tip of 0, as Robinhood suggests, must become 1)
const bump = (x) => {
  const b = (x * 1125n + 999n) / 1000n;
  return b > x ? b : x + 1n;
};
const maxOf = (...xs) => xs.reduce((a, b) => (b > a ? b : a));

/** --return: a 20-byte address, EIP-55 when mixed case, not the zero address */
export function returnAddress(s) {
  s = String(s ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error("--return <address>: where the run key's rest goes");
  const low = s.toLowerCase();
  if (s.slice(2) !== low.slice(2) && s.slice(2) !== s.slice(2).toUpperCase()) {
    const h = keccak(new TextEncoder().encode(low.slice(2))).slice(2);
    const sum = [...low.slice(2)].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
    if (sum !== s.slice(2)) throw new Error(`--return ${s} fails its EIP-55 checksum (want 0x${sum})`);
  }
  if (low === ZERO) throw new Error("--return is the zero address: the rest would be burned");
  return low;
}

/**
 * The deploy run. `io` is for tests: fetchFn, sleep(ms) and now() (a mock chain and a virtual clock), keysBase (the
 * mainnet key folder's parent) and recordOf(chain) (a mainnet's record path); a run from the command line uses the
 * network, the real clock, keysBase() and deploymentFile().
 */
export async function main(args, io = {}) {
  const fetchFn = io.fetchFn ?? ((u, i) => globalThis.fetch(u, i));
  const sleep = io.sleep ?? realSleep;
  const now = io.now ?? Date.now;
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const chainName = opt("--chain");
  // a mainnet is the owner's paste (script/mainnet-deploy.sh), which passes --mainnet; a testnet never takes it
  const mainnet = args.includes("--mainnet");
  if (mainnet && !Object.hasOwn(MAINNETS, chainName)) throw new Error(`--mainnet is for ${Object.keys(MAINNETS).join(", ")}`);
  if (!mainnet && Object.hasOwn(MAINNETS, chainName)) throw new Error(`${chainName} is a mainnet: its deploy is the owner's paste (sh contracts/pool-evm/script/mainnet-deploy.sh ${chainName} <address>), which passes --mainnet`);
  const chain = chainOf(chainName);
  if (!chain) throw new Error(`--chain is one of ${Object.keys(CHAINS).join(", ")}`);
  const kept = mainnet ? opt("--sweep-kept") ?? null : null;
  if (args.includes("--sweep-kept") && !kept) throw new Error("--sweep-kept <journal> goes with --mainnet");
  const only = args.includes("--only") ? opt("--only") : null;
  if (only !== null && (mainnet || !(Object.hasOwn(ALONE, only) && chain.contracts.includes(only)))) throw new Error(`--only is one of ${Object.keys(ALONE).join(", ")}${mainnet ? ", on a testnet" : ""}`);
  const url = opt("--rpc") ?? chain.rpcs[0];
  const dryRun = isLoopback(url);
  if (mainnet && !dryRun && url !== chain.rpcs[0]) throw new Error(`--mainnet runs on ${chain.rpcs[0]} (and reads ${chain.rpcs[1]} too), or on a loopback fork with --out: not ${url}`);
  if (mainnet && !dryRun && opt("--out")) throw new Error(`--out is for a loopback fork: a mainnet run writes its record to ${path.relative(REPO, (io.recordOf ?? deploymentFile)(chainName))}`);
  const out = opt("--out") ?? (dryRun ? null : mainnet ? (io.recordOf ?? deploymentFile)(chainName) : only ? onlyFile(only, chainName) : deploymentFile(chainName));
  if (!out) throw new Error("a dry run (a loopback RPC) needs --out, so it never writes the real record");
  // every final check reads the chain's second RPC too (the fork's other loopback name on a dry run)
  const second = dryRun ? url.replace("127.0.0.1", "localhost") : chain.rpcs[1];
  const call = (method, params, u = url) => rpc(fetchFn, u, method, params, sleep, RPC_TRIES);
  const rel = (f) => path.relative(process.cwd(), f);
  const liveCheck = `node scripts/live-checks/${only ? ALONE[only].key : "pool-evm-deploy"}.mjs --deployment ${rel(out)}${dryRun ? ` --rpc ${url},${second}` : ""}`;

  // a final read on both RPCs: `read(u)` until `ok` holds on each, re-read up to 10 times 2 s apart (the second RPC may
  // trail the first by a block or two); the last answers either way
  const onBoth = async (read, ok) => {
    let got = [];
    for (let i = 0; i < 10; i++, await sleep(2000)) {
      got = [];
      for (const u of [url, second]) got.push([u, await read(u)]);
      if (got.every(([, v]) => ok(v))) break;
    }
    return got;
  };

  // the mainnet run's journal, beside the record: a stopped run's key may be kept; the same paste resumes with it, or
  // --sweep-kept sends its rest back
  const journalFile = mainnet ? journalOf(out) : null;
  let j0 = null;
  let resume = false;
  if (kept) {
    if (path.resolve(kept) !== path.resolve(journalFile)) throw new Error(`--sweep-kept ${kept}: ${chainName}'s journal is ${rel(journalFile)}`);
    if (!existsSync(journalFile)) throw new Error(`${rel(journalFile)} does not exist: no run's key is kept`);
    j0 = JSON.parse(readFileSync(journalFile, "utf8"));
    if (j0.chain !== chainName) throw new Error(`${rel(journalFile)} is ${j0.chain}'s, not ${chainName}'s`);
    // kept, or "in use": a run killed outright (during a deploy or its sweep) never wrote "kept"; the key file is checked
    // against the journal's deployer when it is read
    if (!j0.keys?.state || j0.keys.state === "removed") throw new Error(`${rel(journalFile)}: its run key is ${j0.keys?.state ?? "unknown"}: nothing to sweep`);
    if (opt("--return") !== undefined && returnAddress(opt("--return")) !== j0.return) throw new Error(`--sweep-kept goes back only to the run's return address ${j0.return}, not ${opt("--return")}`);
  } else if (mainnet) {
    if (existsSync(out)) {
      const j = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, "utf8")) : null;
      const left = j?.keys?.state && j.keys.state !== "removed" ? `; its run key is still ${j.keys.state}: send its rest back: ${sweepCommand(chainName)}` : "";
      throw new Error(`${rel(out)} exists: the pool is deployed on ${chainName}: run its live check alone: ${liveCheck}${left}`);
    }
    const elsewhere = await (io.deployedElsewhere ?? deployedElsewhere)(chainName);
    if (elsewhere) throw new Error(`the pool is deployed on ${chainName} already: ${elsewhere}`);
    if (existsSync(journalFile)) {
      const j = JSON.parse(readFileSync(journalFile, "utf8"));
      const keptWhy = `(${(j.keys?.why ?? []).join("; ") || "its state unknown"})`;
      if (j.keys?.state !== "removed") {
        // a stopped run whose key is kept: this run resumes with that key, to that run's return address only
        if (j.chain !== chainName) throw new Error(`${rel(journalFile)} is ${j.chain}'s, not ${chainName}'s`);
        if (j.complete) throw new Error(`${rel(journalFile)}: a completed run's key is kept ${keptWhy}: send its rest back: ${sweepCommand(chainName)}`);
        if (returnAddress(opt("--return")) !== j.return) throw new Error(`${rel(journalFile)}: a stopped run's key is kept ${keptWhy}; the paste resumes only to the run's return address ${j.return}, not ${opt("--return")}; or send its rest back: ${sweepCommand(chainName)}`);
        j0 = j;
        resume = true;
      }
    }
    if (existsSync(journalFile) && !resume) {
      const j = JSON.parse(readFileSync(journalFile, "utf8"));
      const aside = `${out.replace(/\.json$/, "")}.stopped-${String(j.stopped_at ?? j.at).replace(/[^0-9TZ]/g, "")}.journal.json`;
      renameSync(journalFile, aside);
      console.log(`deploy: the stopped run's journal (its key removed) moved to ${rel(aside)}`);
    }
  }
  const ret = kept || resume ? j0.return : returnAddress(opt("--return"));

  // 1. the chain, and where the rest goes: an account with no code (a contract could refuse the sweep or keep it); on
  // a mainnet also a wallet in use, holding ETH, on both RPCs: the address the owner sends the funding from
  const id = await call("eth_chainId", []);
  if (!mainnet && MAINNET_IDS[id]) throw new Error(`${url} answers ${MAINNET_IDS[id]} mainnet (${id}): its deploy is the owner's`);
  if (id !== chain.chainId) throw new Error(`${url} answers chain id ${id}, not ${chainName}'s ${chain.chainId}`);
  console.log(`deploy: ${chainName} (${BigInt(id)}) on ${url}${dryRun ? ", a loopback fork: the dry run" : ""}`);
  for (const u of dryRun ? [url, ...(mainnet ? [second] : [])] : chain.rpcs) {
    if ((await call("eth_chainId", [], u)) !== chain.chainId) throw new Error(`${u} does not answer ${chainName}'s chain id`);
    const c = await call("eth_getCode", [ret, "latest"], u);
    if (c !== "0x") throw new Error(`--return ${ret} has code on ${u} (${(c.length - 2) / 2} bytes): the rest goes only to an account with none`);
    if (mainnet && !kept && !(big(await call("eth_getBalance", [ret, "latest"], u)) > 0n)) throw new Error(`--return ${ret} holds no ETH on ${u}: pass the wallet you send the funding from`);
  }

  const startedAt = new Date().toISOString();
  let pinned, forgeVersion, sk, deployer, names, addrs, datas, gas, need, keyDir, inits;
  let journalKeys = null;
  let keysBase0 = null;
  const big0 = (x) => (x === undefined || x === null ? x : BigInt(x));
  // a stopped run's kept key, for --sweep-kept or a resume
  const loadKept = () => {
    const base = io.keysBase ?? keysBase();
    keyDir = path.join(base, String(j0.keys?.folder ?? ""));
    if (!j0.keys?.folder || path.basename(j0.keys.folder) !== j0.keys.folder || !existsSync(path.join(keyDir, "key"))) throw new Error(`${rel(journalFile)}: its key folder ${j0.keys?.folder} is not in ${base}`);
    sk = bytes(readFileSync(path.join(keyDir, "key"), "utf8").trim());
    deployer = addressOf(sk);
    if (deployer !== j0.deployer) throw new Error(`${keyDir}/key is not the key of ${j0.deployer}`);
  };
  const isBuild = (n, code) => {
    const got = runtimeOf(code, pinned[n].immutables);
    return got.length === pinned[n].length && got.masked === pinned[n].masked;
  };
  let rest = [];
  let nonce0 = 0n;
  if (kept) {
    // --sweep-kept: the stopped run's key, its signed transactions (each settled or replaced as in a run), then the sweep
    loadKept();
    names = [];
    addrs = {};
    need = BigInt(j0.need ?? 0);
    journalKeys = { ...j0.keys };
    console.log(`deploy: --sweep-kept: the run key ${deployer}'s rest back to ${ret}`);
  } else {
    // 2. the build
    if (!args.includes("--no-build")) {
      const b = spawnSync("forge", ["build", "--root", POOL_DIR], { stdio: "inherit" });
      if (b.status !== 0) throw new Error("forge build failed");
    }
    pinned = JSON.parse(readFileSync(BUILD_FILE, "utf8")).contracts;
    const built = buildOf();
    for (const n of ORDER) if (JSON.stringify(built[n]) !== JSON.stringify(pinned[n])) throw new Error(`${n}: forge's build differs from ${path.basename(BUILD_FILE)}`);
    names = only ? [only] : chain.contracts;
    // read once: the bytes checked here are the bytes sent
    inits = Object.fromEntries(names.map((n) => [n, initOf(n)]));
    if (mainnet) for (const n of names) {
      const p = initProblems(n, inits[n]);
      if (p) throw new Error(p);
    }
    forgeVersion = spawnSync("forge", ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? "forge";

    // 3. the run key and the addresses; on a mainnet the key goes to a 0700 folder (file 0600) until the cleanup reads
    // it empty on both RPCs, so a run killed outright leaves a key --sweep-kept can still send back
    if (resume) {
      loadKept();
      journalKeys = { ...j0.keys, state: "in use", why: [] };
    } else {
      sk = secp256k1.utils.randomSecretKey();
      deployer = addressOf(sk);
    }
    if (deployer === ret) throw new Error("--return is the run key itself");
    // a new mainnet key stays in memory until the run's try: then its folder and the journal are written together
    if (mainnet && !resume) keysBase0 = io.keysBase ?? keysBase();
    let n0 = 0n;
    const reused = {};
    if (resume) {
      // what the stopped run made is reused once its receipt and its code on both RPCs read back as the build's; the
      // rest is deployed at the key's next nonces
      console.log(`deploy: run key ${deployer} (the stopped run's, kept in ${keyDir}; never printed)`);
      n0 = big(await call("eth_getTransactionCount", [deployer, "latest"]));
      const pending = big(await call("eth_getTransactionCount", [deployer, "pending"]));
      if (pending !== n0) throw new Error(`the run key ${deployer} has ${pending - n0} transaction(s) pending: wait for them, or send its rest back: ${sweepCommand(chainName)}`);
      for (const t of j0.txs ?? []) {
        const n = t.contract;
        if (!n || t.step !== `deploy ${n}` || !names.includes(n) || reused[n] || !/^0x[0-9a-f]{40}$/.test(String(t.address))) continue;
        const rc = await call("eth_getTransactionReceipt", [t.hash]);
        if (!rc && big(t.nonce) < n0) {
          // its nonce is spent, so something of the key's landed there: one of the journal's (this deploy, or a cancel
          // that replaced it) must show a receipt, or the run cannot tell whether the contract exists
          let seen = false;
          for (const o of (j0.txs ?? []).filter((x) => x.nonce === t.nonce && x.hash !== t.hash)) if (await call("eth_getTransactionReceipt", [o.hash])) seen = true;
          if (!seen) throw new Error(`the stopped run's ${t.step} ${t.hash} at nonce ${t.nonce}: the nonce is spent but no journaled transaction there has a receipt on ${url}: nothing was sent; run the same paste again once the RPC has it, or send the key's rest back: ${sweepCommand(chainName)}`);
        }
        if (!rc || rc.status !== "0x1" || rc.contractAddress?.toLowerCase() !== t.address) continue;
        // it landed: it is reused, or the run stops here, before any funding (deploying it again would leave a pool
        // pointing at a verifier the record does not name)
        const codes = await onBoth((u) => call("eth_getCode", [t.address, "latest"], u), (code) => isBuild(n, code));
        const bad = codes.filter(([, code]) => !isBuild(n, code)).map(([u]) => u);
        if (bad.length) throw new Error(`the stopped run's ${n} at ${t.address} (${t.hash}) landed, but its code does not read back as the build's on ${bad.join(" and ")}: nothing was sent; run the same paste again once both RPCs have it, or send the key's rest back: ${sweepCommand(chainName)}`);
        reused[n] = t.address;
      }
      if (reused.PrivacyPoolSimple && !reused.WithdrawalVerifier) throw new Error(`the stopped run's pool ${reused.PrivacyPoolSimple} is reused only with its verifier, which did not read back: nothing was sent; send the key's rest back: ${sweepCommand(chainName)}`);
    } else {
      console.log(`deploy: run key ${deployer} (made in this run, never printed)`);
      if (big(await call("eth_getTransactionCount", [deployer, "pending"])) !== 0n) throw new Error(`${deployer} has sent transactions already`);
    }
    if (only) console.log(`deploy: ${only} alone (--only), to ${rel(out)}`);
    rest = names.filter((n) => !reused[n]);
    addrs = { ...reused, ...Object.fromEntries(rest.map((n, i) => [n, createAddress(deployer, n0 + BigInt(i))])) };
    if (resume) console.log(`deploy: resuming the stopped run with its key: ${Object.entries(reused).map(([n, a]) => `${n} ${a}`).join(", ") || "nothing"} read back on both RPCs as the build's: reused; ${rest.join(", ") || "nothing"} to deploy from nonce ${n0}`);
    datas = Object.fromEntries(rest.map((n) => [n, inits[n] + argsOf(n, chain, addrs).map(addrArg).join("")]));
    nonce0 = n0;
  }

  // 4. the need
  // the fee terms on each RPC; the lower max fee of the two (one that fails leaves the other's; both failing throws)
  const feesOn = async (u) => {
    const block = await call("eth_getBlockByNumber", ["latest", false], u);
    const tip = big(await call("eth_maxPriorityFeePerGas", [], u).catch(() => "0x0"));
    return { tip, maxFee: 2n * big(block.baseFeePerGas) + tip };
  };
  const fees = async () => {
    const got = [];
    let err = null;
    for (const u of [url, second]) {
      try {
        got.push(await feesOn(u));
      } catch (e) {
        err = e;
      }
    }
    if (!got.length) throw err;
    return got.reduce((a, b) => (b.maxFee < a.maxFee ? b : a));
  };
  const l1Bound = async (n) => (chain.op ? big(await call("eth_call", [{ to: OP_ORACLE, data: selector("getL1FeeUpperBound(uint256)") + word(n) }, "latest"])) : 0n);
  const transferGas = async (to) => GAS_MARGIN(big(await call("eth_estimateGas", [{ from: deployer, to, value: "0x0" }, "latest"])));
  const { tip, maxFee } = await fees();
  if (mainnet && !kept && maxFee > MAX_FEE_CAP) throw new Error(`the max fee ${maxFee} wei/gas is over the cap ${MAX_FEE_CAP} (deploy.mjs MAX_FEE_CAP): no key was kept and nothing was sent`);
  if (!kept) {
    const verifierCode = JSON.parse(readFileSync(path.join(POOL_DIR, "out/WithdrawalVerifier.sol/WithdrawalVerifier.json"), "utf8")).deployedBytecode.object;
    gas = {};
    for (const [i, n] of rest.entries()) {
      // each estimate at the nonce its deploy will have, so it creates at the address the deploy will
      const over = { [deployer]: { nonce: "0x" + (nonce0 + BigInt(i)).toString(16) } };
      if (n === "PrivacyPoolSimple") over[addrs.WithdrawalVerifier] = { code: verifierCode };
      gas[n] = GAS_MARGIN(big(await call("eth_estimateGas", [{ from: deployer, data: datas[n] }, "latest", over])));
    }
    const parts = [];
    for (const n of rest) parts.push([n, gas[n] * maxFee + (await l1Bound(BigInt(bytes(datas[n]).length) + SWEEP_TX_BYTES))]);
    parts.push(["the sweep", (await transferGas(ret)) * maxFee + 2n * (await l1Bound(SWEEP_TX_BYTES))]);
    need = parts.reduce((s, [, v]) => s + v, 0n);
    console.log(`deploy: max fee ${maxFee} wei/gas (tip ${tip}); need ${need} wei (${eth(need)}): ${parts.map(([n, v]) => `${n} ${v}`).join(", ")}`);
  }

  // Every transaction the run signs, recorded before it is sent, so one whose send answer is lost is still waited for
  // and listed: { step, hash, raw, nonce, tip, maxFee, gas, sentAt, receipt }. The record lists the ones that landed.
  // A --sweep-kept run starts from its journal's.
  const signed = kept || resume
    ? (j0.txs ?? []).map((s) => ({ ...s, nonce: big0(s.nonce), tip: big0(s.tip), maxFee: big0(s.maxFee), gas: big0(s.gas), receipt: null }))
    : [];
  let stopped = null;
  let stoppedAt = null;
  let complete = false;
  // On a mainnet the journal (journalFile) holds the run's state, rewritten before each send and in the finally: every
  // signed transaction (its raw form is public once sent; no key), the key folder's name and state and why
  const writeJournal = () => {
    if (!journalFile) return;
    const txs = signed.map((s) => ({ step: s.step, ...(s.contract ? { contract: s.contract } : {}), ...(s.address ? { address: s.address } : {}), hash: s.hash, raw: s.raw, nonce: String(s.nonce), tip: String(s.tip), maxFee: String(s.maxFee), gas: String(s.gas), sentAt: s.sentAt, landed: Boolean(s.receipt) || Boolean(s.landed) }));
    const j = { chain: chainName, chainId: Number(BigInt(id)), dryRun, return: ret, deployer, need: String(need ?? (j0?.need ?? "0")), at: j0?.at ?? startedAt, complete: complete || Boolean(j0?.complete), stopped: stopped ?? (kept ? j0?.stopped : null) ?? null, stopped_at: stoppedAt ?? (kept ? j0?.stopped_at : null) ?? null, keys: journalKeys, txs };
    writeAtomic(journalFile, JSON.stringify(j, null, 2) + "\n");
  };
  const landed = () => signed.filter((s) => s.receipt).sort((a, b) => Number(a.nonce - b.nonce));
  const send = async (step, t, extra = {}) => {
    const s = { step, ...extra, nonce: t.nonce, tip: t.maxPriorityFeePerGas, maxFee: t.maxFeePerGas, gas: t.gas, ...signTx(sk, { chainId: big(id), ...t }), sentAt: now(), receipt: null };
    signed.push(s);
    writeJournal();
    try {
      await call("eth_sendRawTransaction", [s.raw]);
    } catch (e) {
      // a resend of a send whose answer was lost (or one already mined) is the node saying it has it. Another JSON-RPC
      // error answer is the node's refusal: that transaction is dropped, so it never becomes the fee basis of a
      // replacement. No answer at all (every try failed) leaves its outcome unknown: it stays journaled and is waited
      // for as sent (the settle sends it again or replaces it)
      if (e.rpcError && !/already known|known transaction|nonce too low|already imported/i.test(e.message)) {
        signed.splice(signed.indexOf(s), 1);
        writeJournal();
        throw e;
      }
      if (!e.rpcError) console.error(`deploy: ${step} ${s.hash}: no answer to its send (${String(e.message).split("\n")[0]}): waited for as sent`);
    }
    return s;
  };
  // The fees for a transaction at nonce n: the chain's now, and when the key has sent one at n already, a bump over
  // the highest of each term it sent there (a replacement geth takes)
  const priceAt = (n, f) => {
    const at = signed.filter((s) => s.nonce === n);
    if (!at.length) return f;
    const tip = maxOf(bump(maxOf(...at.map((s) => s.tip))), f.tip);
    return { tip, maxFee: maxOf(bump(maxOf(...at.map((s) => s.maxFee))), f.maxFee, tip) };
  };
  const receiptOf = async (s) => (s.receipt ??= await call("eth_getTransactionReceipt", [s.hash]));
  const waitReceipt = async (s, ms) => {
    for (const end = now() + ms; now() < end; await sleep(2000)) if (await receiptOf(s)) return s.receipt;
    return null;
  };
  // The record: every transaction of the key that landed, in nonce order, and each contract its landed deploy made (a
  // resumed run's reused deploys included: their receipts are read first). `prev`, a record already written, keeps its
  // own run fields (--sweep-kept rewrites it with the sweeps).
  const record = async (prev = null) => {
    for (const s of signed) await receiptOf(s);
    const made = landed().filter((s) => s.contract && s.step === `deploy ${s.contract}` && s.address);
    const txs = landed().map((s) => ({ step: s.step, hash: s.hash, ...(s.contract ? { contract: s.contract } : {}) }));
    const d = {
      chain: chainName, chainId: Number(BigInt(id)), dryRun, at: prev?.at ?? new Date().toISOString(), deployer, return: ret, need: prev?.need ?? need.toString(),
      build: prev?.build ?? `solc 0.8.28 (contracts/pool-evm/foundry.toml), ${forgeVersion}`,
      contracts: Object.fromEntries(chain.contracts.filter((n) => made.some((s) => s.contract === n)).map((n) => [n, { address: made.find((s) => s.contract === n).address }])),
      txs,
    };
    writeAtomic(out, JSON.stringify(d, null, 2) + "\n");
    console.log(`deploy: wrote ${out}`);
  };

  // 6a. the settle: until the key's latest nonce covers every nonce it signed, each still pending is sent again; one
  // pending longer than WAITS.stuck is replaced at its nonce by a cancel (0 to the key itself) paying 12.5% more
  const settle = async () => {
    for (const end = now() + WAITS.settle; ; ) {
      const latest = big(await call("eth_getTransactionCount", [deployer, "latest"]));
      for (const s of signed) await receiptOf(s);
      const top = signed.reduce((m, s) => (s.nonce + 1n > m ? s.nonce + 1n : m), 0n);
      if (latest >= top) return true;
      if (now() >= end) return false;
      for (let n = latest; n < top; n++) {
        const last = signed.filter((s) => s.nonce === n).at(-1);
        if (now() - last.sentAt < WAITS.stuck) {
          await call("eth_sendRawTransaction", [last.raw]).catch(() => {});
          continue;
        }
        const p = priceAt(n, await fees());
        const c = await send(`cancel (replaces ${last.step} at nonce ${n})`, { nonce: n, maxPriorityFeePerGas: p.tip, maxFeePerGas: p.maxFee, gas: await transferGas(deployer), to: deployer, value: 0n })
          .catch((e) => console.error(`deploy: cancel at nonce ${n} not taken: ${e.message}`));
        if (c) console.log(`deploy: nonce ${n} pending since ${Math.round((now() - last.sentAt) / 1000)} s: replaced by a cancel ${c.hash}`);
      }
      await sleep(WAITS.poll);
    }
  };
  // 6b. the sweep: once settled, all but its fee bound (the L1 fee bound read on each pass, doubled) goes to --return,
  // again while what is left is more than two such bounds; a failure is retried with backoff over WAITS.sweep
  let sweeping = null;
  const sweep = () => (sweeping ??= (async () => {
    const end = now() + WAITS.sweep;
    for (let wait = WAITS.poll; ; ) {
      try {
        if (!(await settle())) console.error(`deploy: the run key's transactions have not all landed after ${WAITS.settle / 1000} s; sweeping anyway`);
        // at the latest nonce: after a settle that ran out, a sweep that replaces what is pending there, priced above it
        const nonce = big(await call("eth_getTransactionCount", [deployer, "latest"]));
        const bal = big(await call("eth_getBalance", [deployer, "latest"]));
        const p = priceAt(nonce, await fees());
        const g = await transferGas(ret);
        const reserve = g * p.maxFee + 2n * (await l1Bound(SWEEP_TX_BYTES));
        if (bal <= 2n * reserve) {
          console.log(`deploy: run key keeps ${bal} wei, less than two sweeps' fee bound (${2n * reserve})`);
          return;
        }
        const s = await send("sweep (the run key's rest back)", { nonce, maxPriorityFeePerGas: p.tip, maxFeePerGas: p.maxFee, gas: g, to: ret, value: bal - reserve });
        console.log(`deploy: sweep ${bal - reserve} wei to ${ret}: ${s.hash}`);
        await waitReceipt(s, WAITS.receipt); // no receipt yet: the next pass's settle waits for it or replaces it
      } catch (e) {
        if (now() >= end) throw e;
        console.error(`deploy: sweep pass failed (${String(e.message).split("\n")[0]}); again in ${wait / 1000} s`);
        await sleep(wait);
        wait = wait * 2 > 60_000 ? 60_000 : wait * 2;
      }
    }
  })());

  // A signal stops the run at its next step: a transaction already sent is waited for, so the sweep never races a
  // deploy for a nonce; the finally below then sweeps. Later signals never cut the sweep short.
  // a kept journal that signed nothing is a run stopped (or killed) in its funding wait: its funding is unread, so
  // --sweep-kept watches the key for WAITS.lateFunding, sweeps what landed, and keeps the key (a transfer may still land)
  let funded = Boolean(kept) && (j0.txs ?? []).length > 0;
  const onSignal = (s) => {
    if (stopped) return console.error(`deploy: ${s} again: the sweep finishes first`);
    stopped = s;
    stoppedAt = new Date().toISOString();
    console.error(`deploy: ${s}: stopping at the next step, then sweeping`);
  };
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of SIGNALS) process.on(s, onSignal);
  const go = () => {
    if (stopped) throw new Error(`stopped by ${stopped}`);
  };

  if (keysBase0) {
    // no await from here to the try: a signal is handled once the try runs, and a throw before it leaves no key behind
    mkdirSync(keysBase0, { recursive: true, mode: 0o700 });
    chmodSync(keysBase0, 0o700);
    keyDir = mkdtempSync(path.join(keysBase0, `${chainName}-`));
    chmodSync(keyDir, 0o700);
    writeFileSync(path.join(keyDir, "key"), hex(sk) + "\n", { mode: 0o600 });
    journalKeys = { folder: path.basename(keyDir), state: "in use", why: [], sweep: sweepCommand(chainName) };
  }
  let done = false;
  try {
    writeJournal();
    if (keysBase0) console.log(`deploy: the run key is kept in ${keyDir} until the run reads it empty on both RPCs`);
    if (!kept) {
      // 4. the funding
      // what the key holds first (a resumed run's kept key may hold some or all of the need): the line asks only for the
      // shortfall, and for nothing when the key holds the need, so no transfer is asked for that the run would not wait for
      let held0 = null;
      while (held0 === null) {
        go();
        try {
          held0 = big(await call("eth_getBalance", [deployer, "latest"]));
        } catch (e) {
          console.log(`deploy: the run key's balance not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
          await sleep(WAITS.poll);
        }
      }
      if (held0 >= need) console.log(`deploy: the run key ${deployer} holds ${held0} wei, at least the need ${need} wei: send nothing`);
      else {
        const short = need - held0;
        console.log(`deploy: waiting for ${short} wei (${eth(short)}) at ${deployer} on ${chainName}${held0 > 0n ? `: the need ${need} wei less the ${held0} it holds` : ""}`);
        if (mainnet) console.log(`deploy: send exactly ${short} wei (${ethExact(short)}) to ${deployer} from ${ret}, the address you passed`);
      }
      // a read that fails (its five tries all rate-limited or reset) is read again at the next poll: a run that ended
      // here would leave the owner's transfer to a run that is gone (the Solana devnet rehearsal's run, 5 Nov 18:47Z)
      for (;;) {
        go();
        let held = -1n;
        try {
          held = big(await call("eth_getBalance", [deployer, "latest"]));
        } catch (e) {
          console.log(`deploy: the run key's balance not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
        }
        if (held >= need) break;
        await sleep(WAITS.poll);
      }
      funded = true;
      console.log("deploy: funded");

      // 5. the deploys
      for (const [i, n] of rest.entries()) {
        go();
        const f = await fees();
        const maxFeePerGas = f.maxFee > maxFee ? maxFee : f.maxFee; // never above what the need was counted at
        const s = await send(`deploy ${n}`, { nonce: nonce0 + BigInt(i), maxPriorityFeePerGas: f.tip > maxFeePerGas ? maxFeePerGas : f.tip, maxFeePerGas, gas: gas[n], to: null, data: datas[n] }, { contract: n, address: addrs[n] });
        const r = await waitReceipt(s, WAITS.receipt);
        if (!r) throw new Error(`deploy ${n} ${s.hash}: no receipt in ${WAITS.receipt / 1000} s`);
        if (r.status !== "0x1" || r.contractAddress?.toLowerCase() !== addrs[n]) throw new Error(`deploy ${n} ${s.hash}: status ${r.status}, contract ${r.contractAddress}, want ${addrs[n]}`);
        const code = await call("eth_getCode", [addrs[n], "latest"]);
        const got = runtimeOf(code, pinned[n].immutables);
        if (got.length !== pinned[n].length || got.masked !== pinned[n].masked) throw new Error(`${n} at ${addrs[n]}: code is not the build's`);
        console.log(`deploy: ${n} ${addrs[n]} (${s.hash}), ${r.gasUsed && big(r.gasUsed)} gas, code is the build's`);
      }
      // each contract's code read again on both RPCs: the build's on each
      for (const n of names) {
        for (const [u, code] of await onBoth((u) => call("eth_getCode", [addrs[n], "latest"], u), (code) => isBuild(n, code))) {
          if (!isBuild(n, code)) throw new Error(`${n} at ${addrs[n]}: code on ${u} is not the build's`);
        }
      }
      console.log(`deploy: every contract's code is the build's on ${url} and ${second}`);
      done = true;
      complete = true;
      // the record (the one-deploy guard) before the sweep: a run killed during the sweep leaves it, and the sweep's
      // own transactions join it after (here, or by --sweep-kept)
      if (mainnet) {
        await record();
        writeJournal();
      }
    }
  } finally {
    try {
      if (!funded) {
        // stopped while waiting: a funding transfer may be in flight; watch the balance before the final sweep
        console.log(`deploy: ${kept ? "its run stopped in its funding wait" : "stopped before funding"}; watching ${deployer}'s balance for ${WAITS.lateFunding / 1000} s`);
        for (const end = now() + WAITS.lateFunding; now() < end; ) await sleep(WAITS.poll);
        if (kept) {
          // the transfer the run asked for (its need) has landed: nothing more is coming, and the key may go once swept;
          // less than that (nothing, or a part) and the key is kept
          const bal = await call("eth_getBalance", [deployer, "latest"]).then(big, () => 0n);
          if (bal >= BigInt(j0.need ?? 0) && bal > 0n) funded = true;
          else console.log(`deploy: the run key holds ${bal} wei, less than the ${j0.need} wei its run asked for: it is kept, since that transfer may still land`);
        }
      }
      await sweep();
    } catch (e) {
      console.error(`deploy: SWEEP FAILED: ${e.message}; the run key ${deployer} still holds its balance`);
      process.exitCode = 1;
    } finally {
      // a mainnet key: removed only once both RPCs read it at most DUST with every nonce it signed landed, and never
      // after a stop before the funding was read (a transfer may still land); kept otherwise, with why and the paste's
      // sweep form
      if (journalKeys) {
        const why = [];
        if (!funded) why.push(kept ? "its run stopped in its funding wait, so a transfer to it may still land: run --sweep-kept again to send back what does" : "the run stopped before its funding was read: a transfer may still land");
        const made = signed.filter((s) => s.contract && s.receipt?.status === "0x1").length;
        if (!kept && !complete && made > 0) why.push(`the deploy stopped: it made ${made} of ${names.length} contracts: the same paste resumes with this key and reuses them`);
        try {
          const top = signed.reduce((m, s) => (s.nonce + 1n > m ? s.nonce + 1n : m), 0n);
          const left = await onBoth(async (u) => ({ bal: big(await call("eth_getBalance", [deployer, "latest"], u)), nonce: big(await call("eth_getTransactionCount", [deployer, "latest"], u)) }), (v) => v.bal <= DUST && v.nonce >= top);
          for (const [u, v] of left) {
            if (v.bal > DUST) why.push(`it holds ${v.bal} wei on ${u}`);
            if (v.nonce < top) why.push(`its nonce ${v.nonce} on ${u} is below the ${top} it signed`);
          }
        } catch (e) {
          why.push(`its rest was not read: ${String(e.message).split("\n")[0]}`);
        }
        if (why.length) {
          journalKeys = { ...journalKeys, state: "kept", why };
          console.error(`deploy: the run key ${deployer} is kept in ${keyDir}: ${why.join("; ")}. The same paste resumes with it; or send its rest back with: ${sweepCommand(chainName)}`);
        } else {
          rmSync(keyDir, { recursive: true, force: true });
          journalKeys = { ...journalKeys, state: "removed", why: [] };
          console.log(`deploy: the run key ${deployer} holds at most ${DUST} wei on both RPCs: its key folder is removed`);
        }
      }
      try {
        writeJournal();
      } finally {
        for (const s of SIGNALS) process.off(s, onSignal);
      }
    }
    if (kept) {
      // a deployed chain's record gets the sweeps this run landed, so the live check's nonce count holds
      if (existsSync(out)) {
        // rewritten from every transaction of the key that landed (the journal's and this run's), each deploy with its
        // contract: a killed run's sweep, and a resumed run's reused deploys its record missed
        const d = JSON.parse(readFileSync(out, "utf8"));
        const have = new Set(d.txs.map((t) => t.hash));
        const more = landed().filter((s) => !have.has(s.hash)).length;
        if (more) {
          await record(d);
          console.log(`deploy: ${rel(out)} lists the ${more} more transaction(s) of the key`);
        }
      }
    } else if (signed.length && (!mainnet || complete)) {
      // a mainnet record is written only by a completed run: it is the one-deploy guard
      await record();
      if (journalFile && complete && journalKeys?.state === "removed") rmSync(journalFile, { force: true });
    }
  }
  if (kept) return;
  if (!done) throw new Error("the deploy stopped; the record lists what landed");
  console.log(`deploy: done. Next: ${liveCheck}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--write-build")) {
      const file = {
        notes: [
          "Each contract's runtime as forge builds it (solc 0.8.28, contracts/pool-evm/foundry.toml): its length, the keccak256 of the runtime with every immutable's 32 bytes zeroed, and each immutable's start offsets. Written by contracts/pool-evm/script/deploy.mjs --write-build; test/deploy.test.mjs fails when forge's output differs; CI runs it after its forge test, with the forge CI installs (1.7.1). Forge 1.7.1 and 1.8.6 both build these bytes (solc 0.8.28 does the compiling): the test passed on 1.7.1 and the dry run, whose deploy.mjs refuses a build that differs, ran on 1.8.6, 2026-11-03. SellDelegate rebuilt for card evm-sell-v4 (constructor(IWETH, IPoolManager)) with forge 1.7.1, the version CI installs, on 2026-11-04, and again for card evm-selldelegate-exact-debit (W's balance of the token falls by exactly the amount) with forge 1.7.1 on 2026-11-04, and for pool review round 2 (R-3: WETH is read only for a route that can pay in it) on 2026-11-05.",
        ],
        contracts: buildOf(),
      };
      const frozen = existsSync(BUILD_FILE) ? JSON.parse(readFileSync(BUILD_FILE, "utf8")).frozen : undefined;
      if (frozen) file.frozen = frozen;
      writeFileSync(BUILD_FILE, JSON.stringify(file, null, 2) + "\n");
      console.log(`deploy: wrote ${path.relative(process.cwd(), BUILD_FILE)}`);
    } else {
      await main(args);
    }
  } catch (e) {
    console.error(`deploy: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
