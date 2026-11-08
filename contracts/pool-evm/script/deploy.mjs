#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deploys the Blindfill EVM pool to Base Sepolia or Robinhood testnet, or with --mainnet to Base or Robinhood (or an
// anvil fork of one, the dry run), with no admin: the withdrawal verifier, the pool, the v4 adapter, the v3 adapter
// (of the testnets Base Sepolia only; both mainnets, M365), the sell delegate and, on the mainnets, the fee collector
// (card evm-mainnet-senders; its sink as for --only FeeCollector below, read before any key is made). The deployer is a run key made in memory; it is never printed or passed to another process, and written
// only on a mainnet run, to its 0700 key folder until swept.
//
//   node contracts/pool-evm/script/deploy.mjs --chain <base-sepolia|robinhood-testnet> --return <address>
//     [--only SellDelegate|FeeCollector] [--rpc <url>] [--out <file>] [--no-build]
//   node contracts/pool-evm/script/deploy.mjs --write-build      rewrites scripts/live-checks/pool-evm-deploy.build.json
//     from forge's output (out/), after a forge build; its `frozen` map (code already deployed from an older build,
//     pinned to the addresses that hold it) is kept as it is
//
// --only SellDelegate (card evm-sell-v4) deploys the sell delegate alone, constructed with the chain's WETH and v4
// PoolManager, with every step below the same (a fresh run key at nonce 0, so the delegate is CREATE(key, 0)); its
// record goes to scripts/live-checks/evm-testnet-delegate-review3.<chain>.json (or --out), and its live check is
// evm-testnet-delegate-review3.mjs (card evm-testnet-delegate-review3's redeploy at the pool-review-3 build;
// evm-sell-v4's and evm-selldelegate-exact-debit's records keep theirs).
// --only FeeCollector (card evm-fee-collector) deploys the fee collector alone, beside the chain's set (the testnets'
// 3 Nov sets predate it; the mainnet sets end with it), constructed with its sink: the sell sender the kit pins for the
// chain (evmPoolVenues() sellSender) as origin/main has it (sinkOf: a checkout whose KIT_PIN_FILE differs from main's
// is refused), refused when the kit pins none or the pin has code on either RPC (an EIP-7702 delegation), before a key
// is made (a mainnet paste too); its
// record (evm-fee-collector.<chain>.json, or --out) names the sink beside the address, and its live check is
// evm-fee-collector.mjs.
//
//   node contracts/pool-evm/script/deploy.mjs --mainnet --chain <base|robinhood> --return <address> [--rpc <loopback> --out <file>]
//   node contracts/pool-evm/script/deploy.mjs --mainnet --chain <base|robinhood> --sweep-kept <journal> [--return <address>]
//     the owner's paste (script/mainnet-deploy.sh, card pool-evm-deploy-mainnet) and its sweep form. A mainnet run
//     differs from a testnet run in these, each refused before a key is made: the RPC is the chain's first in
//     pool-evm-deploy.mjs MAINNETS (or a loopback fork of it with --out, the rehearsal); the record goes to
//     contracts/pool-evm/deployments/<chain>.json, and once it exists the run is refused, naming the live check, as it
//     is when origin/main holds that record or the kit pins a pool for the chain (deployedElsewhere); a checkout that is
//     not main's code is refused (mainCheckout; not on a loopback fork, which runs a card's branch); --return must
//     also hold ETH on both RPCs (the wallet the owner funds from); each contract's init code must be MAINNET_INIT's,
//     and those checked bytes are the ones sent; the max fee (the lower of both RPCs') must be at most MAX_FEE_CAP.
//     Then: the run key, made in memory, is kept in a 0700 folder (keysBase(), file 0600), written with the journal just
//     before the run's try (a throw before it leaves no key behind), until the cleanup reads it at
//     most DUST on both RPCs with every nonce it signed landed, each RPC read at the head block it names
//     (eth_blockNumber), once that head and its safe block are at or past every receipt of the key's (a public RPC
//     serves state only near its head, and never at "safe"), and what the key has received (that balance plus each
//     landed transaction's outflowOf) covers every funding its runs asked for (the journal's asked); never removed
//     after a stop before the funding was read (on both RPCs), nor while a run not whole made a contract (a receipt
//     or code at a journaled deploy address on either RPC: the same paste resumes, in the run and in --sweep-kept
//     alike); the run's journal (the record's path, .journal.json) holds every transaction it signs, written before
//     the send and in the finally, and the key's state. A stopped run that made a contract keeps its key; while a
//     journal's key is kept the same paste (the same --return, no other) resumes with that key: each contract the
//     stopped run made is reused once its receipt and its code on both RPCs read back as the build's (a fee collector's
//     with this run's sink at its immutable; one that landed
//     but does not read back stops the resume before any funding, and the pool is reused only with its verifier), and
//     only the rest is deployed, at the key's next nonces; or --sweep-kept sends the key's rest back to that journal's
//     return address, and no other, then removes the key unless something still keeps it (a run not whole that made a
//     contract keeps it for the resume; a transfer it asked for still to land): any journal whose key is not removed ("kept", or "in use" after
//     a run killed outright), the return wallet's balance not asked; a journal that signed nothing (a run stopped in its
//     funding wait) is watched for WAITS.lateFunding and its key kept until the need its run asked for has landed:
//     its balance plus what it sent out since the wait (outflowOf: each landed transaction's fee and value, from its
//     receipt, counted from the journal's wait_txs on, so a stopped run's own transactions never count) reaches the
//     need. Each journaled transaction keeps its value and to for that count. A stopped run's journal whose key is removed is moved
//     aside by the next run; a completed run's is removed once its key is and the record lists a landed transaction at
//     every nonce the key signed (by the run, or by --sweep-kept), the receipts the cleanup read joining the record first. The record is written once every deploy is made, before the sweep, and again with the sweep; a
//     run that made fewer writes none. The journal and the record are each written whole (writeAtomic). Each contract's
//     code is read again on both RPCs. The funding line asks for the need less what the key holds, in wei and, exactly,
//     in ETH, and for nothing when the key holds the need (a resume's kept key). Each RPC call is tried RPC_TRIES times.
//
// Steps:
//  1. The chain from eth_chainId: the named testnet's id, on its RPC or on a loopback URL (an anvil fork of it, the dry
//     run, which needs --out so it never writes the real record). A mainnet id is refused: that deploy is the owner's.
//     --return must not be the zero address, must pass its EIP-55 checksum when mixed case, and must have no code on
//     the chain's two RPCs (the fork's one URL on a dry run).
//  2. The build: forge-std set up at its pinned commit (forgeStdReady), forge build --root contracts/pool-evm (CI's
//     command), and each contract's runtime checked against
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
//  7. Writes the deployment record (scripts/live-checks/pool-evm-deploy.<chain>.json, evm-testnet-delegate-review3.<chain>.json with
//     --only SellDelegate, or --out) with every
//     transaction that landed, in nonce order, and prints the live check to run next.
import "../../../scripts/net-window.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
export const ORDER = ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate", "FeeCollector"];
const argsOf = (name, chain, addrs, sink) => ({
  WithdrawalVerifier: [],
  PrivacyPoolSimple: [addrs.WithdrawalVerifier],
  UniswapV4Adapter: [chain.poolManager.address, chain.weth.address],
  UniswapV3Adapter: [chain.router?.address],
  SellDelegate: [chain.weth.address, chain.poolManager.address],
  FeeCollector: [sink],
})[name];
// The contracts a run may deploy alone (--only): the sell delegate, whose constructor needs no other contract of the run
// (card evm-testnet-delegate-review3; evm-sell-v4's and evm-selldelegate-exact-debit's records stay under their own keys)
// The fee collector (card evm-fee-collector) is deployed alone beside a testnet's set (`beside`): its constructor takes
// only the chain's sell sender, and the testnets' sets were deployed before it existed (the mainnet sets hold it)
export const ALONE = Object.freeze({ SellDelegate: { key: "evm-testnet-delegate-review3" }, FeeCollector: { key: "evm-fee-collector", beside: true } });
// Every contract the build file pins: the chain sets' (ORDER), then those deployed only beside them
export const BUILT = Object.freeze([...ORDER, ...Object.keys(ALONE).filter((n) => !ORDER.includes(n))]);
// The kit's file whose evmPoolVenues() holds each chain's sell sender pin; it imports no other file of the kit's, so
// what it holds is what sinkOf reads
export const KIT_PIN_FILE = "packages/kit/src/trade/evm/buy-unpinned.ts";
const repoGit = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });
/** origin/main fetched and in this checkout, or a throw saying `what` could not be read (nothing is sent) */
const fetchMain = (git, what) => {
  if (git("fetch", "-q", "origin", "main").status !== 0) throw new Error(`git fetch origin main failed, so ${what} could not be read: nothing was sent; run the paste again once the fetch works`);
  if (git("rev-parse", "--verify", "-q", "origin/main").status !== 0) throw new Error(`origin/main is not in this checkout, so ${what} could not be read: nothing was sent`);
};
/**
 * The fee collector's sink on `chainName`: the sell sender the kit pins there as origin/main has it, or a throw
 * (nothing is sent). origin/main is fetched, then a checkout whose KIT_PIN_FILE differs from main's (a commit or
 * an edit not on main) is refused, so the pin in use is main's. `git` is for tests.
 */
export async function sinkOf(chainName, { git = repoGit } = {}) {
  fetchMain(git, "main's sell sender pin");
  const d = git("diff", "--quiet", "origin/main", "--", KIT_PIN_FILE).status;
  if (d === 1) throw new Error(`${KIT_PIN_FILE} in this checkout differs from origin/main's: the FeeCollector's sink is the sell sender main pins; update this checkout to main and run the paste again: nothing was sent`);
  if (d !== 0) throw new Error(`${KIT_PIN_FILE} could not be compared with origin/main's: nothing was sent`);
  const { evmPoolVenues } = await import(pathToFileURL(path.join(REPO, KIT_PIN_FILE)).href);
  const s = String(evmPoolVenues()[chainName]?.sellSender ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s) || /^0x0{40}$/.test(s)) throw new Error(`the kit pins no sell sender on ${chainName}, the FeeCollector's sink: nothing was sent`);
  return s;
}
// The folder a mainnet run writes its record, journal and lock to: the one part of the checkout mainCheckout lets
// differ from main (a completed run's record is committed in this folder right after, as the paste says)
export const RUN_OUTPUT = "contracts/pool-evm/deployments";
// Where a file git does not track could be run or read by a mainnet run
const RUN_PATHS = ["contracts/pool-evm", "packages/kit/src", "scripts/live-checks/pool-evm-deploy*"];
const list = (s) => String(s ?? "").split("\n").filter(Boolean);
const some = (files) => `${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
/**
 * A mainnet paste runs main's code (card evm-paste-fold; the review of main 63c90229 found only KIT_PIN_FILE compared):
 * origin/main is fetched, then the run is refused, with nothing sent, while this checkout has a change main lacks (a
 * tracked file edited, staged or not, or a file git does not track under RUN_PATHS) or its commit's files differ from
 * main's. RUN_OUTPUT is left out of both, so a record committed here and not yet on main passes. `git` is for tests.
 */
export function mainCheckout({ git = repoGit } = {}) {
  fetchMain(git, "main's code");
  const not = `:(exclude)${RUN_OUTPUT}`;
  const edited = git("diff", "--name-only", "HEAD", "--", ".", not);
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", ...RUN_PATHS, not);
  const behind = git("diff", "--name-only", "HEAD", "origin/main", "--", ".", not);
  if ([edited, untracked, behind].some((r) => r.status !== 0)) throw new Error("this folder could not be compared with origin/main: nothing was sent");
  const local = [...list(edited.stdout), ...list(untracked.stdout)];
  if (local.length) throw new Error(`this folder has changes main lacks (${some(local)}): the paste runs main's code only: nothing was sent; put those files back as main has them (git status lists them), then run the paste again`);
  const off = list(behind.stdout);
  if (off.length) throw new Error(`this folder is not at origin/main (files that differ: ${some(off)}): the paste runs main's code only: nothing was sent; run git pull --ff-only origin main here, then run the paste again`);
}
// forge-std, which forge build compiles for test/ (no contract in src/ imports it): a submodule pinned by commit in this
// repository's tree. A clone made without --recurse-submodules has it empty, and forge build then fails on
// lib/forge-std/src/console.sol before anything is sent (the review of main 63c90229, in the owner's folder).
export const FORGE_STD = "contracts/pool-evm/lib/forge-std";
export const FORGE_STD_FIX = `git submodule update --init ${FORGE_STD}`;
/**
 * forge-std set up at its pinned commit before forge build, or a throw (nothing is sent). When it is not set up this
 * runs FORGE_STD_FIX itself: the commit is the tree's pin, and what a run deploys is pinned apart from it
 * (pool-evm-deploy.build.json, MAINNET_INIT). At another commit, or conflicted, it is refused naming FORGE_STD_FIX, so
 * a checkout someone moved is never moved here. `git` is for tests.
 */
export function forgeStdReady({ git = repoGit, log = (l) => console.log(l) } = {}) {
  const state = () => {
    const s = git("submodule", "status", "--", FORGE_STD);
    return s.status === 0 && s.stdout ? s.stdout[0] : null;
  };
  let st = state();
  if (st === "-") {
    log(`deploy: ${FORGE_STD} is not set up: ${FORGE_STD_FIX} (its pinned commit)`);
    const u = git("submodule", "update", "--init", "--", FORGE_STD);
    if (u.status !== 0) throw new Error(`${FORGE_STD_FIX} failed (${list(u.stderr).pop() ?? `exit ${u.status}`}), and forge cannot build without it: nothing was sent; run it here once it works, then run the deploy again`);
    st = state();
  }
  if (st !== " ") throw new Error(`${FORGE_STD} is not set up at its pinned commit, so forge cannot build: nothing was sent; run ${FORGE_STD_FIX} here, then run the deploy again`);
}
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
  // card pool-evm-buy-pays-revert (a buy whose swap fails pays out): read from forge build --root contracts/pool-evm
  // (forge 1.7.1 on the Mac, 2026-11-07), where the other five read as above
  PrivacyPoolSimple: { length: 10956, keccak: "0x7e8d15c9f42c8866cf0080e49757f0a13139e85ffdffdf638b7a445d5b787e6f" },
  UniswapV4Adapter: { length: 4578, keccak: "0xedc0d3a854fc280089da75b2ed4baf8e3495fdb80eed6632ddfe5421ac96b6ef" },
  UniswapV3Adapter: { length: 2269, keccak: "0x1460db6407c61d6d70d3d423a04a46a512f5df9c00978987cd9f38a267db4f05" },
  SellDelegate: { length: 9479, keccak: "0x60ae724bd23ec2c11ee8faf40a6027b43e256e7719efe8d85646ed7079fc3132" },
  // card evm-fee-collector: read from forge build --root contracts/pool-evm (forge 1.7.1 on the Mac, 2026-11-06), where
  // the five above read as above; each mainnet set deploys it last (card evm-mainnet-senders), and its paste is refused
  // until the kit pins that mainnet's sell sender (sinkOf)
  FeeCollector: { length: 407, keccak: "0xaf9a87d9faaac0c448dabec1f6ce81371789f00eddce4f0479db5e07da5e2e2d" },
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
// The kit's EVM pool pins, read through the kit's public entry (a test passes its own).
const kitVenues = async () => (await import(pathToFileURL(path.join(REPO, "packages/kit/src/index.ts")).href)).evmPoolVenues();
export async function deployedElsewhere(chainName, { git = repoGit, venues = kitVenues } = {}) {
  const file = path.relative(REPO, deploymentFile(chainName));
  // main's record unread is its own refusal, never "deployed already"
  fetchMain(git, "main's record");
  if (git("cat-file", "-e", `origin/main:${file}`).status === 0) return `origin/main holds ${file}`;
  const pool = (await venues())[chainName]?.pool;
  return pool ? `the kit pins the ${chainName} pool ${pool}` : null;
}
/** A record's journal: the record's path with .journal.json */
export const journalOf = (out) => out.replace(/\.json$/, "") + ".journal.json";
// What one landed transaction took from the run key's balance, from its receipt; null when the receipt or the journal
// entry does not say. Its fee: gasUsed x effectiveGasPrice (an Arbitrum chain's gasUsed holds its L1 part,
// gasUsedForL1), plus an OP stack chain's l1Fee and its operator fee, whose receipt fields are left out while both are 0
// (Isthmus: gasUsed x operatorFeeScalar / 1e6 + operatorFeeConstant; from Jovian, whose receipts add
// daFootprintGasScalar: gasUsed x operatorFeeScalar x 100 + operatorFeeConstant). Its value only when it succeeded and
// went to another address (a failed one pays its fee alone; a send to itself keeps its value).
export const outflowOf = (tx, r, deployer) => {
  if (r?.gasUsed == null || r.effectiveGasPrice == null || tx.value === undefined || tx.value === null) return null;
  const gas = BigInt(r.gasUsed);
  let fee = gas * BigInt(r.effectiveGasPrice) + (r.l1Fee != null ? BigInt(r.l1Fee) : 0n);
  if (r.operatorFeeScalar != null || r.operatorFeeConstant != null) {
    const scalar = BigInt(r.operatorFeeScalar ?? 0);
    fee += (r.daFootprintGasScalar != null ? gas * scalar * 100n : (gas * scalar) / 1_000_000n) + BigInt(r.operatorFeeConstant ?? 0);
  }
  const self = String(tx.to ?? "").toLowerCase() === String(deployer).toLowerCase();
  return fee + (r.status === "0x1" && !self ? BigInt(tx.value) : 0n);
};
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
  for (const name of BUILT) {
    const a = JSON.parse(readFileSync(path.join(outDir, `${name}.sol`, `${name}.json`), "utf8"));
    const refs = a.deployedBytecode.immutableReferences ?? {};
    const immutables = Object.keys(refs).sort((x, y) => Number(x) - Number(y)).map((id) => {
      for (const r of refs[id]) if (r.length !== 32) throw new Error(`${name}: an immutable of ${r.length} bytes`);
      return refs[id].map((r) => r.start);
    });
    const r = runtimeOf(a.deployedBytecode.object, immutables);
    contracts[name] = { length: r.length, masked: r.masked, immutables };
    // a contract with a sell (SellDelegate) records the selector its build dispatches, from forge's own ABI
    const sells = Object.entries(a.methodIdentifiers ?? {}).filter(([sig]) => sig.split("(")[0] === "sell");
    if (sells.length > 1) throw new Error(`${name}: ${sells.length} sell methods`);
    if (sells.length === 1) contracts[name].sell = `0x${sells[0][1]}`;
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
// a stop during the funding wait (a funding transfer still in flight lands and is swept too); how long the cleanup
// waits, polling every safePoll, for both RPCs' "safe" block to reach the key's last transaction before it judges the
// key (a reorg of a block not yet safe could undo a sweep after the key is gone; a key not judged is kept).
export const WAITS = Object.freeze({ receipt: 180_000, stuck: 90_000, settle: 900_000, sweep: 1_800_000, lateFunding: 60_000, poll: 5_000, safe: 1_800_000, safePoll: 15_000 });
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
  const lock = lockOf(args, io);
  if (!lock) return run(args, io);
  takeLock(lock);
  try {
    return await run(args, io);
  } finally {
    rmSync(lock, { force: true });
  }
}
/** A mainnet run's lock: its journal's path with .lock (null on a testnet: no journal, no key kept) */
const lockOf = (args, io) => {
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const chainName = opt("--chain");
  if (!args.includes("--mainnet") || !Object.hasOwn(MAINNETS, chainName)) return null;
  return journalOf(opt("--out") ?? (io.recordOf ?? deploymentFile)(chainName)) + ".lock";
};
/**
 * One run per chain's journal at a time: the lock file is made O_EXCL with this process's pid. One held by a live
 * process refuses this run before anything is read or sent; one whose process is gone (a run killed outright) is taken
 * over.
 */
export function takeLock(lock) {
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST" || i > 0) throw e;
    }
    const pid = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    try {
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0), (alive = true);
    } catch (e) {
      alive = e.code === "EPERM";
    }
    if (alive) throw new Error(`${path.relative(process.cwd(), lock)}: another run on this chain (pid ${pid}) is going: nothing was read or sent; wait for it to end`);
    rmSync(lock, { force: true });
  }
}

async function run(args, io = {}) {
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
  if (only !== null && (mainnet || !(Object.hasOwn(ALONE, only) && (chain.contracts.includes(only) || ALONE[only].beside)))) throw new Error(`--only is one of ${Object.keys(ALONE).join(", ")}${mainnet ? ", on a testnet" : ""}`);
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
  } else if (!mainnet && !dryRun) {
    // a testnet run writes its record over nothing: a record already there is a deployment a card's live check and the
    // money gate read (an --only run's is its card's, ALONE), and a rerun would overwrite it with another address
    if (existsSync(out)) throw new Error(`${rel(out)} exists: ${only ?? "the pool"} is deployed on ${chainName} by that record: run its live check alone: ${liveCheck}; a new deployment is a new card's record (ALONE, or --out <a new file>): nothing was read or sent`);
  } else if (mainnet) {
    // the owner's paste runs main's code; a rehearsal on a loopback fork runs a card's branch
    if (!dryRun) (io.mainCheckout ?? mainCheckout)();
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
      // a completed run's journal with no record: the pool is deployed (by that run's key); a new run would deploy it again
      if (j.complete) throw new Error(`${rel(journalFile)}: a completed run deployed ${chainName}'s pool with the run key ${j.deployer}, but its record ${rel(out)} is missing: restore the record (git checkout ${path.relative(REPO, out)}) and run its live check: ${liveCheck}; nothing was sent`);
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
  // the RPCs every account read before a key is made goes to: the chain's two (the fork's on a dry run)
  const reads = dryRun ? [url, ...(mainnet ? [second] : [])] : chain.rpcs;
  for (const u of reads) {
    if ((await call("eth_chainId", [], u)) !== chain.chainId) throw new Error(`${u} does not answer ${chainName}'s chain id`);
    const c = await call("eth_getCode", [ret, "latest"], u);
    if (c !== "0x") throw new Error(`--return ${ret} has code on ${u} (${(c.length - 2) / 2} bytes): the rest goes only to an account with none`);
    if (mainnet && !kept && !(big(await call("eth_getBalance", [ret, "latest"], u)) > 0n)) throw new Error(`--return ${ret} holds no ETH on ${u}: pass the wallet you send the funding from`);
  }

  const startedAt = new Date().toISOString();
  let pinned, forgeVersion, sk, deployer, names, addrs, datas, gas, need, keyDir, inits, sink;
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
  // the build's code; a fee collector's also holds this run's sink (sinkOf) at its one immutable
  const isBuild = (n, code) => {
    const got = runtimeOf(code, pinned[n].immutables);
    const sinkHeld = n !== "FeeCollector" || (got.words.length === 1 && got.words[0].length === 1 && got.words[0][0] === "0x" + word(BigInt(sink)));
    return got.length === pinned[n].length && got.masked === pinned[n].masked && sinkHeld;
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
      (io.forgeStdReady ?? forgeStdReady)();
      const b = spawnSync("forge", ["build", "--root", POOL_DIR], { stdio: "inherit" });
      if (b.status !== 0) throw new Error("forge build failed");
    }
    pinned = JSON.parse(readFileSync(BUILD_FILE, "utf8")).contracts;
    const built = buildOf();
    for (const n of BUILT) if (JSON.stringify(built[n]) !== JSON.stringify(pinned[n])) throw new Error(`${n}: forge's build differs from ${path.basename(BUILD_FILE)}`);
    names = only ? [only] : chain.contracts;
    // the fee collector's sink before the run key exists: a chain whose sell sender the kit does not pin (as main has
    // it), or a pin with code on either RPC, is refused with nothing made (a mainnet paste: no key, no key folder, no
    // funding line)
    if (names.includes("FeeCollector")) {
      sink = await (io.sinkOf ?? sinkOf)(chainName);
      for (const u of reads) {
        const code = await call("eth_getCode", [sink, "latest"], u);
        if (code !== "0x") throw new Error(`the FeeCollector's sink ${sink} has code on ${u} (${(String(code).length - 2) / 2} bytes): an EIP-7702 delegation there would run inside every fee the collector forwards: nothing was sent`);
      }
      console.log(`deploy: FeeCollector's sink ${sink}, the sell sender the kit pins on ${chainName}`);
    }
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
        if (bad.length) throw new Error(`the stopped run's ${n} at ${t.address} (${t.hash}) landed, but its code does not read back as the build's${n === "FeeCollector" ? ` with the sink ${sink}` : ""} on ${bad.join(" and ")}: nothing was sent; run the same paste again once both RPCs have it, or send the key's rest back: ${sweepCommand(chainName)}`);
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
    datas = Object.fromEntries(rest.map((n) => [n, inits[n] + argsOf(n, chain, addrs, sink).map(addrArg).join("")]));
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
  // and listed: { step, hash, raw, nonce, tip, maxFee, gas, value, to, sentAt, receipt }. The record lists the ones
  // that landed. A --sweep-kept run starts from its journal's. value and to are what outflowOf counts toward the need
  // (the journal's wait_txs: how many it held at the funding wait; only the ones after it count).
  const signed = kept || resume
    ? (j0.txs ?? []).map((s) => ({ ...s, nonce: big0(s.nonce), tip: big0(s.tip), maxFee: big0(s.maxFee), gas: big0(s.gas), value: big0(s.value), receipt: null }))
    : [];
  // the journal's length at the funding wait (nothing is signed before it): what --sweep-kept counts as sent out since
  // the wait starts there. By position, not nonce: a stopped run's transaction that lands after a resume read its nonce
  // stays before it
  const waitTxs = kept ? null : signed.length;
  let stopped = null;
  let stoppedAt = null;
  let complete = false;
  // whether this run's (or, for --sweep-kept, the journaled run's) key read the need it asked for: written in the
  // journal the moment it is read, so a later --sweep-kept of a run stopped (or killed) before that watches the key for
  // WAITS.lateFunding and keeps it while the asked transfer may still land. A resume starts unfunded: its journal's
  // transactions are the stopped run's, not a reading of its own funding.
  let funded = Boolean(kept) && j0?.funded === true;
  // Every funding the key's runs asked for (each "waiting for" line's wei), journaled before its line is printed and
  // carried through every resume and --sweep-kept: the key is removed only once, on both RPCs at a block at or past
  // every receipt of its own, what it has received (its balance plus what each of its landed transactions took)
  // covers every one of them, so a transfer it asked for that is still to land never finds the key gone. A journal
  // from before the list counts its run's need as one.
  const asked = (j0?.asked ?? (j0 ? [j0.need ?? "0"] : [])).map(BigInt);
  // On a mainnet the journal (journalFile) holds the run's state, rewritten before each send and in the finally: every
  // signed transaction (its raw form is public once sent; no key), the key folder's name and state and why
  const writeJournal = () => {
    if (!journalFile) return;
    const txs = signed.map((s) => ({ step: s.step, ...(s.contract ? { contract: s.contract } : {}), ...(s.address ? { address: s.address } : {}), hash: s.hash, raw: s.raw, nonce: String(s.nonce), tip: String(s.tip), maxFee: String(s.maxFee), gas: String(s.gas), ...(s.value !== undefined ? { value: String(s.value) } : {}), to: s.to ?? null, sentAt: s.sentAt, landed: Boolean(s.receipt) || Boolean(s.landed) }));
    const j = { chain: chainName, chainId: Number(BigInt(id)), dryRun, return: ret, deployer, need: String(need ?? (j0?.need ?? "0")), at: j0?.at ?? startedAt, complete: complete || Boolean(j0?.complete), funded, wait_txs: kept ? (j0?.wait_txs ?? null) : waitTxs, asked: asked.map(String), stopped: stopped ?? (kept ? j0?.stopped : null) ?? null, stopped_at: stoppedAt ?? (kept ? j0?.stopped_at : null) ?? null, keys: journalKeys, txs };
    writeAtomic(journalFile, JSON.stringify(j, null, 2) + "\n");
  };
  const landed = () => signed.filter((s) => s.receipt).sort((a, b) => Number(a.nonce - b.nonce));
  // each nonce the key signed at which the record (out) lists none of its transactions: a completed run's journal, the
  // one other file holding every hash, is removed only when this is empty
  const unlisted = () => {
    const listed = new Set(JSON.parse(readFileSync(out, "utf8")).txs.map((t) => t.hash));
    const at = new Set(signed.filter((s) => listed.has(s.hash)).map((s) => s.nonce));
    const top = signed.reduce((m, s) => (s.nonce + 1n > m ? s.nonce + 1n : m), 0n);
    const gap = [];
    for (let n = 0n; n < top; n++) if (!at.has(n)) gap.push(n);
    return gap;
  };
  const send = async (step, t, extra = {}) => {
    const s = { step, ...extra, nonce: t.nonce, tip: t.maxPriorityFeePerGas, maxFee: t.maxFeePerGas, gas: t.gas, value: t.value ?? 0n, to: t.to ?? null, ...signTx(sk, { chainId: big(id), ...t }), sentAt: now(), receipt: null };
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
  // A transaction's receipt on each RPC (each read again while null), and what it took from the key as both say: the
  // smaller outflowOf of the two; 0n when neither RPC has it (it did not land: replaced at its nonce, or dropped); null
  // when only one has it, or either does not say. What decides a key's removal is read this way, so one RPC's wrong
  // receipt can only make it count less.
  const receiptsOf = async (s) => {
    s.receipts ??= {};
    for (const u of [url, second]) s.receipts[u] ??= await call("eth_getTransactionReceipt", [s.hash], u);
    return [s.receipts[url], s.receipts[second]];
  };
  const outOnBoth = async (s) => {
    const [a, b] = await receiptsOf(s);
    if (!a && !b) return 0n;
    const x = a && outflowOf(s, a, deployer);
    const y = b && outflowOf(s, b, deployer);
    return x == null || y == null ? null : x < y ? x : y;
  };
  // the run key's balance on both RPCs: the lower of the two (a read that fails throws)
  const heldOnBoth = async () => {
    let bal = null;
    for (const u of [url, second]) {
      const v = big(await call("eth_getBalance", [deployer, "latest"], u));
      if (bal === null || v < bal) bal = v;
    }
    return bal;
  };
  // --sweep-kept: what the key sent out since its run's funding wait (its journaled transactions from wait_txs on,
  // each counted by outflowOf, the smaller of both RPCs' receipts). Any of it unread (a receipt, or a journal from before wait_txs and value were kept)
  // counts nothing, so the key is kept.
  const sentOut = async () => {
    if (j0?.wait_txs == null) return 0n;
    let out = 0n;
    try {
      for (const [i, s] of signed.entries()) {
        if (i < j0.wait_txs) continue;
        const o = await outOnBoth(s); // 0n: replaced at its nonce, or not landed: it sent nothing
        if (o === null) return 0n;
        out += o;
      }
    } catch {
      return 0n;
    }
    return out;
  };
  const waitReceipt = async (s, ms) => {
    for (const end = now() + ms; now() < end; await sleep(2000)) if (await receiptOf(s)) return s.receipt;
    return null;
  };
  // The record: every transaction of the key that landed, in nonce order, and each contract its landed deploy made (a
  // resumed run's reused deploys included: their receipts are read first). `prev`, a record already written, keeps its
  // own run fields (--sweep-kept rewrites it with the sweeps), the fee collector's sink among them: --sweep-kept reads
  // no sink, and prev's is the one the completed run read and checked at the collector's immutable.
  const record = async (prev = null) => {
    const sinkHeld = prev ? prev.contracts?.FeeCollector?.sink : sink;
    // a receipt is read only where the nonce has none landed yet (a resume's reused deploys): a settled run reads
    // nothing here, so an RPC outage after its key is removed cannot cost it the record
    for (const s of signed) if (!signed.some((o) => o.receipt && o.nonce === s.nonce)) await receiptOf(s);
    // a deploy that reverted made nothing: only one whose receipt succeeded and made its address names a contract
    const made = landed().filter((s) => s.contract && s.step === `deploy ${s.contract}` && s.address && s.receipt.status === "0x1" && s.receipt.contractAddress?.toLowerCase() === s.address);
    const txs = landed().map((s) => ({ step: s.step, hash: s.hash, ...(s.contract ? { contract: s.contract } : {}) }));
    const d = {
      chain: chainName, chainId: Number(BigInt(id)), dryRun, at: prev?.at ?? new Date().toISOString(), deployer, return: ret, need: prev?.need ?? need.toString(),
      build: prev?.build ?? `solc 0.8.28 (contracts/pool-evm/foundry.toml), ${forgeVersion}`,
      contracts: Object.fromEntries([...chain.contracts, ...BUILT.filter((n) => !chain.contracts.includes(n))].filter((n) => made.some((s) => s.contract === n)).map((n) => [n, { address: made.find((s) => s.contract === n).address, ...(n === "FeeCollector" ? { sink: sinkHeld } : {}) }])),
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
          held0 = await heldOnBoth();
        } catch (e) {
          console.log(`deploy: the run key's balance not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
          await sleep(WAITS.poll);
        }
      }
      if (held0 >= need) console.log(`deploy: the run key ${deployer} holds ${held0} wei, at least the need ${need} wei: send nothing`);
      else {
        const short = need - held0;
        asked.push(short);
        writeJournal();
        console.log(`deploy: waiting for ${short} wei (${eth(short)}) at ${deployer} on ${chainName}${held0 > 0n ? `: the need ${need} wei less the ${held0} it holds` : ""}`);
        if (mainnet) console.log(`deploy: send exactly ${short} wei (${ethExact(short)}) to ${deployer} on ${chainName} only, from ${ret}, the address you passed, in one transfer`);
      }
      // a read that fails (its five tries all rate-limited or reset) is read again at the next poll: a run that ended
      // here would leave the owner's transfer to a run that is gone (the Solana devnet rehearsal's run, 5 Nov 18:47Z)
      for (;;) {
        go();
        let held = -1n;
        try {
          held = await heldOnBoth();
        } catch (e) {
          console.log(`deploy: the run key's balance not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
        }
        if (held >= need) break;
        await sleep(WAITS.poll);
      }
      funded = true;
      writeJournal();
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
        if (!isBuild(n, await call("eth_getCode", [addrs[n], "latest"]))) throw new Error(`${n} at ${addrs[n]}: code is not the build's${n === "FeeCollector" ? ` with the sink ${sink}` : ""}`);
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
          // less than that (nothing, or a part) and the key is kept. What the key sent out since its funding wait (an
          // earlier --sweep-kept's landed sweeps and every landed transaction's fee) came out of what it was sent, so it
          // counts toward the need: a part held and sent back is no reading of it, the rest landing later is
          const bal = await heldOnBoth().catch(() => 0n);
          const out = await sentOut();
          if (bal + out >= BigInt(j0.need ?? 0) && bal > 0n) {
            funded = true;
            writeJournal();
          }
          else console.log(`deploy: the run key holds ${bal} wei${out ? ` and sent out ${out} since its funding wait` : ""}, less than the ${j0.need} wei its run asked for: it is kept, since that transfer may still land`);
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
        // a run not whole that made a contract keeps its key and journal, in every path (the run, a resume and
        // --sweep-kept), so the same paste resumes and reuses it, never deploying it again: made is each journaled deploy
        // whose receipt on either RPC succeeded at its address, or whose address holds code on either RPC
        const whole = complete || Boolean(j0?.complete);
        const made = new Set(signed.filter((s) => s.contract && s.receipt?.status === "0x1").map((s) => s.address));
        const deploys = whole ? [] : [...new Set(signed.filter((s) => s.contract && s.step === `deploy ${s.contract}` && /^0x[0-9a-f]{40}$/.test(String(s.address))).map((s) => s.address))];
        try {
          const top = signed.reduce((m, s) => (s.nonce + 1n > m ? s.nonce + 1n : m), 0n);
          const askedAll = asked.reduce((a, b) => a + b, 0n);
          // what the key's own transactions took, from both RPCs' receipts (outOnBoth): exactly one landed per nonce
          // below top; null while any is unread on either RPC (read again on every pass, never taken as nothing sent).
          // made gains each deploy either RPC's receipt says succeeded at its address; floor is the highest block either
          // RPC puts any of them in. Read fresh: after the safe wait a reorg may have moved them.
          const ledger = async () => {
            let out = 0n;
            let floor = 0n;
            for (let n = 0n; n < top; n++) {
              const at = signed.filter((s) => s.nonce === n);
              const got = [];
              for (const s of at) {
                const rs = await receiptsOf(s);
                for (const r of rs) {
                  if (r?.blockNumber != null && big(r.blockNumber) > floor) floor = big(r.blockNumber);
                  if (r?.status === "0x1" && s.contract && r.contractAddress?.toLowerCase() === s.address) made.add(s.address);
                }
                if (rs.some(Boolean)) got.push(s);
              }
              const o = got.length === 1 ? await outOnBoth(got[0]) : null;
              out = out === null || o === null ? null : out + o;
            }
            return { out, floor };
          };
          // each RPC read at the head block it names: first its head (eth_blockNumber) and its safe block, each to be at
          // or past every receipt of the key's (floor), then the balance, the nonce and each deploy address's code, all
          // three at that head's number. The head at or past the floor puts every transaction of the key's in the state
          // read; the safe block at or past it means no reorg can undo them; a transfer that landed after the floor, safe
          // or not, is on the key at the head. Never at "latest": a load-balanced RPC answers each call from any of its
          // backends, and one still before the funding would answer an old balance there; at a number it refuses. A
          // public RPC serves a number only near its head and refuses one past it (8 Nov 03:35Z reads):
          // robinhood-rpc.publicnode.com 64 blocks back, -32602 "Archive requests require a personal token" at 100, -32000
          // "header not found" 50 ahead; rpc.mainnet.chain.robinhood.com 1100 back, "historical state ... is not
          // available" at 7000, "unsupported block number" 50 ahead. So a lagging backend refuses (the read is tried again)
          // and never answers an old state, and the old safe-block read (refused as archive, 7 Nov) is not made
          const readAt = async (u) => {
            try {
              const head = big(await call("eth_blockNumber", [], u));
              const safe = big((await call("eth_getBlockByNumber", ["safe", false], u)).number);
              const tag = "0x" + head.toString(16);
              const v = { head, safe, bal: big(await call("eth_getBalance", [deployer, tag], u)), nonce: big(await call("eth_getTransactionCount", [deployer, tag], u)), made: [] };
              for (const a of deploys) if ((await call("eth_getCode", [a, tag], u)) !== "0x") v.made.push(a);
              return v;
            } catch (e) {
              return { err: String(e.message).split("\n")[0] };
            }
          };
          let { floor } = await ledger();
          // a key kept for another reason already is judged at once; otherwise the run waits until both RPCs' safe block
          // reaches every block its transactions are in, so no reorg can undo what it reads
          if (!why.length && (whole || made.size === 0) && floor > 0n) {
            let said = false;
            for (const end = now() + WAITS.safe; now() < end; await sleep(WAITS.safePoll)) {
              const safe = [];
              for (const u of [url, second]) safe.push(await call("eth_getBlockByNumber", ["safe", false], u).then((b) => big(b.number), () => -1n));
              if (safe.every((b) => b >= floor)) break;
              if (!said) (said = true), console.log(`deploy: waiting until block ${floor}, the key's last, is safe on both RPCs (safe now ${safe.join(" and ")}), up to ${WAITS.safe / 60_000} min`);
            }
            for (const s of signed) s.receipts = {};
          }
          const { out, floor: last } = await ledger();
          floor = last;
          const left = await onBoth(readAt, (v) => !v.err && v.head >= floor && v.safe >= floor && v.bal <= DUST && v.nonce >= top);
          for (const [u, v] of left) {
            if (v.err) {
              why.push(`its rest was not read on ${u}: ${v.err}`);
              continue;
            }
            if (v.head < floor) why.push(`its head block ${v.head} on ${u} is behind block ${floor}, the last the run saw: run --sweep-kept again once that RPC has caught up`);
            if (v.safe < floor) why.push(`its safe block ${v.safe} on ${u} is behind block ${floor}, the last the run saw: run --sweep-kept again once it is safe`);
            if (v.bal > DUST) why.push(`it holds ${v.bal} wei on ${u}: run --sweep-kept to send it back`);
            if (v.nonce < top) why.push(`its nonce ${v.nonce} on ${u} is below the ${top} it signed`);
            for (const a of v.made) made.add(a);
            if (out !== null && v.bal + out + DUST < askedAll) {
              why.push(`it was asked for ${askedAll} wei in ${asked.length} transfer${asked.length === 1 ? "" : "s"} and has received ${v.bal + out} on ${u}: a transfer it asked for may still land; once it has, send it back: ${sweepCommand(chainName)}` +
                (v.bal <= DUST ? `. If an amount it asked for was never sent, nothing more will land: the key holds at most ${DUST} wei and nothing is lost` : ""));
            }
          }
          if (out === null) why.push("a transaction of its own has no receipt read yet on both RPCs, so what it received is not known");
        } catch (e) {
          why.push(`its rest was not read: ${String(e.message).split("\n")[0]}`);
        }
        if (!whole && made.size > 0) why.push(`the deploy stopped: it made ${made.size} of ${names.length || chain.contracts.length} contracts: the same paste resumes with this key and reuses them`);
        if (why.length) {
          journalKeys = { ...journalKeys, state: "kept", why };
          console.error(`deploy: the run key ${deployer} is kept in ${keyDir}: ${why.join("; ")}. The same paste resumes with it; or send its rest back with: ${sweepCommand(chainName)}`);
        } else {
          rmSync(keyDir, { recursive: true, force: true });
          journalKeys = { ...journalKeys, state: "removed", why: [] };
          console.log(`deploy: the run key ${deployer} holds at most ${DUST} wei on both RPCs: its key folder is removed`);
        }
        // the receipts the cleanup read on the first RPC join what landed(): the record, written from it below, then
        // lists a transaction whose receipt that RPC answered null at the settle (a lagging backend) but has now
        for (const s of signed) s.receipt ??= s.receipts?.[url] ?? null;
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
        // a completed run's journal ends as a completed run's does (below): once its key is removed and its record lists a
        // transaction at every nonce the key signed, the journal is removed, so nothing of the run is left beside the record
        if (j0.complete && journalKeys?.state === "removed") {
          const gap = unlisted();
          if (gap.length) console.error(`deploy: ${rel(journalFile)} is kept: ${rel(out)} lists no transaction of the key at nonce ${gap.join(", ")}, and the journal holds every hash it signed`);
          else {
            rmSync(journalFile, { force: true });
            console.log(`deploy: done: the run key is removed and ${rel(journalFile)} with it, every transaction of the key listed in ${rel(out)}. Next: ${liveCheck}`);
          }
        }
      }
    } else if (signed.length && (!mainnet || complete)) {
      // a mainnet record is written only by a completed run: it is the one-deploy guard
      await record();
      if (journalFile && complete && journalKeys?.state === "removed") {
        const gap = unlisted();
        if (gap.length) console.error(`deploy: ${rel(journalFile)} is kept: ${rel(out)} lists no transaction of the key at nonce ${gap.join(", ")}, and the journal holds every hash it signed`);
        else rmSync(journalFile, { force: true });
      }
    }
  }
  if (kept) return;
  if (!done) throw new Error("the deploy stopped; the record lists what landed");
  console.log(`deploy: done. Next: ${liveCheck}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // a closed terminal must never end the run before its sweep (the review of main 63c90229; test/paste-fold.test.mjs):
  // both streams are opened here, while the terminal is there (node opens one on its first write, and opening a gone
  // terminal hung the stop's first line on macOS), and a write that fails later (EIO on a gone tty, EPIPE on a gone
  // pipe) is dropped, never an uncaught error; the journal and the record still hold every transaction
  for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
  try {
    if (args.includes("--write-build")) {
      const file = {
        notes: [
          "Each contract's runtime as forge builds it (solc 0.8.28, contracts/pool-evm/foundry.toml): its length, the keccak256 of the runtime with every immutable's 32 bytes zeroed, and each immutable's start offsets. Written by contracts/pool-evm/script/deploy.mjs --write-build; test/deploy.test.mjs fails when forge's output differs; CI runs it after its forge test, with the forge CI installs (1.7.1). Forge 1.7.1 and 1.8.6 both build these bytes (solc 0.8.28 does the compiling): the test passed on 1.7.1 and the dry run, whose deploy.mjs refuses a build that differs, ran on 1.8.6, 2026-11-03. SellDelegate rebuilt for card evm-sell-v4 (constructor(IWETH, IPoolManager)) with forge 1.7.1, the version CI installs, on 2026-11-04, and again for card evm-selldelegate-exact-debit (W's balance of the token falls by exactly the amount) with forge 1.7.1 on 2026-11-04, and for pool review round 2 (R-3: WETH is read only for a route that can pay in it) on 2026-11-05. A contract with a sell method records its selector (`sell`, from forge's methodIdentifiers); each frozen SellDelegate records the one its deployed code dispatches (the ten-field sell's PUSH4 in eth_getCode at every frozen address on both testnets, base-sepolia-rpc.publicnode.com and robinhood-sepolia-rpc.publicnode.com, 2026-11-06).",
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
