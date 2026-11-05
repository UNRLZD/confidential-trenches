#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deploys the Blindfill pool program to Solana devnet (or a local validator, the dry run), immutable, then makes its
// SOL pool and one test deposit. Every key lives only in this run. With --mainnet (the owner's paste,
// scripts/mainnet-deploy.sh; card pool-sol-deploy-mainnet) it deploys to mainnet instead: no test deposit, and the pool
// buy's address lookup table made and frozen (step 6m).
//
//   node contracts/pool-solana/scripts/deploy.mjs --mainnet --url https://api.mainnet-beta.solana.com --ci-run <id>
//     --return <address> --out contracts/pool-solana/deployments/mainnet.json
//   node contracts/pool-solana/scripts/deploy.mjs --return <address> [--url <rpc>] [--ci-run <id> | --no-build] [--out <file>]
//     [--program <id> [--prior <sig>,...]]     a resume: the program is final already, init (if missing) and deposit only
//   node contracts/pool-solana/scripts/deploy.mjs --rebuild-record <deployment.json> [--url <rpc>]
//     rewrites a record's transactions and funders from chain reads alone: no key, no transaction
//
// Steps:
//  1. The cluster from its genesis hash: devnet, or a local validator on a loopback URL. Mainnet is refused (its
//     deploy is the owner's, on a program id of its own: M351) unless --mainnet is passed, and then only when the URL
//     is one of the live check's two mainnet RPCs and both answer mainnet's genesis hash, before any other read.
//  2. The build: cargo-build-sbf --sbf-out-dir out -- --locked (CI's command, refused when a stack frame overflows), its
//     sha256 and length printed. The keypair cargo-build-sbf writes beside the .so is deleted unread: the program id
//     is made here, fresh. Devnet takes only CI's build (--ci-run <run id>: the pool-solana job's artifact, refused
//     unless its sha256 is the one that job's log printed), so anyone can match the program to a public build; the
//     record names the run, the commit and the toolchain read from the binaries that built it. A public cluster's code
//     must also be the pinned code (scripts/pin.mjs: the "Program sha256:" line of contracts/pool-review-2.md, written
//     from a build), refused before any key otherwise; a local validator (the dry run, the tests) takes any code.
//  3. Two keys made in memory: the program's and the run's funder. The solana CLI reads keys only from files, so both
//     go to a 0700 folder under keysBase() ($XDG_STATE_HOME or ~/.local/state, /pool-sol-deploy: never OS temp, a git
//     repo or ~/.confidential-trenches), files 0600; neither is ever printed. A run refuses before making any key when
//     its journal exists (a stopped run's, whose keys may be kept). The folder is removed only once the cleanup reads
//     the funder and the program id at 0 on two RPCs with no buffer or upgradeable program of the funder's left, and
//     never after a stop before the funding was read; otherwise it is kept, its path printed with why, and the journal
//     gives the --sweep-kept command that sweeps it later, so no lamport is ever stranded behind a deleted key.
//  4. The funder's need, printed with its parts: rent of the program account (36 B) and its programdata (45 B + the
//     code), the pool (POOL_LEN), the deposit (0.01 SOL, its 17 B mark and two first page entries), the funder's own
//     rent(0) (it must stay rent-exempt between steps), and a fee bound for
//     every signature (the CLI's write chunks counted at 900 B, fewer than it writes). Then it waits until the
//     funder holds that much, and records the funding transactions.
//  5. solana program deploy --final (the upgradeable loader). --final is two transactions: the deploy, then a
//     SetAuthority to none (on devnet 3H2Vatu... then 2Wii4A6vy... 10 s later), so a stop between them leaves a program
//     the funder can upgrade; the cleanup closes it. The authority is read back.
//  6. Tag 0 init, then a 0.01 SOL deposit from the funder with a fresh note (nullifier and secret random in this run,
//     never printed or kept; the precommitment is public). The mark and both page leaves are read back and checked:
//     the label leaf against keccak256(scope, nonce) mod p, the state leaf against Poseidon(value, label,
//     precommitment).
//  7. Always, in a finally. SIGINT, SIGTERM or SIGHUP (a terminal closing) stop the run at its next step; later signals
//     never cut the cleanup short, and the handlers stay until the record is written. Every transaction this run
//     signs is written to the run's journal (the record's path with .journal.json, never the record) before its send,
//     with its state, so a send that lands after its 90 s wait, or a run killed outright, is still listed; the CLI's
//     own (buffer, writes, deploy, SetAuthority, closes) are read from the funder's history after each CLI call and
//     journaled then. A stop before the funding was read sweeps at once, watches the funder's balance for
//     WAITS.lateFunding, and sweeps again. Each sweep pass: the settle (each unsettled signature read as landed,
//     failed, or past its blockhash's last valid block height; read only, never sent again), the funder's bulk to
//     --return in one transfer (a job runner may stop the run with TERM, then KILL 10 s later), keeping
//     CLEANUP_RESERVE for the closes; then any buffer the funder still owns and a program it can still upgrade (read at
//     confirmed) are closed with their rent to --return; then the settle again and the rest is swept (retried). Every
//     sweep's signature is printed. A run that stops leaves its journal (complete: false, stopped_at, every
//     transaction's state, the keys kept or removed and why) and the record path as it was; a run that completes
//     writes the record and removes the journal.
// 6m. Mainnet only, after init and instead of the deposit (a test deposit's note is thrown away, so its SOL would stay
//     in the pool for good): the pool buy's address lookup table. Its list is the kit's solanaPoolBuyTableAccounts for
//     the pump curve venue (pump Global's fee and buyback recipients, read at finalized on both RPCs, the same bytes)
//     and the pages up to entry 2,047 of each tree, as the devnet table holds; read before any key, so its rent is in
//     the need. One transaction creates and extends it (the funder its authority and payer), it is read back at
//     finalized on both RPCs, the same bytes, active, the funder its authority and exactly the list; then a second
//     transaction freezes it (authority none, so nobody can deactivate or close it) and the read-back must show
//     authority none. A table the funder still holds authority over keeps the run's keys. Every own send on mainnet
//     carries a compute unit price (PRIORITY_MICRO_LAMPORTS), and so do the CLI's deploy transactions; the need counts
//     each at PRIORITY_CU_BOUND units. The sweeps and the closes carry none, so the cleanup's arithmetic stays exact.
//     --table (a local validator only) rehearses this step there, on a validator holding a clone of mainnet's pump
//     Global, with mainnet's need shape.
//  8. Waits for every transaction to be finalized, writes the deployment record (scripts/live-checks/pool-sol-deploy.
//     <cluster>.json) with every transaction on the programdata (the deploy and its SetAuthority) and every funder
//     (the fee payers that are not --return), and prints the live check to run next.
import "../../../scripts/net-window.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVNET_GENESIS, MAINNET_GENESIS, LOADER_V3, SYSTEM, POOL_LEN, PRE_MARK_LEN, P, MAINNET_RPCS, pda,
  RPCS as DEVNET_RPCS, account, address, b58decode, b58encode, be32, cat, hex, labelOf, le, pageAddress, poolAddress, preMarkAddress, programDataAddress, rpc,
  scopeOf,
} from "../../../scripts/live-checks/pool-sol-deploy.mjs";
import { pinRefusal, readPin } from "./pin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POOL_DIR = path.join(HERE, "..");
const REPO = path.join(POOL_DIR, "../..");
const req = createRequire(path.join(REPO, "packages/kit/package.json"));
const imp = (m) => import(pathToFileURL(req.resolve(m)).href);
const { ed25519 } = await imp("@noble/curves/ed25519.js");
const { poseidon2, poseidon3 } = await imp("poseidon-lite");

export const DEPOSIT = 10_000_000n; // 0.01 SOL, the ladder's smallest rung (M353 (3))
export const FEE_PER_SIGNATURE = 5_000n;
export const WRITE_CHUNK = 900;
export const RETRY_SIGNATURES = 100n; // the CLI writes about 1,000 bytes a transaction; fewer here counts more fees
const SO = path.join(POOL_DIR, "out/blindfill_pool_solana.so");
/** Mainnet's compute unit price, micro-lamports: on the run's own sends (init, the table's two) and the CLI's deploy
 * transactions. The need counts each such transaction at PRIORITY_CU_BOUND units (the most one may ask), so at most
 * 140,000 lamports each; what is not spent is swept back. */
export const PRIORITY_MICRO_LAMPORTS = 100_000n;
export const PRIORITY_CU_BOUND = 1_400_000n;
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** A lookup table's 56-byte meta: u32 type 1, u64 deactivation slot (u64 max while active), u64 last extended slot, u8
 * its start index, Option<Pubkey> authority (tag at 21, key at 22), u16 padding; then the addresses. */
export const TABLE_META = 56;
/** The most bytes one transaction may have on the wire (PACKET_DATA_SIZE). */
export const TX_MAX = 1232;
/** ComputeBudget's SetComputeUnitPrice. */
export const priceIx = (microLamports) => ({ program: COMPUTE_BUDGET, keys: [], data: cat(Uint8Array.of(3), le(microLamports, 8)) });
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`deploy: ${s}`);

// ---- transactions (legacy messages) ----
const cu16 = (n) => {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (!n) return out.push(b), Uint8Array.from(out);
    out.push(b | 0x80);
  }
};
/** A key: { secret, pub (bytes), id (base58) }. */
export function newKey() {
  const secret = new Uint8Array(randomBytes(32));
  const pub = ed25519.getPublicKey(secret);
  return { secret, pub, id: b58encode(pub) };
}
/** A legacy message: payer first, then signers, then writable, then read-only accounts. */
export function compileMessage(payer, ixs, blockhash) {
  const metas = new Map();
  const add = (id, signer, writable) => {
    const m = metas.get(id);
    if (m) (m.signer ||= signer), (m.writable ||= writable);
    else metas.set(id, { id, signer, writable });
  };
  add(payer, true, true);
  for (const ix of ixs) {
    for (const a of ix.keys) add(a.id, a.signer, a.writable);
    add(ix.program, false, false);
  }
  const all = [...metas.values()];
  const keys = [
    ...all.filter((m) => m.signer && m.writable), ...all.filter((m) => m.signer && !m.writable),
    ...all.filter((m) => !m.signer && m.writable), ...all.filter((m) => !m.signer && !m.writable),
  ];
  const index = new Map(keys.map((k, i) => [k.id, i]));
  const signers = keys.filter((k) => k.signer);
  const header = Uint8Array.of(signers.length, signers.filter((k) => !k.writable).length, keys.filter((k) => !k.signer && !k.writable).length);
  const body = ixs.map((ix) =>
    cat(Uint8Array.of(index.get(ix.program)), cu16(ix.keys.length), Uint8Array.from(ix.keys.map((a) => index.get(a.id))), cu16(ix.data.length), ix.data));
  return { bytes: cat(header, cu16(keys.length), ...keys.map((k) => address(k.id)), address(blockhash), cu16(ixs.length), ...body), signers: signers.map((k) => k.id) };
}
/** A signed transaction: its bytes (base64) and its signature (the payer's, base58). */
export function signTx(message, keys) {
  const sigs = message.signers.map((id) => {
    const k = keys.find((x) => x.id === id);
    if (!k) throw new Error(`no key for signer ${id}`);
    return ed25519.sign(message.bytes, k.secret);
  });
  return { base64: Buffer.from(cat(cu16(sigs.length), ...sigs, message.bytes)).toString("base64"), signature: b58encode(sigs[0]) };
}
/** The system program's Transfer: lamports from `from` (a signer) to `to`. */
export const transferIx = (from, to, lamports) => ({
  program: SYSTEM,
  keys: [{ id: from, signer: true, writable: true }, { id: to, signer: false, writable: true }],
  data: cat(le(2, 4), le(lamports, 8)),
});

/** The waits (ms): how long one send is resent and watched before it throws; how long the cleanup's settle waits for
 * the run's unsettled transactions; the balance watch after a stop during the funding wait (a funding transfer still in
 * flight lands and is swept too); the funding wait's poll. */
export const WAITS = Object.freeze({ confirm: 90_000, settle: 180_000, lateFunding: 60_000, poll: 5_000 });
const LANDED = ["confirmed", "finalized"];

/**
 * Sends a transaction and waits until it is confirmed with no error, resending while it is not. `journal.signed` is
 * called with its signature, bytes and last valid block height before the first send (the run writes it to its record
 * there), and `journal.settled` once its status is read; so a send that lands after this gives up is still known, and
 * the cleanup's settle reads it back. `wait` and `now` are the clock (a test's is virtual).
 */
export async function sendAndConfirm(fetchFn, url, ixs, payer, keys, { step = "a transaction", journal, wait = sleep, now = Date.now } = {}) {
  const { value } = await rpc(fetchFn, url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = signTx(compileMessage(payer.id, ixs, value.blockhash), keys);
  const size = Buffer.from(tx.base64, "base64").length;
  if (size > TX_MAX) throw new Error(`${step}: ${size} bytes, over ${TX_MAX}: not signed for sending`);
  journal?.signed(step, tx, value.lastValidBlockHeight);
  const until = now() + WAITS.confirm;
  const seen = (s) => {
    if (s?.err) {
      journal?.settled(tx.signature, "failed");
      throw new Error(`${tx.signature} failed: ${JSON.stringify(s.err)}`);
    }
    if (s && LANDED.includes(s.confirmationStatus)) return journal?.settled(tx.signature, "landed"), true;
    return false;
  };
  const status = async () => (await rpc(fetchFn, url, "getSignatureStatuses", [[tx.signature], { searchTransactionHistory: true }])).value[0];
  while (now() < until) {
    try {
      await rpc(fetchFn, url, "sendTransaction", [tx.base64, { encoding: "base64", preflightCommitment: "confirmed" }]);
    } catch (e) {
      // a resend of a transaction that already landed ("already been processed") is not a failure: its status says
      if (seen(await status())) return tx.signature;
      if (!/already been processed/i.test(e.message)) throw e;
    }
    for (let i = 0; i < 4; i++) {
      await wait(500);
      if (seen((await rpc(fetchFn, url, "getSignatureStatuses", [[tx.signature]])).value[0])) return tx.signature;
    }
  }
  throw new Error(`${tx.signature} not confirmed in ${WAITS.confirm / 1000} s`);
}

// ---- the solana CLI ----
function cli(args, { allowFail = false } = {}) {
  const r = spawnSync("solana", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // a CLI that did not start (not on PATH) has no output, only its spawn error
  if (r.status !== 0 && !allowFail) throw new Error(`solana ${args[0]} ${args[1]}: exit ${r.status}: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

// ---- the need ----
/** The funder's need: each part in lamports, and their sum. `rent(n)` is the cluster's rent-exempt minimum. */
export async function needOf(rent, soLen, { resume = false, poolExists = false, mainnet = false, tableLen = 0 } = {}) {
  const writes = BigInt(Math.ceil(soLen / WRITE_CHUNK));
  if (mainnet) {
    // no test deposit; the lookup table (its meta and addresses); each own or CLI deploy transaction's priority bound
    const signatures = (resume ? 0n : 2n + writes + 2n) + (poolExists ? 0n : 1n) + 2n + 1n + 2n + RETRY_SIGNATURES;
    const priced = (resume ? 0n : 2n + writes + 2n + RETRY_SIGNATURES) + (poolExists ? 0n : 1n) + 2n;
    const parts = {
      ...(resume ? {} : { program_account: await rent(36), programdata: await rent(45 + soLen) }),
      ...(poolExists ? {} : { pool: await rent(POOL_LEN) }),
      lookup_table: await rent(TABLE_META + 32 * tableLen),
      funder_floor: await rent(0),
      fees: FEE_PER_SIGNATURE * signatures,
      priority: priced * ((PRIORITY_CU_BOUND * PRIORITY_MICRO_LAMPORTS + 999_999n) / 1_000_000n),
    };
    return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0n) };
  }
  // a resume (--program) deploys nothing: no program account, programdata, buffer, writes or deploy signatures
  const deployParts = resume ? {} : { program_account: await rent(36), programdata: await rent(45 + soLen) };
  const parts = {
    ...deployParts,
    ...(poolExists ? {} : { pool: await rent(POOL_LEN) }),
    deposit: DEPOSIT,
    deposit_mark: await rent(PRE_MARK_LEN),
    deposit_pages: 2n * (await rent(16 + 72)),
    // the funder itself: a system account must keep rent(0) after each step until the sweep empties it (the dry run's
    // deposit failed "insufficient funds for rent" without it)
    funder_floor: await rent(0),
    // signatures: buffer 2, writes, deploy 2 (funder and program), init 1, deposit 1, sweep 1; buffer and program
    // close 1 each, only after a failure; and RETRY_SIGNATURES for writes the CLI re-signs on a new blockhash (the
    // dry run used all but 10 of the counted fees). Whatever is not spent is swept back.
    fees: FEE_PER_SIGNATURE * ((resume ? 0n : 2n + writes + 2n) + (poolExists ? 0n : 1n) + 1n + 1n + 2n + RETRY_SIGNATURES),
  };
  return { parts, total: Object.values(parts).reduce((a, b) => a + b, 0n) };
}

// ---- the cleanup: never strands a lamport on a run key ----
/** What the funder keeps after the first sweep: the closes' fees and its own rent(0) (890,880 on a local validator,
 * 650,240 on devnet), so it stays rent-exempt between them. */
export const CLEANUP_RESERVE = 1_000_000n;
/**
 * Runs every step, whichever one throws: settles the run's transactions still unsettled (`ops.settle`: each reads as
 * landed, failed, or its blockhash expired, so none can land after a balance read), sweeps the funder's bulk to
 * `returnTo` (less `reserve`), closes the funder's buffers and the program while the funder can still upgrade it (each
 * retried, their rent to `returnTo`), then settles again and sweeps the rest less one fee, retried. Returns { swept,
 * signatures, after, problems }. `ops` holds the chain calls (the test plants failures in them).
 */
export async function cleanup(ops, returnTo, { tries = 5, wait = sleep, reserve = CLEANUP_RESERVE } = {}) {
  const problems = [];
  const signatures = [];
  let swept = 0n;
  const settle = async () => {
    try {
      if (ops.settle && !(await ops.settle())) problems.push(`a transaction of the run is still unsettled after ${WAITS.settle / 1000} s; sweeping anyway`);
    } catch (e) {
      problems.push(`settle: ${e.message}`);
    }
  };
  // a send whose wait gave up may still land: settled first, so the bulk reads the balance after it (a stop by TERM
  // finds nothing unsettled: the step it stops at finishes its send first). Then the bulk, one try and no wait: a
  // stop's KILL may come 10 s after its TERM
  await settle();
  try {
    const bal = await ops.balance();
    if (bal > reserve + FEE_PER_SIGNATURE) {
      const amount = bal - reserve - FEE_PER_SIGNATURE;
      signatures.push(await ops.transfer(returnTo, amount));
      swept += amount;
    }
  } catch (e) {
    problems.push(`first sweep: ${e.message}`);
  }
  // buffer and program closes are retried like the sweep: a program left upgradeable by a deleted key would strand its
  // rent for good
  const retry = async (name, fn) => {
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        problems.push(`${name} try ${i + 1}: ${e.message}`);
        await wait(2000 * (i + 1));
      }
    }
  };
  await retry("buffer close", () => ops.closeBuffers());
  await retry("program close", async () => {
    if (await ops.upgradeableByFunder()) await ops.closeProgram();
  });
  for (let i = 0; i < tries; i++) {
    await settle(); // a sweep of the last pass may land late too
    try {
      const bal = await ops.balance();
      if (bal <= FEE_PER_SIGNATURE) {
        return { swept, signatures, after: bal, problems: bal > 0n ? [...problems, `${bal} lamports left: not more than one fee`] : problems };
      }
      signatures.push(await ops.transfer(returnTo, bal - FEE_PER_SIGNATURE));
      swept += bal - FEE_PER_SIGNATURE;
      return { swept, signatures, after: await ops.balance(), problems };
    } catch (e) {
      problems.push(`sweep try ${i + 1}: ${e.message}`);
      await wait(2000 * (i + 1));
    }
  }
  return { swept, signatures, after: null, problems };
}

/**
 * The chain calls of a run's cleanup and its key check. `cli` runs the solana CLI (the test plants one). The program's
 * upgrade authority is read at confirmed, and a read that fails throws: a finalized read of a deploy that landed a
 * moment ago reads nothing, and "nothing" must never be taken for "not upgradeable".
 */
export function chainOps({ fetchFn, url, second, funder, programId, keyFile, returnTo, resume = false, cli: run0 = cli, wait = sleep, now = Date.now, say = log, journal, afterCli = async () => {}, tableOf = () => null }) {
  // each CLI call's own transactions are read from the funder's history after it, and journaled
  const run = (args) => {
    try {
      return run0(args);
    } finally {
      pendingCli.push(afterCli(`the solana CLI: ${args.slice(0, 2).join(" ")}`));
    }
  };
  const pendingCli = [];
  const cliDone = async () => {
    for (const p of pendingCli.splice(0)) await p.catch((e) => say(`the CLI's transactions not read: ${e.message}`));
  };
  const common = ["--url", url, "--keypair", keyFile, "--commitment", "confirmed"];
  const pdAddr = programDataAddress(programId);
  const byFunder = async () => {
    const pd = await account(fetchFn, url, pdAddr, undefined, "confirmed");
    return !!pd && pd.owner === LOADER_V3 && pd.data[0] === 3 && pd.data[12] === 1 && b58encode(pd.data.subarray(13, 45)) === funder.id;
  };
  const balanceOn = async (u) => BigInt((await rpc(fetchFn, u, "getBalance", [funder.id, { commitment: "confirmed" }])).value);
  return {
    closeBuffers: async () => {
      let r;
      try {
        r = run(["program", "close", "--buffers", "--recipient", returnTo, "--bypass-warning", ...common]);
      } finally {
        await cliDone();
      }
      const said = `${r.stdout}${r.stderr}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      say(`buffers closed: ${said}`);
    },
    upgradeableByFunder: byFunder,
    closeProgram: async () => {
      if (resume) throw new Error("a resumed program is never closed here");
      try {
        run(["program", "close", programId, "--recipient", returnTo, "--bypass-warning", ...common]);
      } finally {
        await cliDone();
      }
      // done once the confirmed read agrees
      for (let i = 0; i < 15; i++) {
        if (!(await byFunder())) return say(`program ${programId} closed (it was not final)`);
        await wait(2000);
      }
      throw new Error(`${programId} still reads upgradeable by the funder after its close`);
    },
    balance: () => balanceOn(url),
    transfer: async (to, lamports) => sendAndConfirm(fetchFn, url, [transferIx(funder.id, to, lamports)], funder, [funder], { step: "sweep (the funder's rest back)", journal, wait, now }),
    /** Until every transaction the run signed reads as landed, failed, or expired (the confirmed block height is past
     * its blockhash's last valid one, read first, so a status read after it is final). Reads only: a transaction its
     * send gave up on is never sent again here (a deposit the RPC refused at preflight must not land after its note's
     * secret is gone). true once none is pending, false after WAITS.settle. */
    settle: async () => {
      if (!journal) return true;
      for (const end = now() + WAITS.settle; ; ) {
        const open = journal.pending();
        if (!open.length) return true;
        const height = await rpc(fetchFn, url, "getBlockHeight", [{ commitment: "confirmed" }]);
        const st = (await rpc(fetchFn, url, "getSignatureStatuses", [open.map((p) => p.signature), { searchTransactionHistory: true }])).value;
        open.forEach((p, i) => {
          const v = st[i];
          const state = v?.err ? "failed" : v && LANDED.includes(v.confirmationStatus) ? "landed" : !v && height > p.lastValid ? "expired" : null;
          if (state) journal.settled(p.signature, state), say(`settle: ${p.step} ${p.signature} ${state}${v?.err ? ` (${JSON.stringify(v.err)})` : ""}`);
        });
        if (!journal.pending().length) return true;
        if (now() >= end) return false;
        await wait(2000);
      }
    },
    /** Why the run's keys must be kept: on two RPCs, the funder's balance and the program id's lamports unless it is a
     * deployed program (executable, the upgradeable loader's: its rent is the program's own); then any buffer or
     * programdata on `url` whose authority is the funder (the 33-byte Option at offset 4 or 12 equal to Some(funder)).
     * [] when none. */
    leftovers: async () => {
      const out = [];
      for (const u of [...new Set([url, second])]) {
        const b = await balanceOn(u);
        if (b !== 0n) out.push(`the funder holds ${b} lamports on ${u}`);
        const pa = await account(fetchFn, u, programId, undefined, "confirmed");
        if (pa && BigInt(pa.lamports) > 0n && !(pa.executable && pa.owner === LOADER_V3)) out.push(`the program id ${programId} holds ${pa.lamports} lamports on ${u} and is not a deployed program`);
        // the run's lookup table (mainnet): a live authority is the funder's key, so the keys stay until it is frozen
        const t = tableOf();
        if (t) {
          const ta = await account(fetchFn, u, t, undefined, "confirmed");
          if (ta && ta.owner === ALT_PROGRAM && ta.data[21] === 1 && b58encode(ta.data.subarray(22, 54)) === funder.id) out.push(`lookup table ${t} still has the funder as its authority on ${u}`);
        }
      }
      for (const [tag, at, what] of [[1, 4, "buffer"], [3, 12, "upgradeable program's data"]]) {
        const found = await rpc(fetchFn, url, "getProgramAccounts", [LOADER_V3, {
          encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: 0, bytes: b58encode(Uint8Array.of(tag, 0, 0, 0)) } }, { memcmp: { offset: at, bytes: b58encode(cat(Uint8Array.of(1), funder.pub)) } }],
        }]);
        for (const a of found) out.push(`${what} ${a.pubkey} still has the funder as its authority`);
      }
      return out;
    },
  };
}

// ---- the pool buy's lookup table (mainnet) ----
/** The table's three instructions (the address lookup table program's bincode: u32 tag, then its fields): create at
 * `slot` (the table the PDA [authority, slot] with `bump`), extend with `list`, freeze. The authority pays. */
export function tableIxs(authority, table, slot, bump, list) {
  const keys = [{ id: table, signer: false, writable: true }, { id: authority, signer: true, writable: false }, { id: authority, signer: true, writable: true }, { id: SYSTEM, signer: false, writable: false }];
  return {
    create: { program: ALT_PROGRAM, keys, data: cat(le(0, 4), le(slot, 8), Uint8Array.of(bump)) },
    extend: { program: ALT_PROGRAM, keys, data: cat(le(2, 4), le(list.length, 8), ...list.map(address)) },
    freeze: { program: ALT_PROGRAM, keys: keys.slice(0, 2), data: le(1, 4) },
  };
}
/** What keeps `acc` from being a lookup table that is active, holds exactly `list` in order, and has `authority` (null:
 * frozen, nobody can deactivate or close it): [] when it is. */
export function tableProblems(acc, list, authority) {
  if (!acc || acc.owner !== ALT_PROGRAM) return [`not a lookup table (${acc ? `owner ${acc.owner}` : "missing"})`];
  const d = Buffer.from(acc.data);
  if (d.length < TABLE_META || (d.length - TABLE_META) % 32 !== 0) return [`${d.length} bytes, not a lookup table's`];
  const out = [];
  if (d.readUInt32LE(0) !== 1) out.push(`type ${d.readUInt32LE(0)}, not 1`);
  if (d.readBigUInt64LE(4) !== 0xffff_ffff_ffff_ffffn) out.push(`deactivated at slot ${d.readBigUInt64LE(4)}`);
  const auth = d[21] === 0 ? null : d[21] === 1 ? b58encode(d.subarray(22, 54)) : `tag ${d[21]}`;
  if (auth !== authority) out.push(`authority ${auth ?? "none"}, not ${authority ?? "none"}`);
  const got = [];
  for (let i = TABLE_META; i < d.length; i += 32) got.push(b58encode(d.subarray(i, i + 32)));
  if (got.length !== list.length || got.some((a, i) => a !== list[i])) out.push(`holds ${got.length} addresses, not exactly the list of ${list.length}`);
  return out;
}
/** The table read at finalized on each of `urls`, waiting up to 90 s: done once every read is the same bytes and
 * tableProblems is []; throws with what is wrong after. */
async function tableReadBack(fetchFn, urls, table, list, authority, { wait = sleep, now = Date.now } = {}) {
  let why = [];
  for (const until = now() + 90_000; ; await wait(2000)) {
    const reads = await Promise.all(urls.map((u) => account(fetchFn, u, table)));
    const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
    why = [...(same ? [] : [`the reads on ${urls.join(" and ")} are not the same bytes`]), ...tableProblems(reads[0], list, authority)];
    if (!why.length) return reads[0];
    if (now() > until) throw new Error(`lookup table ${table}: ${why.join("; ")}`);
  }
}

// ---- the record from chain reads ----
const LOADER_STEPS = { 0: "buffer made", 1: "buffer write", 2: "deploy with the upgradeable loader (DeployWithMaxDataLen)", 3: "upgrade", 4: "SetAuthority (--final: to none)", 5: "close" };
/**
 * A deployment record's transactions and funders from chain reads alone: its transactions plus every one on its
 * programdata (the deploy and the SetAuthority --final sends after it; immutable after, so the list ends there), each
 * read at finalized with no error, in slot order; and `funders`, every fee payer among them that is not `return_to`.
 */
export async function chainRecord(fetchFn, url, d) {
  const steps = new Map(d.txs.map((t) => [t.signature, t.step]));
  for (const h of await rpc(fetchFn, url, "getSignaturesForAddress", [d.programdata, { commitment: "finalized" }])) {
    if (h.err === null && !steps.has(h.signature)) steps.set(h.signature, null);
  }
  const rows = [];
  for (const [signature, known] of steps) {
    const t = await rpc(fetchFn, url, "getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!t || t.meta?.err !== null) throw new Error(`${signature}: ${t ? `failed: ${JSON.stringify(t.meta?.err)}` : "not found at finalized"} on ${url}`);
    const keys = t.transaction.message.accountKeys;
    const ix = t.transaction.message.instructions.find((i) => keys[i.programIdIndex] === LOADER_V3);
    const step = known ?? (ix ? `the upgradeable loader: ${LOADER_STEPS[b58decode(ix.data)[0]] ?? "another instruction"}` : "on the programdata");
    rows.push({ step, signature, slot: t.slot, payer: keys[0] });
  }
  rows.sort((a, b) => a.slot - b.slot);
  return { ...d, txs: rows.map(({ step, signature }) => ({ step, signature })), funders: [...new Set(rows.map((r) => r.payer).filter((p) => p !== d.return_to))] };
}

/** An account once a finalized read shows it (and `ready(acc)` holds), waiting up to 60 s: steps confirm at
 * "confirmed", reads are "finalized". */
async function settled(fetchFn, url, addr, ready = () => true, { wait = sleep, now = Date.now } = {}) {
  const until = now() + 60_000;
  for (;;) {
    const a = await account(fetchFn, url, addr);
    if (a && ready(a)) return a;
    if (now() > until) throw new Error(`${addr} not readable at finalized in 60 s`);
    await wait(2000);
  }
}

/** What keeps `programId` from being this build, final, on `url`: [] when it is executable, owned by the upgradeable
 * loader, its programdata the one its id derives, its upgrade authority none, and its code `so` with only zeros
 * after it. A resume (--program) reads it on two RPCs before it spends a lamport. */
export async function programProblems(fetchFn, url, programId, so) {
  const out = [];
  const pa = await account(fetchFn, url, programId);
  const pdAddr = programDataAddress(programId);
  if (!pa) return [`${programId}: no account on ${url}`];
  if (!pa.executable || pa.owner !== LOADER_V3 || pa.data.length !== 36 || pa.data[0] !== 2 || b58encode(pa.data.subarray(4, 36)) !== pdAddr) {
    out.push(`${programId} is not an executable upgradeable-loader program pointing at ${pdAddr} on ${url}`);
  }
  const pd = await account(fetchFn, url, pdAddr);
  if (!pd || pd.owner !== LOADER_V3 || pd.data.length < 45 || pd.data[0] !== 3) return [...out, `programdata ${pdAddr} missing or not the loader's on ${url}`];
  if (pd.data[12] !== 0) out.push(`upgrade authority ${b58encode(pd.data.subarray(13, 45))} is set on ${url}`);
  const code = pd.data.subarray(45);
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  if (code.length < so.length || sha(code.subarray(0, so.length)) !== sha(so) || !code.subarray(so.length).every((b) => b === 0)) {
    out.push(`the code at ${pdAddr} is not this build's (sha256 ${sha(so)}) on ${url}`);
  }
  return out;
}

/** The pool account's state: "missing", "ours" (the program's, POOL_LEN bytes, "bfpool01"), or why it is neither. */
export function poolState(acc, programId) {
  if (!acc) return "missing";
  return acc.owner === programId && acc.data.length === POOL_LEN && Buffer.from(acc.data.subarray(0, 8)).toString() === "bfpool01" ? "ours" : `not the pool (owner ${acc.owner}, ${acc.data.length} bytes)`;
}

async function waitFinalized(fetchFn, url, sigs, { wait = sleep, now = Date.now } = {}) {
  const until = now() + 120_000;
  while (now() < until) {
    const v = (await rpc(fetchFn, url, "getSignatureStatuses", [sigs, { searchTransactionHistory: true }])).value;
    if (v.every((s) => s?.confirmationStatus === "finalized" && s.err === null)) return;
    await wait(2000);
  }
  throw new Error("not every transaction finalized in 120 s");
}

/**
 * What built the code, as the record states it: the --version lines of the cargo-build-sbf that ran the build (its own
 * version, its default platform-tools and Rust) and of the solana CLI beside it (the agave release and its commit), read
 * at build time from the binaries on PATH, then the build command. Refused when either is not a version answer, so a
 * record never names a toolchain it did not read.
 */
export function buildOf(sbfVersion, cliVersion) {
  const lines = (t) => String(t ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const sbf = lines(sbfVersion), sol = lines(cliVersion);
  if (!/^cargo-build-sbf \d+\.\d+\.\d+/.test(sbf[0] ?? "") || !sbf.some((l) => /^Default platform-tools: v\d+\.\d+/.test(l)))
    throw new Error(`cargo-build-sbf --version: not a version answer: ${sbf.join(" | ").slice(0, 200)}`);
  if (!/^solana-cli \d+\.\d+\.\d+ \(src:[0-9a-f]{8}/.test(sol[0] ?? "")) throw new Error(`solana --version: not a version answer: ${sol.join(" | ").slice(0, 200)}`);
  return `${sbf.join("; ")}; ${sol[0]}; cargo-build-sbf --sbf-out-dir out -- --locked`;
}

export const CI_REPO = "UNRLZD/confidential-trenches";
export const CI_ARTIFACT = "pool-solana-so";
const ghCli = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: exit ${r.status}: ${String(r.stderr).trim().split("\n").pop()}`);
  return r.stdout;
};

/**
 * The code a public cluster deploys: CI's build, byte for byte, since a build on another host gives other bytes and
 * nobody could rebuild the program to its hash. Reads ci run <runId>'s pool-solana job (it must have passed), the
 * sha256, size, commit and toolchain its log printed, and the pool-solana-so artifact it uploaded; refused unless the
 * file's sha256 and size are the ones the log printed.
 */
export function ciCode(runId, { gh = ghCli } = {}) {
  if (!/^\d{1,20}$/.test(String(runId))) throw new Error(`--ci-run ${runId}: not a run id`);
  const view = JSON.parse(gh(["run", "view", String(runId), "-R", CI_REPO, "--json", "databaseId,workflowName,headSha,jobs"]));
  if (view.workflowName !== "ci") throw new Error(`run ${runId} is ${view.workflowName}'s, not ci's`);
  const job = (view.jobs ?? []).find((j) => j.name === "pool-solana");
  if (job?.conclusion !== "success") throw new Error(`run ${runId}'s pool-solana job is ${job ? job.conclusion || job.status : "missing"}, not a success`);
  const lines = gh(["api", `repos/${CI_REPO}/actions/jobs/${job.databaseId}/logs`]).split("\n").map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "").trimEnd());
  const said = lines.map((l) => l.match(/^pool-solana code: sha256 ([0-9a-f]{64}), (\d+) bytes, commit ([0-9a-f]{40})$/)).filter(Boolean);
  if (said.length !== 1) throw new Error(`run ${runId}'s pool-solana log states the code ${said.length} times, not once`);
  const [, sha, len, commit] = said[0];
  const tool = (re) => lines.filter((l) => l.startsWith("pool-solana toolchain: ")).map((l) => l.slice(23)).filter((l) => re.test(l)).join("\n");
  const build = buildOf(tool(/^(cargo-build-sbf|Default )/), tool(/^solana-cli /));
  const dir = mkdtempSync(path.join(tmpdir(), "pool-sol-ci-"));
  try {
    gh(["run", "download", String(runId), "-R", CI_REPO, "-n", CI_ARTIFACT, "-D", dir]);
    const so = readFileSync(path.join(dir, "blindfill_pool_solana.so"));
    const got = createHash("sha256").update(so).digest("hex");
    const listed = readFileSync(path.join(dir, "blindfill_pool_solana.so.sha256"), "utf8").trim().split(/\s+/)[0];
    if (got !== sha || listed !== sha || so.length !== Number(len))
      throw new Error(`run ${runId}'s artifact is ${so.length} bytes, sha256 ${got} (its sha256 file says ${listed}); its log says ${len} bytes, sha256 ${sha}`);
    return { so, sha, commit, run: String(runId), build: `${build}; CI run ${runId}, pool-solana job ${job.databaseId}, commit ${commit}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A record's journal: the record's path with .journal.json. */
export const journalOf = (outFile) => outFile.replace(/\.json$/, "") + ".journal.json";

/**
 * Where a run's key folder lives: $XDG_STATE_HOME/pool-sol-deploy, ~/.local/state/pool-sol-deploy by default, made
 * 0700. A kept folder must outlast the run: never OS temp (macOS's dirhelper deletes what sits there unused 3 days),
 * never inside a git repo or worktree (one stray `git add` and a key is in history), never under
 * ~/.confidential-trenches (the env and vendor keys' folder). Refused when it would be.
 */
export function keysBase(env = process.env, home = homedir()) {
  const base = path.resolve(env.XDG_STATE_HOME || path.join(home, ".local/state"), "pool-sol-deploy");
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

/**
 * --sweep-kept <journal>: a stopped run's kept keys, swept later. Loads the funder (and the program id's key, when the
 * run made one) from the journal's key folder, reads every transfer into each on chain, and sends each one's balance
 * less one fee to the funding's own source (the one sender of those transfers; --return names one when there are
 * more). Then, once both read 0 on two RPCs with nothing under the funder's authority, removes the key folder. The
 * journal gets every transaction read or sent and the keys' state.
 */
export async function sweepKept(fetchFn, url, second, file, { base = keysBase(), to = null, wait = sleep, now = Date.now, cli: run = cli } = {}) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const dir = path.join(base, String(j.keys?.folder ?? ""));
  if (!j.keys?.folder || path.basename(j.keys.folder) !== j.keys.folder || !existsSync(dir)) throw new Error(`${file}: its key folder ${j.keys?.folder} is not in ${base}`);
  const load = (name, id) => {
    const f = path.join(dir, name);
    if (!existsSync(f)) return null;
    const b = Uint8Array.from(JSON.parse(readFileSync(f, "utf8")));
    const k = { secret: b.subarray(0, 32), pub: b.subarray(32, 64), id: b58encode(b.subarray(32, 64)) };
    if (k.id !== id || b58encode(ed25519.getPublicKey(k.secret)) !== id) throw new Error(`${f} is not the key of ${id}`);
    return k;
  };
  const funder = load("funder.json", j.funder);
  if (!funder) throw new Error(`${dir} has no funder.json`);
  const holders = [funder, load("program.json", j.program_id)].filter(Boolean);
  const known = new Set(j.txs.map((t) => t.signature));
  // the transfers into a key, read on chain: [{ signature, from }]
  const incoming = async (k) => {
    const out = [];
    for (const f of (await rpc(fetchFn, url, "getSignaturesForAddress", [k.id, { commitment: "confirmed" }])).reverse()) {
      if (f.err !== null) continue;
      const t = await rpc(fetchFn, url, "getTransaction", [f.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const keys = t?.transaction.message.accountKeys ?? [];
      for (const ix of t?.transaction.message.instructions ?? []) {
        const d = b58decode(ix.data);
        if (keys[ix.programIdIndex] === SYSTEM && d.length === 12 && d[0] === 2 && keys[ix.accounts[1]] === k.id && keys[ix.accounts[0]] !== k.id) out.push({ signature: f.signature, from: keys[ix.accounts[0]] });
      }
    }
    return out;
  };
  for (const k of holders) {
    const balance = BigInt((await rpc(fetchFn, url, "getBalance", [k.id, { commitment: "confirmed" }])).value);
    const ins = await incoming(k);
    for (const i of ins) if (!known.has(i.signature)) known.add(i.signature), j.txs.push({ step: `funding (to ${k === funder ? "the funder" : "the program id"})`, signature: i.signature, state: "landed" });
    if (balance <= FEE_PER_SIGNATURE) continue;
    const sources = [...new Set(ins.map((i) => i.from))];
    const dest = to ?? (sources.length === 1 ? sources[0] : null);
    if (!dest) throw new Error(`${k.id} holds ${balance} lamports from ${sources.length} senders (${sources.join(", ") || "none read"}): pass --return <one of them>`);
    if (to && !sources.includes(to) && to !== j.return_to) throw new Error(`--return ${to} is neither a sender to ${k.id} (${sources.join(", ")}) nor the run's return address`);
    const sig = await sendAndConfirm(fetchFn, url, [transferIx(k.id, dest, balance - FEE_PER_SIGNATURE)], k, [k], { wait, now });
    j.txs.push({ step: `sweep (kept keys, to the funding's source ${dest})`, signature: sig, state: "landed" });
    log(`sweep-kept: ${balance - FEE_PER_SIGNATURE} lamports from ${k.id} to ${dest}: ${sig}`);
  }
  const ops = chainOps({ fetchFn, url, second, funder, programId: j.program_id, keyFile: path.join(dir, "funder.json"), returnTo: j.return_to, cli: run, wait, now, tableOf: () => j.table ?? null });
  const left = [];
  for (const k of holders) for (const u of [...new Set([url, second])]) {
    const b = BigInt((await rpc(fetchFn, u, "getBalance", [k.id, { commitment: "confirmed" }])).value);
    if (b !== 0n) left.push(`${k.id} holds ${b} lamports on ${u}`);
  }
  left.push(...(await ops.leftovers()));
  if (left.length) Object.assign(j.keys, { state: "kept", why: [...new Set(left)] });
  else {
    rmSync(dir, { recursive: true, force: true });
    Object.assign(j.keys, { state: "removed", why: ["swept by --sweep-kept: every key of the run reads 0 on both RPCs, nothing under the funder's authority"] });
  }
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  log(`sweep-kept: keys ${j.keys.state}${left.length ? `: ${left.join("; ")}` : ""}; wrote ${file}`);
  return j;
}

/** The deploy run. The third argument is for tests: `wait` and `now` (a virtual clock), `cli` and `gh` (planted),
 * `keysBase` (a test's own folder for the run's keys). */
export async function main(argv, fetchFn = fetch, io = {}) {
  const { wait = sleep, now = Date.now, cli: runCli = cli, gh = ghCli } = io;
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const url = opt("--url", "https://api.devnet.solana.com");
  const genesis = await rpc(fetchFn, url, "getGenesisHash", []);
  const cluster = genesis === DEVNET_GENESIS ? "devnet" : genesis === MAINNET_GENESIS ? "mainnet" : LOOPBACK.test(url) ? "localnet" : null;
  const mainnetArg = argv.includes("--mainnet");
  if (cluster === "mainnet" && !mainnetArg) throw new Error("mainnet refused: its deploy is the owner's, with a program id of its own (M351): the owner's paste passes --mainnet");
  if (mainnetArg && cluster !== "mainnet") throw new Error(`--mainnet refused: genesis ${genesis} at ${url} is not mainnet's`);
  if (!cluster) throw new Error(`genesis ${genesis} at ${url} is neither devnet nor a loopback validator`);
  const second0 = cluster === "devnet" ? DEVNET_RPCS.find((u) => u !== url) ?? DEVNET_RPCS[1] : cluster === "mainnet" ? MAINNET_RPCS[1] : url.replace("127.0.0.1", "localhost");
  if (cluster === "mainnet") {
    // the live check's two mainnet RPCs, the first (the only one of the two that answers getProgramAccounts) as --url;
    // the second must answer mainnet's genesis too, before any other read
    if (url !== MAINNET_RPCS[0]) throw new Error(`mainnet refused: --url ${url} is not ${MAINNET_RPCS[0]}`);
    const g2 = await rpc(fetchFn, second0, "getGenesisHash", []);
    if (g2 !== MAINNET_GENESIS) throw new Error(`mainnet refused: ${second0} answers genesis ${g2}, not mainnet's`);
  }
  const kept = opt("--sweep-kept");
  if (kept) return sweepKept(fetchFn, url, second0, kept, { base: io.keysBase ?? keysBase(), to: opt("--return") ? (address(opt("--return")), opt("--return")) : null, wait, now, cli: io.cli ?? cli });
  const rebuild = opt("--rebuild-record");
  if (rebuild) {
    // a record, or a stopped run's journal: its landed transactions only (not the CLI's buffer writes), written to
    // the record beside it
    let d = JSON.parse(readFileSync(rebuild, "utf8"));
    if (d.genesis_hash !== genesis) throw new Error(`${rebuild} is ${d.cluster}'s (genesis ${d.genesis_hash}), not ${url}'s`);
    const fromJournal = d.complete === false;
    if (fromJournal) {
      const { complete, stopped, stopped_at, keys, ...rest } = d;
      d = { ...rest, txs: d.txs.filter((t) => t.state === "landed" && !t.cli).map(({ step, signature }) => ({ step, signature })) };
    }
    const r = await chainRecord(fetchFn, url, d);
    const target = fromJournal ? rebuild.replace(/\.journal\.json$/, ".json") : rebuild;
    writeFileSync(target, JSON.stringify(r, null, 2) + "\n");
    log(`rebuilt ${target} from ${url}: ${r.txs.length} transactions, funders ${r.funders.join(", ")}`);
    for (const t of r.txs) log(`tx ${t.step}: ${t.signature}`);
    return r;
  }
  const returnTo = opt("--return");
  if (!returnTo) throw new Error("--return <address> is required: the funder's rest goes back there");
  address(returnTo);
  const failAfter = opt("--fail-after");
  if ((failAfter || argv.includes("--flaky") || argv.includes("--table")) && cluster !== "localnet") throw new Error("--fail-after, --flaky and --table are for the local dry run only");
  if (argv.includes("--flaky")) {
    // the dry run's planted transient failures: every third call throws as a reset connection does
    const real = fetchFn;
    let n = 0;
    fetchFn = async (u, init) => {
      if (++n % 3 === 0) throw new TypeError("fetch failed");
      return real(u, init);
    };
  }
  // a resume: the program is deployed and final already (a run that stopped after its deploy); init and deposit only
  const resumeId = opt("--program");
  if (resumeId) address(resumeId);
  const prior = (opt("--prior") ?? "").split(",").filter(Boolean);
  log(`cluster ${cluster} (genesis ${genesis}) at ${url}`);

  // the toolchain the record names: read from the binaries that build, never written by hand
  const ciRun = opt("--ci-run");
  if (cluster !== "localnet" && !ciRun) throw new Error(`${cluster} takes CI's build only: --ci-run <the ci run id whose pool-solana job built it>`);
  const ci = ciRun ? ciCode(ciRun, { gh }) : null;
  let build = ci?.build ?? "--no-build: the code was built before this run, by a toolchain this record does not name";
  if (!ci && !argv.includes("--no-build")) {
    build = buildOf(spawnSync("cargo-build-sbf", ["--version"], { encoding: "utf8" }).stdout, spawnSync("solana", ["--version"], { encoding: "utf8" }).stdout);
    const b = spawnSync("cargo-build-sbf", ["--sbf-out-dir", "out", "--", "--locked"], { cwd: POOL_DIR, encoding: "utf8" });
    const out = `${b.stdout}${b.stderr}`;
    if (b.status !== 0) throw new Error(`cargo-build-sbf: exit ${b.status}: ${out.trim().split("\n").slice(-3).join(" | ")}`);
    if (out.includes("overflows the maximum allowed frame space")) throw new Error("a stack frame overflows 4 KiB");
    log(`built with ${build}`);
  }
  rmSync(path.join(POOL_DIR, "out/blindfill_pool_solana-keypair.json"), { force: true }); // unread: the id is made below
  const so = ci ? ci.so : readFileSync(opt("--so", SO)); // the test passes its own code
  const soSha = createHash("sha256").update(so).digest("hex");
  log(`code ${so.length} bytes, sha256 ${soSha}, built by ${build}`);
  // the reviewed code only, proven by a build: a public cluster's code is the pinned code (scripts/pin.mjs), before
  // any key is made
  if (cluster !== "localnet") {
    const why = pinRefusal(soSha, io.pin ?? readPin());
    if (why) throw new Error(`${cluster} refused: ${why}`);
  }
  // mainnet: the pool buy's lookup table venue (pump Global's fee accounts), read on both RPCs before any key (step 6m)
  // --table: the same step on a local validator that holds a clone of pump Global (its rehearsal)
  const withTable = cluster === "mainnet" || argv.includes("--table");
  const kitBuy = withTable ? await import(pathToFileURL(path.join(REPO, "packages/kit/src/trade/solana/pool-buy.ts")).href) : null;
  const tableVenue = kitBuy ? await kitBuy.readSolanaPumpCurveTableVenue([url, second0].map((u) => (m, p) => rpc(fetchFn, u, m, p))) : null;
  if (tableVenue) log(`the table's venue: pump Global's fee recipient ${tableVenue.feeRecipient} and ${tableVenue.buybackFeeRecipients.length} buyback recipients, the same on ${url} and ${second0}`);

  const second = second0;
  let poolExists = false;
  if (resumeId) {
    const problems = [...(await programProblems(fetchFn, url, resumeId, so)), ...(await programProblems(fetchFn, second, resumeId, so))];
    if (problems.length) throw new Error(`--program ${resumeId} refused: ${problems.join("; ")}`);
    const ps = poolState(await account(fetchFn, url, poolAddress(resumeId).address), resumeId);
    if (ps !== "missing" && ps !== "ours") throw new Error(`--program ${resumeId} refused: its pool address holds ${ps}`);
    poolExists = ps === "ours";
    log(`resume: ${resumeId} is final with this build's code on ${url} and ${second}; its pool ${poolExists ? "exists, init skipped" : "is missing, init runs"}`);
  }

  const outFile = opt("--out", path.join(REPO, `scripts/live-checks/pool-sol-deploy.${cluster}.json`));
  // the run's journal, beside the record and never the record itself: a stopped run leaves the record as it was. One
  // that exists is a stopped run's (its keys may be kept): never written over
  const journalFile = journalOf(outFile);
  if (existsSync(journalFile)) {
    throw new Error(`${journalFile} exists: a stopped run's journal, its keys perhaps kept; sweep them with its keys.sweep command, then move it aside, before another run to ${outFile}`);
  }
  const base = io.keysBase ?? keysBase();
  mkdirSync(base, { recursive: true, mode: 0o700 });
  chmodSync(base, 0o700);
  const dir = mkdtempSync(path.join(base, "pool-sol-deploy-"));
  chmodSync(dir, 0o700);
  log(`the run's keys are in ${dir} until the cleanup reads the funder empty`);
  const program = resumeId ? { id: resumeId } : newKey();
  const funder = newKey();
  // the table's list: the kit's own, for this program's pool and its pages up to entry 2,047 of each tree
  const tableList = tableVenue
    ? [...new Set(kitBuy.solanaPoolBuyTableAccounts({ program: program.id, pool: poolAddress(program.id).address }, tableVenue, kitBuy.solanaPoolPages(program.id, 1024, 1024)))]
    : null;
  const fileOf = (k, name) => {
    const f = path.join(dir, name);
    writeFileSync(f, JSON.stringify([...k.secret, ...k.pub]), { mode: 0o600 });
    return f;
  };
  const programFile = resumeId ? null : fileOf(program, "program.json");
  // the CLI deploys from a file: the very bytes hashed above, written into the run's own folder
  const codeFile = path.join(dir, "code.so");
  writeFileSync(codeFile, so, { mode: 0o600 });
  const funderFile = fileOf(funder, "funder.json");
  const common = ["--url", url, "--keypair", funderFile, "--commitment", "confirmed"];
  // Every transaction of the run in order, { step, signature, state[, cli] }: "landed" (read confirmed with no error),
  // or one this run signed that is "sent" (not read yet), "failed" (landed with an error, its fee spent) or "expired"
  // (its blockhash is past, so it never lands); the CLI's own (cli: true) are read from the funder's history after each
  // CLI call. The journal on disk (journalFile) is rewritten at each change, a signature this run signs before its
  // send: a send that lands after its wait, or a run killed outright, still leaves it there for the settle or a rerun
  // (with --prior) to read back. It holds the record's fields as they are known (--rebuild-record takes it), and says
  // whether the keys were kept or removed, and why. The full record keeps only the landed ones, not the CLI's buffer
  // writes; the journal is removed once it is written. It names the key folder by its name only.
  const txs = [];
  const unsettled = new Map(); // signature -> { step, signature, base64, lastValid }
  const fields = {
    cluster, genesis_hash: genesis, rpc: new URL(url).host, program_id: program.id, programdata: programDataAddress(program.id), pool: poolAddress(program.id).address,
    so_len: so.length, so_sha256: soSha, build, ci_run: ci?.run ?? null, commit: ci?.commit ?? null, funder: funder.id, return_to: returnTo,
    ...(tableList ? { table: null, table_addresses: tableList } : {}),
  };
  const keys = { folder: path.basename(dir), state: "in use", why: [], sweep: `node contracts/pool-solana/scripts/deploy.mjs --sweep-kept ${path.relative(REPO, journalFile)} --url ${new URL(url).origin}${cluster === "mainnet" ? " --mainnet" : ""}` };
  let stop = null;
  let stoppedAt = null;
  const stoppedRecord = () => {
    writeFileSync(journalFile, JSON.stringify({ ...fields, at: new Date().toISOString(), complete: false, stopped: stop, stopped_at: stoppedAt, keys, txs }, null, 2) + "\n");
  };
  const journal = {
    signed(step, tx, lastValid) {
      txs.push({ step, signature: tx.signature, state: "sent" });
      unsettled.set(tx.signature, { step, signature: tx.signature, base64: tx.base64, lastValid: Number(lastValid) });
      stoppedRecord();
    },
    settled(signature, state) {
      if (!unsettled.delete(signature)) return;
      for (const t of txs) if (t.signature === signature) t.state = state;
      stoppedRecord();
    },
    pending: () => [...unsettled.values()],
  };
  // what came in to the funder, and what the CLI sent: the funder's history read on chain, each signature not yet in
  // the journal read for its fee payer (the funder: the CLI's; another: a funding)
  const history = async (cliStep) => {
    const sigs = (await rpc(fetchFn, url, "getSignaturesForAddress", [funder.id, { commitment: "confirmed" }])).reverse();
    const found = [];
    for (const f of sigs) {
      if (txs.some((t) => t.signature === f.signature)) continue;
      const t = await rpc(fetchFn, url, "getTransaction", [f.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const payer = t?.transaction.message.accountKeys[0];
      const state = f.err === null ? "landed" : "failed";
      if (payer === funder.id) found.push({ step: cliStep ?? "the funder's own (not this run's journal)", signature: f.signature, state, cli: true });
      else if (state === "landed") found.push({ step: "funding (to the funder)", signature: f.signature, state });
    }
    return found;
  };
  const afterCli = async (step) => {
    txs.push(...(await history(step)));
    stoppedRecord();
  };
  let result = null;
  // A signal stops the run at its next step (the step's send finishes first), then the cleanup runs. SIGHUP is a
  // terminal closing: the same stop. Later signals never cut the cleanup short; the handlers stay until the record is
  // written. A log line written to a terminal that is gone fails with EIO, which unhandled ends the process
  // mid-cleanup; the handlers are set here, while the terminal is there (set in the SIGHUP handler, making
  // process.stderr on the gone terminal hung the run: tried in a pty, 5 Nov). The journal keeps every signature
  // either way.
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of [process.stdout, process.stderr]) s.on("error", () => {});
  const onSignal = (sig) => {
    if (stop) return log(`${sig} again: the cleanup finishes first`);
    stop = sig ?? "a signal";
    stoppedAt = new Date().toISOString(); // the wall clock: the live check compares the funding's blockTime with it
    log(`${stop}: stopping: the cleanup runs next`);
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    const check = (step) => {
      if (stop) throw new Error(`stopped by ${stop}`);
      if (failAfter === step) throw new Error(`planted failure after ${step} (--fail-after)`);
    };
    const clock = { wait, now };
    const priced = (ixs) => (cluster === "mainnet" ? [priceIx(PRIORITY_MICRO_LAMPORTS), ...ixs] : ixs);
    const send = (step, ixs) => sendAndConfirm(fetchFn, url, priced(ixs), funder, [funder], { step, journal, ...clock });
    const ops = chainOps({ fetchFn, url, second, funder, programId: program.id, keyFile: funderFile, returnTo, resume: !!resumeId, cli: runCli, journal, afterCli, tableOf: () => fields.table ?? null, ...clock });
    // funded: the funder held the need and its funding was read; until then a stop keeps the keys (a transfer may land
    // at any time: a paste made after a terminal closed)
    let funded = false;
    stoppedRecord();
    try {
      const rent = async (n) => BigInt(await rpc(fetchFn, url, "getMinimumBalanceForRentExemption", [n]));
      const need = await needOf(rent, so.length, { resume: !!resumeId, poolExists, mainnet: withTable, tableLen: tableList?.length ?? 0 });
      Object.assign(fields, { need: String(need.total), need_parts: Object.fromEntries(Object.entries(need.parts).map(([k, v]) => [k, String(v)])) });
      log(`program id ${program.id}`);
      log(`funder ${funder.id} needs ${need.total} lamports (${Object.entries(need.parts).map(([k, v]) => `${k} ${v}`).join(", ")}); the rest is swept back to ${returnTo}`);
      log(`waiting for ${funder.id} to hold ${need.total} lamports`);
      for (;;) {
        if (stop) throw new Error(`stopped by ${stop}`);
        if ((await ops.balance()) >= need.total) break;
        await wait(WAITS.poll);
      }
      const funding = await history();
      txs.push(...funding);
      funded = true;
      stoppedRecord();
      log(`funded: ${funding.filter((t) => !t.cli).length} incoming transfer(s)`);
      check("funding");

      if (resumeId) {
        // the first run's transactions: its own (--prior: its funding and sweep), then the program's history before now
        // (the record adds the programdata's own: the deploy and its SetAuthority)
        for (const sig of prior) txs.push({ step: "first run (--prior)", signature: sig, state: "landed" });
        log(`resume: ${prior.length} prior transaction(s) kept for the record`);
      } else {
        let dep;
        try {
          dep = runCli(["program", "deploy", codeFile, "--program-id", programFile, "--upgrade-authority", funderFile, "--max-len", String(so.length),
            "--final", "--use-rpc", ...(cluster === "mainnet" ? ["--with-compute-unit-price", String(PRIORITY_MICRO_LAMPORTS)] : []), "--output", "json", ...common]);
        } finally {
          await afterCli("the solana CLI: program deploy (buffer, writes, deploy, SetAuthority)").catch((e) => log(`the CLI's transactions not read: ${e.message}`));
        }
        const out = JSON.parse(dep.stdout.slice(dep.stdout.indexOf("{")));
        if (out.programId !== program.id) throw new Error(`deployed ${out.programId}, not ${program.id}`);
        const t = txs.find((x) => x.signature === out.signature);
        if (t) Object.assign(t, { step: "deploy with the upgradeable loader, --final", cli: false });
        else txs.push({ step: "deploy with the upgradeable loader, --final", signature: out.signature, state: "landed" });
        stoppedRecord();
        await settled(fetchFn, url, programDataAddress(program.id), undefined, clock);
        // --final's SetAuthority is the CLI's second transaction: a finalized read right after the deploy can still show
        // the funder as authority (the table rehearsal on a local validator, 5 Nov), so the read is retried up to 90 s
        let problems;
        for (const until = clock.now() + 90_000; ; await clock.wait(2000)) {
          problems = await programProblems(fetchFn, url, program.id, so);
          if (!problems.length || clock.now() > until) break;
        }
        if (problems.length) throw new Error(problems.join("; "));
        log(`deployed ${program.id}, upgrade authority none, code sha256 ${soSha}`);
        check("deploy");
      }

      const pool = poolAddress(program.id);
      const sysKey = { id: SYSTEM, signer: false, writable: false };
      if (poolExists) log(`pool ${pool.address} exists: init skipped`);
      else {
        await send("init (tag 0)", [{ program: program.id, keys: [{ id: pool.address, signer: false, writable: true }, { id: funder.id, signer: true, writable: true }, sysKey], data: Uint8Array.of(0) }]);
        log(`pool ${pool.address} made`);
      }
      check("init");

      if (withTable) {
        // step 6m: the pool buy's lookup table, made, read back, frozen, read back; no test deposit
        const slot = BigInt(await rpc(fetchFn, url, "getSlot", [{ commitment: "finalized" }]));
        const t = pda([funder.pub, le(slot, 8)], ALT_PROGRAM);
        fields.table = t.address;
        stoppedRecord();
        const ix = tableIxs(funder.id, t.address, slot, t.bump, tableList);
        await send(`lookup table: create and extend with ${tableList.length} addresses`, [ix.create, ix.extend]);
        await tableReadBack(fetchFn, [url, second], t.address, tableList, funder.id, clock);
        log(`lookup table ${t.address} holds the ${tableList.length} addresses on both RPCs; freezing it`);
        check("table");
        await send("lookup table: freeze (authority none)", [ix.freeze]);
        await tableReadBack(fetchFn, [url, second], t.address, tableList, null, clock);
        log(`lookup table ${t.address} is frozen (authority none) and holds exactly the list on both RPCs at finalized`);
        stoppedRecord();
        check("freeze");
        result = { ...fields, at: new Date().toISOString() };
      } else {
      // a fresh note: its nullifier and secret live only in this block
      const before = await settled(fetchFn, url, pool.address, undefined, clock);
      const size = Buffer.from(before.data.subarray(49, 57)).readBigUInt64LE();
      const pageNo = size / 1024n;
      let precommitment;
      {
        const nullifier = BigInt("0x" + randomBytes(32).toString("hex")) % P;
        const secret = BigInt("0x" + randomBytes(32).toString("hex")) % P;
        precommitment = poseidon2([nullifier, secret]);
      }
      const pre = be32(precommitment);
      const mark = preMarkAddress(program.id, pre);
      const data = cat(Uint8Array.of(1), le(DEPOSIT, 8), pre);
      await send("deposit 0.01 SOL (tag 1)", [{
        program: program.id,
        keys: [
          { id: pool.address, signer: false, writable: true }, { id: funder.id, signer: true, writable: true },
          { id: pageAddress(program.id, 0, pageNo).address, signer: false, writable: true }, { id: pageAddress(program.id, 1, pageNo).address, signer: false, writable: true },
          { id: mark.address, signer: false, writable: true }, sysKey,
        ],
        data,
      }]);
      const mk = await settled(fetchFn, url, mark.address, undefined, clock);
      const value = Buffer.from(mk.data.subarray(0, 8)).readBigUInt64LE();
      const nonce = Buffer.from(mk.data.subarray(8, 16)).readBigUInt64LE();
      const scope = scopeOf(program.id, pool.address);
      const label = labelOf(scope, nonce);
      const commitment = be32(poseidon3([value, BigInt("0x" + hex(label)), precommitment]));
      const slot = Number((nonce - 1n) % 1024n) * 72 + 16;
      for (const [tree, want] of [[0, commitment], [1, label]]) {
        const pg = await settled(fetchFn, url, pageAddress(program.id, tree, (nonce - 1n) / 1024n).address, (a) => a.data.length >= slot + 32, clock);
        if (!Buffer.from(pg.data.subarray(slot, slot + 32)).equals(Buffer.from(want))) throw new Error(`page ${tree}'s leaf is not the deposit's`);
      }
      if (value !== DEPOSIT) throw new Error(`the mark reads value ${value}`);
      log(`deposit: mark ${mark.address} value ${value} nonce ${nonce}, precommitment ${hex(pre)}; both leaves match`);
      Object.assign(fields, { scope: hex(scope), deposit: { value: String(value), nonce: String(nonce), precommitment: hex(pre), label: hex(label), commitment: hex(commitment) } });
      stoppedRecord();
      check("deposit");
      result = { ...fields, at: new Date().toISOString() };
      }
    } finally {
      // stopped (or failed) before the funding was read: sweep what is there at once (a KILL may follow a TERM in
      // 10 s), watch the balance WAITS.lateFunding for a transfer in flight, then sweep again; the keys are kept either
      // way, since a transfer can still land after any watch (the journal gives the command that sweeps it later)
      const passes = [];
      if (!funded) {
        passes.push(await cleanup(ops, returnTo, { wait }));
        log(`stopped before the funding was read; watching ${funder.id}'s balance for ${WAITS.lateFunding / 1000} s, then sweeping again`);
        let seen = -1n;
        for (const end = now() + WAITS.lateFunding; now() < end; await wait(WAITS.poll)) {
          const b = await ops.balance().catch(() => seen);
          if (b !== seen) log(`the funder holds ${(seen = b)} lamports`);
        }
      }
      passes.push(await cleanup(ops, returnTo, { wait }));
      const c = passes.at(-1);
      const swept = passes.reduce((a, p) => a + p.swept, 0n);
      const sigs = passes.flatMap((p) => p.signatures);
      for (const p of passes.flatMap((x) => x.problems)) log(`cleanup: ${p}`);
      if (!funded) txs.unshift(...(await history().catch((e) => (log(`funding read failed: ${e.message}`), []))).filter((t) => !t.cli));
      log(sigs.length ? `swept ${swept} lamports to ${returnTo}: ${sigs.join(", ")}; the funder holds ${c.after ?? "an unread balance"}` : `no sweep sent; the funder holds ${c.after ?? "an unread balance"}`);
      // the keys go only once the funder and the program id read empty on both RPCs with nothing left under the
      // funder's authority, and never after a stop before the funding was read
      let left;
      try {
        left = [...(funded ? [] : ["the run stopped before its funding was read: a transfer can still land on the funder"]),
          ...(c.after === 0n ? [] : [`the cleanup left the funder at ${c.after ?? "an unread balance"}`]), ...(await ops.leftovers())];
      } catch (e) {
        left = [`the check for what is left failed: ${String(e.message).split("\n")[0]}`];
      }
      if (left.length) {
        Object.assign(keys, { state: "kept", why: left });
        log(`KEYS KEPT in ${dir} (0700; funder.json${programFile ? ", program.json" : ""}): ${left.join("; ")}; sweep them later with: ${keys.sweep}`);
      } else {
        rmSync(dir, { recursive: true, force: true });
        Object.assign(keys, { state: existsSync(dir) ? "kept" : "removed", why: existsSync(dir) ? ["the folder could not be removed"] : ["the funder and the program id read 0 on both RPCs, nothing under the funder's authority"] });
        log(`keys removed (${existsSync(dir) ? "STILL THERE" : "gone"})`);
      }
      if (result) Object.assign(result, { funder_after: String(c.after), swept: String(swept) });
      if (left.length) result = null;
      stoppedRecord(); // removed below once the full record is written
      if (!result) log(`wrote ${journalFile} (complete: false): every transaction of the run with its state, and the keys ${keys.state}; ${outFile} is unchanged`);
    }
    if (!result) throw new Error(`the run did not complete; its journal is ${journalFile} (keys ${keys.state})`);
    // one line per landed transaction this run made or read (not the CLI's buffer writes): a --prior signature may
    // also be on the programdata
    const seen = new Set();
    result.txs = txs.filter((t) => t.state === "landed" && !t.cli && !seen.has(t.signature) && seen.add(t.signature)).map(({ step, signature }) => ({ step, signature }));
    await waitFinalized(fetchFn, url, result.txs.map((t) => t.signature), clock);
    result = await chainRecord(fetchFn, url, result);
    writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
    rmSync(journalFile, { force: true });
    log(`every transaction finalized; wrote ${path.relative(process.cwd(), outFile)} and removed its journal`);
    for (const t of result.txs) log(`tx ${t.step}: ${t.signature}`);
    const rpcArg = cluster === "localnet" ? ` --rpc ${url},${url.replace("127.0.0.1", "localhost")} --deployment ${path.relative(process.cwd(), outFile)}` : cluster === "mainnet" ? ` --deployment ${path.relative(process.cwd(), outFile)}` : "";
    log(`next: node scripts/live-checks/pool-sol-deploy.mjs${rpcArg}${cluster === "devnet" ? " --record /tmp/pool-sol-deploy.devnet-answers.json --write-record" : ""}`);
    return result;
  } finally {
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      console.error(`deploy: ERROR: ${String(e.message).split("\n")[0]}`);
      process.exit(1);
    },
  );
}
