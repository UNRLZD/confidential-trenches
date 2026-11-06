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
//  5. solana program deploy (the upgradeable loader), then the run's own SetAuthority to none: two transactions (on
//     devnet 3H2Vatu... then 2Wii4A6vy... 10 s later, when the CLI's --final sent both), so a stop between them leaves
//     a program the funder can upgrade; the cleanup closes it. The SetAuthority is the script's send, priced, journaled
//     before it is sent and sent again for 90 s, tried up to AUTHORITY_TRIES times, none of them a deploy try: the
//     CLI's --final and set-upgrade-authority send it with no compute unit price (agave v4.4.0 cli/src/program.rs
//     1496-1508). The authority is read back. The writes go to the leaders (no --use-rpc), re-signed up to
//     DEPLOY_SIGN_ATTEMPTS times, into the run's own --buffer; a failed try is tried again from that buffer up to
//     DEPLOY_TRIES times (only the chunks that differ are written again), each only while the funder holds one more
//     try's bound and the rest of the run, before the cleanup.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVNET_GENESIS, MAINNET_GENESIS, LOADER_V3, SYSTEM, POOL_LEN, PRE_MARK_LEN, P, MAINNET_RPCS, pda,
  RPCS as DEVNET_RPCS, account, address, b58decode, b58encode, be32, cat, hex, labelOf, le, pageAddress, plainTransfer, poolAddress, preMarkAddress, programDataAddress, rpc,
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
// The CLI's deploy (paste 1, 5 Nov 18:01-18:16Z: its writes sent over api.mainnet-beta with --use-rpc failed "Max
// retries exceeded" after 36 of about 80, with the RPC answering 429). Solana's deploy guide (solana-com
// apps/docs/content/docs/en/programs/deploying.mdx, "Deployment Flags", at ab8988e) says --use-rpc "requires a
// stake-weighted RPC connection", which a public RPC is not: the writes go to the leaders' TPUs (the CLI's default,
// QUIC), and the RPC carries only the blockhash and status reads. --max-sign-attempts re-signs what is unconfirmed when
// its blockhash expires, about 60 s each (agave v4.4.0 cli/src/program.rs: default 5; the guide's example 10). A try
// that still fails is tried again from the run's own buffer (--buffer: agave writes only the chunks whose bytes differ,
// program.rs do_process_program_deploy), at most DEPLOY_TRIES times, before the cleanup closes it. Ten attempts a try
// and six tries, each a new CLI process, rather than thirty in one: v4.4.0 picks its leaders from one slotsUpdates
// websocket that never reconnects (tpu-client-next websocket_node_address_service.rs), so a dead socket costs one
// short try, not the whole run (review a763a51d).
export const DEPLOY_SIGN_ATTEMPTS = 10;
export const DEPLOY_TRIES = 6;
/** The SetAuthority to none's tries, each sent again for WAITS.confirm (a congested mainnet can drop one). */
export const AUTHORITY_TRIES = 6;
export const PRIORITY_CU_BOUND = 1_400_000n;
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** The most one priced transaction's compute unit price can cost, lamports. */
const PRIORITY_PER_TX = (PRIORITY_CU_BOUND * PRIORITY_MICRO_LAMPORTS + 999_999n) / 1_000_000n;
/** A lookup table's 56-byte meta: u32 type 1, u64 deactivation slot (u64 max while active), u64 last extended slot, u8
 * its start index, Option<Pubkey> authority (tag at 21, key at 22), u16 padding; then the addresses. */
export const TABLE_META = 56;
/** The most bytes one transaction may have on the wire (PACKET_DATA_SIZE). */
export const TX_MAX = 1232;
/** ComputeBudget's SetComputeUnitPrice. */
export const priceIx = (microLamports) => ({ program: COMPUTE_BUDGET, keys: [], data: cat(Uint8Array.of(3), le(microLamports, 8)) });
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Lamports as SOL, exact (1 SOL = 1e9 lamports), trailing zeros dropped: 449137520n is "0.44913752". */
export const solOf = (lamports) => {
  const s = BigInt(lamports).toString().padStart(10, "0");
  return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, "");
};
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
/** The run's floor ({ slot }): the highest slot one of its transactions landed in, as a status or history read gave it.
 * Every read of what the run holds or left asks minContextSlot at it (chainOps), so a node behind the run's own last
 * write (paste 2, 6 Nov: the SetAuthority to none landed, a getProgramAccounts still listed the old authority and the
 * keys were kept) never answers one. */
const raise = (floor, slot) => {
  if (floor && Number.isSafeInteger(slot) && slot > floor.slot) floor.slot = slot;
};
/** How long a read held to the floor waits for a node behind it: LAG_TRIES reads LAG_MS apart (about Solana's 32-slot
 * finality depth, as the wallet's SOL_LAG_SLOTS), then it is thrown transient for the caller's own read-again. */
const LAG_TRIES = 32;
const LAG_MS = 400;

/**
 * Sends a transaction and waits until it is confirmed with no error, resending while it is not. `journal.signed` is
 * called with its signature, bytes and last valid block height before the first send (the run writes it to its record
 * there), and `journal.settled` once its status is read; so a send that lands after this gives up is still known, and
 * the cleanup's settle reads it back. `wait` and `now` are the clock (a test's is virtual).
 */
export async function sendAndConfirm(fetchFn, url, ixs, payer, keys, { step = "a transaction", journal, wait = sleep, now = Date.now, floor } = {}) {
  // a read that fails past rpc()'s five tries (rate-limited or reset) is read again: a run that ended on one after its
  // funding would cost the owner one more paste. A JSON-RPC error answer is the node's word and ends the step
  const call = (method, params) => rpc(fetchFn, url, method, params, wait);
  const { value } = await readAgain(() => call("getLatestBlockhash", [{ commitment: "confirmed" }]), `${step}: the blockhash`, { wait, now });
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
    if (s && LANDED.includes(s.confirmationStatus)) return raise(floor, s.slot), journal?.settled(tx.signature, "landed"), true;
    return false;
  };
  // a status read that fails past its tries is "not seen yet", read again until the deadline
  const status = async (history) => {
    try {
      return (await call("getSignatureStatuses", [[tx.signature], ...(history ? [{ searchTransactionHistory: true }] : [])])).value[0];
    } catch (e) {
      if (!e.transient) throw e;
      return null;
    }
  };
  let lastSend = null;
  while (now() < until) {
    try {
      await call("sendTransaction", [tx.base64, { encoding: "base64", preflightCommitment: "confirmed" }]);
    } catch (e) {
      // a resend of a transaction that already landed ("already been processed") is not a failure: its status says;
      // a send that failed past its tries, or that a load-balanced RPC's node answered "Blockhash not found" (-32002:
      // that node is behind the one the blockhash came from) or "node is behind" (-32005), is sent again at the next
      // pass: the same bytes, the same signature, so it lands at most once
      if (seen(await status(true))) return tx.signature;
      lastSend = e.message;
      if (!e.transient && !/already been processed|Blockhash not found|"code":-32005/i.test(e.message)) throw e;
    }
    for (let i = 0; i < 4; i++) {
      await wait(500);
      if (seen(await status(false))) return tx.signature;
    }
  }
  throw new Error(`${tx.signature} not confirmed in ${WAITS.confirm / 1000} s${lastSend ? ` (the last send's answer: ${lastSend})` : ""}`);
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
  const gaveUp = [];
  const retry = async (name, fn) => {
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        problems.push(`${name} try ${i + 1}: ${e.message}`);
        await wait(2000 * (i + 1));
      }
    }
    gaveUp.push(name);
  };
  await retry("buffer close", () => ops.closeBuffers());
  await retry("program close", async () => {
    if (await ops.upgradeableByFunder()) await ops.closeProgram();
  });
  // the run's lookup table, still live under the funder (a run stopped between its make and its freeze): frozen with
  // the list it was made with, never left with an authority whose key is deleted
  if (ops.freezeTable) await retry("table freeze", () => ops.freezeTable());
  // a step given up on, or anything leftovers() still reads under the funder (a buffer, an upgradeable program, a live
  // table, a program id holding lamports) or a read of it that fails, keeps the reserve in the funder: the keys are
  // kept, and --sweep-kept pays its fees from it later. The funder's own balance is what the sweep is for
  const why = gaveUp.map((n) => `${n} gave up after ${tries} tries`);
  if (!why.length && ops.leftovers) {
    try {
      why.push(...(await ops.leftovers()).filter((l) => !l.startsWith("the funder holds ")));
    } catch (e) {
      why.push(`what is left not read: ${e.message}`);
    }
  }
  const keep = why.length ? reserve : 0n;
  if (keep) problems.push(`kept ${keep} lamports in the funder for --sweep-kept: ${why.join("; ")}`);
  for (let i = 0; i < tries; i++) {
    await settle(); // a sweep of the last pass may land late too
    try {
      const bal = await ops.balance();
      if (bal <= FEE_PER_SIGNATURE + keep) {
        return { swept, signatures, after: bal, problems: bal > keep ? [...problems, `${bal - keep} lamports left: not more than one fee`] : problems };
      }
      signatures.push(await ops.transfer(returnTo, bal - FEE_PER_SIGNATURE - keep));
      swept += bal - FEE_PER_SIGNATURE - keep;
      return { swept, signatures, after: await ops.balance(), problems };
    } catch (e) {
      problems.push(`sweep try ${i + 1}: ${e.message}`);
      await wait(2000 * (i + 1));
    }
  }
  return { swept, signatures, after: null, problems };
}

/** getProgramAccounts' config for the upgradeable loader's accounts of `tag` (1 a buffer, 3 a programdata) whose
 * authority (the 33-byte Option at offset `at`) is Some(funder): no data, only their addresses. */
const byAuthority = (funder, tag, at) => ({
  encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 },
  filters: [{ memcmp: { offset: 0, bytes: b58encode(Uint8Array.of(tag, 0, 0, 0)) } }, { memcmp: { offset: at, bytes: b58encode(cat(Uint8Array.of(1), funder.pub)) } }],
});

/**
 * The chain calls of a run's cleanup and its key check. `cli` runs the solana CLI (the test plants one). The program's
 * upgrade authority is read at confirmed, and a read that fails throws: a finalized read of a deploy that landed a
 * moment ago reads nothing, and "nothing" must never be taken for "not upgradeable".
 */
export function chainOps({ fetchFn, url, second, funder, programId, buffer = null, keyFile, returnTo, resume = false, cli: run0 = cli, wait = sleep, now = Date.now, say = log, journal, afterCli = async () => {}, tableOf = () => null, priced = (ixs) => ixs, floor = { slot: 0 } }) {
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
  // every read here is at confirmed and held to `min` (the floor unless more is asked): with minContextSlot, and an
  // answer whose context slot is below it (a node that ignores the field) or -32016 (one that keeps it) is read again;
  // a getProgramAccounts is asked withContext then and gives its list. [answer, its context slot]
  const read = async (u, method, first, config = {}, min = floor.slot) => {
    const cfg = { ...config, commitment: "confirmed", ...(min > 0 ? { minContextSlot: min, ...(method === "getProgramAccounts" ? { withContext: true } : {}) } : {}) };
    for (let n = 1; ; n++) {
      let why;
      try {
        const r = await rpc(fetchFn, u, method, [first, cfg], wait);
        if (min <= 0) return [r, 0];
        const at = r?.context?.slot;
        if (Number.isSafeInteger(at) && at >= min) return [method === "getProgramAccounts" ? r.value : r, at];
        why = `answered at slot ${at}`;
      } catch (e) {
        if (!/"code":-32016\b/.test(e.message)) throw e;
        why = "its node has not reached it (-32016)";
      }
      if (n >= LAG_TRIES) throw Object.assign(new Error(`${method} on ${u}: ${why}, below slot ${min}, the run's last landed transaction`), { transient: true });
      await wait(LAG_MS);
    }
  };
  const accountAt = async (u, addr, min) => {
    const [r, at] = await read(u, "getAccountInfo", addr, { encoding: "base64" }, min);
    const v = r?.value;
    return [v ? { owner: v.owner, executable: v.executable, lamports: v.lamports, data: new Uint8Array(Buffer.from(v.data[0], "base64")) } : null, at];
  };
  const byFunder = async () => {
    const [pd] = await accountAt(url, pdAddr);
    return !!pd && pd.owner === LOADER_V3 && pd.data[0] === 3 && pd.data[12] === 1 && b58encode(pd.data.subarray(13, 45)) === funder.id;
  };
  const balanceAt = async (u, id) => BigInt((await read(u, "getBalance", id))[0].value);
  const balanceOn = (u) => balanceAt(u, funder.id);
  // the upgradeable loader's accounts of `tag` whose authority (at `at`) is Some(funder) on --url: each one listed is
  // read again by its own address at or past the list's slot, and only one whose own bytes still name the funder is
  // left (a list can lag the accounts it lists: paste 2's getProgramAccounts named the programdata while its own read
  // gave authority none). The run's own (its buffer, its programdata) are read by their own addresses at the floor
  // too, listed or not: a list that lags can also leave out a buffer made seconds before (a stop right after the CLI
  // made it), and keys removed then would lock its rent for good
  const named = (acc, tag, at) => !!acc && acc.owner === LOADER_V3 && acc.data[0] === tag && acc.data[at] === 1 && b58encode(acc.data.subarray(at + 1, at + 33)) === funder.id;
  const ownOf = { 1: buffer ? [buffer] : [], 3: [pdAddr] };
  const underFunder = async (tag, at) => {
    const [found, slot] = await read(url, "getProgramAccounts", LOADER_V3, byAuthority(funder, tag, at));
    const left = [];
    for (const a of found) {
      const [acc] = await accountAt(url, a.pubkey, Math.max(floor.slot, slot));
      if (named(acc, tag, at)) left.push(a.pubkey);
    }
    for (const a of ownOf[tag]) {
      if (left.includes(a)) continue;
      const [acc] = await accountAt(url, a);
      if (named(acc, tag, at)) left.push(a);
    }
    return left;
  };
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
      // agave v4.4.0 prints "Failed to close buffer ..." and still exits 0 (cli/src/program.rs, the --buffers loop): the
      // close is done only once --url reads no buffer under the funder, read again for about 30 s. --url only, as
      // leftovers() reads it: mainnet's second RPC (PublicNode) refuses getProgramAccounts (403 -32602 "Indexed
      // requests require a personal token"), and --url is the one the run checks answers it
      let left = [];
      for (let i = 0; i < 15; i++) {
        left = (await underFunder(1, 4)).map((a) => `${a} on ${url}`);
        if (!left.length) return;
        await wait(2000);
      }
      throw new Error(`buffer ${left.join(", ")} still has the funder as its authority after its close (the CLI said: ${said})`);
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
    /** The run's lookup table frozen (authority none) when it reads active with the funder as its authority, the
     * freeze priced as the run's own sends; done once a confirmed read shows no authority. Its signature, or null when
     * there was nothing to freeze. */
    freezeTable: async () => {
      const t = tableOf();
      if (!t) return null;
      const live = async () => {
        const [a] = await accountAt(url, t);
        return !!a && a.owner === ALT_PROGRAM && a.data.length >= TABLE_META && Buffer.from(a.data).readBigUInt64LE(4) === 0xffff_ffff_ffff_ffffn && a.data[21] === 1 && b58encode(a.data.subarray(22, 54)) === funder.id;
      };
      if (!(await live())) return null;
      const sig = await sendAndConfirm(fetchFn, url, priced([tableIxs(funder.id, t, 0n, 0, []).freeze]), funder, [funder], { step: "lookup table: freeze (authority none), in the cleanup", journal, wait, now, floor });
      for (let i = 0; i < 15 && (await live()); i++) await wait(2000);
      if (await live()) throw new Error(`lookup table ${t} still has the funder as its authority after its freeze ${sig}`);
      say(`lookup table ${t} frozen (authority none): ${sig}`);
      return sig;
    },
    balance: () => balanceOn(url),
    balanceAt,
    floor,
    transfer: async (to, lamports) => sendAndConfirm(fetchFn, url, [transferIx(funder.id, to, lamports)], funder, [funder], { step: "sweep (the funder's rest back)", journal, wait, now, floor }),
    /** Until every transaction the run signed reads as landed, failed, or expired (the confirmed block height is past
     * its blockhash's last valid one, read first, so a status read after it is final). Reads only: a transaction its
     * send gave up on is never sent again here (a deposit the RPC refused at preflight must not land after its note's
     * secret is gone). true once none is pending, false after WAITS.settle. */
    settle: async () => {
      if (!journal) return true;
      for (const end = now() + WAITS.settle; ; ) {
        const open = journal.pending();
        if (!open.length) return true;
        // reads that fail past rpc()'s tries are read again: a settle given up lets a close race a send still in flight
        const height = await readAgain(() => rpc(fetchFn, url, "getBlockHeight", [{ commitment: "confirmed" }], wait), "the block height", { wait, now });
        const st = (await readAgain(() => rpc(fetchFn, url, "getSignatureStatuses", [open.map((p) => p.signature), { searchTransactionHistory: true }], wait), "the run's statuses", { wait, now })).value;
        open.forEach((p, i) => {
          const v = st[i];
          const state = v?.err ? "failed" : v && LANDED.includes(v.confirmationStatus) ? "landed" : !v && height > p.lastValid ? "expired" : null;
          if (state === "landed") raise(floor, v.slot);
          if (state) journal.settled(p.signature, state), say(`settle: ${p.step} ${p.signature} ${state}${v?.err ? ` (${JSON.stringify(v.err)})` : ""}`);
        });
        if (!journal.pending().length) return true;
        if (now() >= end) return false;
        await wait(2000);
      }
    },
    /** Why the run's keys must be kept: on two RPCs, the funder's balance and the program id's lamports unless it is a
     * deployed program (executable, the upgradeable loader's: its rent is the program's own); then any buffer or
     * programdata on `url` whose authority is the funder (the 33-byte Option at offset 4 or 12 equal to Some(funder)),
     * as its own read gives it: each one listed, and the run's own buffer and programdata by their own addresses,
     * listed or not. Every read held to the run's floor (minContextSlot). [] when none. */
    leftovers: () => readAgain(async () => {
      // read again whole while a read fails past rpc()'s tries: one rate-limited read must never keep a finished run's
      // keys
      const out = [];
      for (const u of [...new Set([url, second])]) {
        const b = await balanceOn(u);
        if (b !== 0n) out.push(`the funder holds ${b} lamports on ${u}`);
        const [pa] = await accountAt(u, programId);
        if (pa && BigInt(pa.lamports) > 0n && !(pa.executable && pa.owner === LOADER_V3)) out.push(`the program id ${programId} holds ${pa.lamports} lamports on ${u} and is not a deployed program`);
        // the run's lookup table (mainnet): a live authority is the funder's key, so the keys stay until it is frozen
        const t = tableOf();
        if (t) {
          const [ta] = await accountAt(u, t);
          if (ta && ta.owner === ALT_PROGRAM && ta.data[21] === 1 && b58encode(ta.data.subarray(22, 54)) === funder.id) out.push(`lookup table ${t} still has the funder as its authority on ${u}`);
        }
      }
      for (const [tag, at, what] of [[1, 4, "buffer"], [3, 12, "upgradeable program's data"]]) {
        for (const a of await underFunder(tag, at)) out.push(`${what} ${a} still has the funder as its authority`);
      }
      return out;
    }, "what the run left", { wait, now }),
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
    let reads;
    try {
      reads = await Promise.all(urls.map((u) => account(fetchFn, u, table)));
    } catch (e) {
      // a read that fails (its tries all rate-limited) is read again, until the deadline
      if (!e.transient) throw e;
      why = [`not read: ${e.message}`];
      if (now() > until) throw new Error(`lookup table ${table}: ${why.join("; ")}`);
      continue;
    }
    const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
    why = [...(same ? [] : [`the reads on ${urls.join(" and ")} are not the same bytes`]), ...tableProblems(reads[0], list, authority)];
    if (!why.length) return reads[0];
    if (now() > until) throw new Error(`lookup table ${table}: ${why.join("; ")}`);
  }
}

// ---- the record from chain reads ----
const LOADER_STEPS = { 0: "buffer made", 1: "buffer write", 2: "deploy with the upgradeable loader (DeployWithMaxDataLen)", 3: "upgrade", 4: "SetAuthority (to none)", 5: "close" };
/**
 * A deployment record's transactions and funders from chain reads alone: its transactions plus each of the run's own
 * on its programdata (the deploy and the SetAuthority to none after it; immutable after, so the list ends there). The
 * run's own keys are read from the transactions, never from a step's label or an older record's funders: its funder,
 * and a payer that signed as the authority, at the instruction's fixed authority position, of a loader instruction on
 * this programdata (deploy, upgrade, SetAuthority, close) or a lookup-table instruction on the record's table. Only
 * the upgrade or table authority lands those, and that is only ever a run key; both the record's transactions and the
 * programdata's history are read for them (a --prior-only resume finds the first run's key there). A run key's
 * transactions are kept, and another payer's only as a funding: one plain System Transfer from its payer into a run key
 * (a compute budget instruction beside it allowed). Anything else (a relayer's, a CPI, TransferWithSeed, a transaction
 * that only names the funder or the programdata) is left out, said through `say`, and its payer is never the run's.
 * Each read at finalized with no error, in slot order; and `funders`, every fee payer among them that is not
 * `return_to`.
 */
export async function chainRecord(fetchFn, url, d, { wait, say = () => {} } = {}) {
  const steps = new Map(d.txs.map((t) => [t.signature, t.step]));
  const history = [];
  for (const h of await rpc(fetchFn, url, "getSignaturesForAddress", [d.programdata, { commitment: "finalized" }], wait)) {
    if (h.err === null && !steps.has(h.signature)) history.push(h.signature);
  }
  const read = async (signature) => {
    const t = await rpc(fetchFn, url, "getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], wait);
    // not found yet: a load-balanced RPC's transaction server can be a slot behind its status reads (read again)
    if (!t) throw Object.assign(new Error(`${signature}: not found at finalized on ${url}`), { transient: true });
    if (t.meta?.err !== null) throw new Error(`${signature}: failed: ${JSON.stringify(t.meta?.err)} on ${url}`);
    return t;
  };
  const keysOf = (t) => t.transaction.message.accountKeys;
  const plainTo = plainTransferTo;
  // the payer signed as the authority of this programdata or the record's table: a loader instruction (u32 tag) with
  // the programdata and the authority at its fixed positions, or a lookup-table instruction with the table at
  // accounts[0] and the authority at accounts[1]
  const LOADER_AUTHORITY = { 2: [1, 7], 3: [0, 6], 4: [0, 1], 5: [0, 2], 7: [0, 1] };
  const authorityOf = (t) => {
    const keys = keysOf(t);
    return t.transaction.message.instructions.some((i) => {
      const at = (n) => (i.accounts && i.accounts.length > n ? keys[i.accounts[n]] : undefined);
      if (keys[i.programIdIndex] === ALT_PROGRAM) return !!d.table && at(0) === d.table && at(1) === keys[0];
      if (keys[i.programIdIndex] !== LOADER_V3) return false;
      const data = b58decode(i.data);
      const pos = data.length >= 4 ? LOADER_AUTHORITY[data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)] : undefined;
      return !!pos && at(pos[0]) === d.programdata && at(pos[1]) === keys[0];
    });
  };
  const rows = [];
  const add = (signature, t, known) => {
    const keys = keysOf(t);
    const ix = t.transaction.message.instructions.find((i) => keys[i.programIdIndex] === LOADER_V3);
    const step = known ?? (ix ? `the upgradeable loader: ${LOADER_STEPS[b58decode(ix.data)[0]] ?? "another instruction"}` : "on the programdata");
    rows.push({ step, signature, slot: t.slot, payer: keys[0] });
  };
  const known = [];
  for (const [signature, step] of steps) known.push({ signature, step, t: await read(signature) });
  const onChain = [];
  for (const signature of history) onChain.push({ signature, step: null, t: await read(signature) });
  const ours = new Set([d.funder].filter(Boolean));
  for (const k of [...known, ...onChain]) if (authorityOf(k.t)) ours.add(keysOf(k.t)[0]);
  ours.delete(d.return_to);
  for (const k of known) {
    if (ours.has(keysOf(k.t)[0]) || ours.has(plainTo(k.t))) add(k.signature, k.t, k.step);
    else say(`left out of the record: ${k.signature} (${k.step}): paid by ${keysOf(k.t)[0]}, not a run key's nor one plain System Transfer from its payer into a run key`);
  }
  for (const k of onChain) if (ours.has(keysOf(k.t)[0])) add(k.signature, k.t, null);
  rows.sort((a, b) => a.slot - b.slot);
  return { ...d, txs: rows.map(({ step, signature }) => ({ step, signature })), funders: [...new Set(rows.map((r) => r.payer).filter((p) => p !== d.return_to))] };
}

/** A funding's one shape: `t` (getTransaction, encoding json) is one plain System Transfer from its fee payer (u32 2, u64
 * lamports; compute budget instructions beside it allowed). Its destination, or null: another payer's transaction of any
 * other shape (paste 2's 3qRUcXSY: a stranger's 1 lamport to each of 18 addresses, the funder among them) is no
 * funding. */
export const plainTransferTo = (t) => plainTransfer(t)?.to ?? null;

/** An account once a finalized read shows it (and `ready(acc)` holds), waiting up to 60 s: steps confirm at
 * "confirmed", reads are "finalized". */
async function settled(fetchFn, url, addr, ready = () => true, { wait = sleep, now = Date.now } = {}) {
  const until = now() + 60_000;
  let failed = null;
  for (;;) {
    // a read that fails (its tries all rate-limited) is read again until the deadline, like one that reads nothing
    let a = null;
    try {
      a = await account(fetchFn, url, addr);
      failed = null;
    } catch (e) {
      if (!e.transient) throw e;
      failed = e;
    }
    if (a && ready(a)) return a;
    if (now() > until) throw new Error(`${addr} not readable at finalized in 60 s${failed ? `: ${failed.message}` : ""}`);
    await wait(2000);
  }
}

/** `read()`'s answer, read again 2 s apart for up to 90 s while it fails past rpc()'s tries (rate-limited or reset:
 * `transient`). A JSON-RPC error answer is the node's word: thrown at once. */
async function readAgain(read, what, { wait = sleep, now = Date.now } = {}) {
  for (const until = now() + 90_000; ; ) {
    try {
      return await read();
    } catch (e) {
      if (!e.transient) throw e;
      if (now() > until) throw new Error(`${what} not read in 90 s: ${e.message}`);
      log(`${what} not read (${e.message}): reading it again in 2 s`);
      await wait(2000);
    }
  }
}

/** What a deploy try left, read at confirmed on `url`: "final" (this code, upgrade authority none), "upgradeable" (this
 * code, the funder its upgrade authority: the deploy landed and its SetAuthority to none did not), or "absent" (no
 * program, or not this code: deployed again from the buffer). */
export async function deployedState(fetchFn, url, programId, so, funderId) {
  const p = await programProblems(fetchFn, url, programId, so, "confirmed");
  if (!p.length) return "final";
  return p.length === 1 && p[0] === `upgrade authority ${funderId} is set on ${url}` ? "upgradeable" : "absent";
}

/** What keeps `programId` from being this build, final, on `url`: [] when it is executable, owned by the upgradeable
 * loader, its programdata the one its id derives, its upgrade authority none, and its code `so` with only zeros
 * after it. A resume (--program) reads it on two RPCs before it spends a lamport. */
export async function programProblems(fetchFn, url, programId, so, commitment = "finalized") {
  const out = [];
  const pa = await account(fetchFn, url, programId, undefined, commitment);
  const pdAddr = programDataAddress(programId);
  if (!pa) return [`${programId}: no account on ${url}`];
  if (!pa.executable || pa.owner !== LOADER_V3 || pa.data.length !== 36 || pa.data[0] !== 2 || b58encode(pa.data.subarray(4, 36)) !== pdAddr) {
    out.push(`${programId} is not an executable upgradeable-loader program pointing at ${pdAddr} on ${url}`);
  }
  const pd = await account(fetchFn, url, pdAddr, undefined, commitment);
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
    // a read that fails past rpc()'s tries is "not finalized yet", read again until the deadline
    let v = null;
    try {
      v = (await rpc(fetchFn, url, "getSignatureStatuses", [sigs, { searchTransactionHistory: true }], wait)).value;
    } catch (e) {
      if (!e.transient) throw e;
    }
    if (v?.every((s) => s?.confirmationStatus === "finalized" && s.err === null)) return;
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

/** Why `addr` is not a wallet the funder's rest can go back to on `url`, or null when it is: a point on the ed25519
 * curve (a key signs for it, so never a program address), and a system account holding lamports (a wallet in use). */
export async function returnProblems(fetchFn, url, addr) {
  try {
    ed25519.Point.fromBytes(address(addr));
  } catch {
    return "is not on the ed25519 curve (no key signs for it: a program address, or a typo)";
  }
  const a = await account(fetchFn, url, addr);
  if (!a || !(a.lamports > 0)) return `holds no lamports on ${url}`;
  if (a.owner !== SYSTEM || a.executable) return `is owned by ${a.owner}, not the system program, on ${url}`;
  return null;
}

/** The command that sweeps a stopped run's kept keys: the owner's paste's own sweep form for its journal (it fetches the
 * pinned solana CLI the closes need, which the paste removed on exit), deploy.mjs --sweep-kept otherwise. */
export function sweepCommand(journalFile, url, cluster) {
  const rel = path.relative(REPO, journalFile);
  if (cluster === "mainnet" && rel === PASTE_JOURNAL) return "sh contracts/pool-solana/scripts/mainnet-deploy.sh --sweep-kept";
  return `node contracts/pool-solana/scripts/deploy.mjs --sweep-kept ${rel} --url ${new URL(url).origin}${cluster === "mainnet" ? " --mainnet" : ""}`;
}
/** The mainnet live check as the owner's paste runs it after the deploy. */
export const MAINNET_LIVE_CHECK = "node scripts/live-checks/pool-sol-deploy-mainnet.mjs --record scripts/live-checks/pool-sol-deploy-mainnet.good.json --write-record";
/** The owner's paste's journal (mainnet-deploy.sh's --out, with .journal.json). */
export const PASTE_JOURNAL = "contracts/pool-solana/deployments/mainnet.journal.json";

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
 * less one fee to the run's return address, or to --return when it funded that key (its plain transfers into it at
 * least the run's need). The run's buffer (buffer.json) is read by its own address. Then, once both read 0 on two RPCs with nothing under the funder's authority, removes the key folder. The
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
    if ((id && k.id !== id) || b58encode(ed25519.getPublicKey(k.secret)) !== k.id) throw new Error(`${f} is not the key of ${id ?? k.id}`);
    return k;
  };
  const funder = load("funder.json", j.funder);
  if (!funder) throw new Error(`${dir} has no funder.json`);
  // the program id's key holds what was sent to it, unless it is a deployed program (executable, the upgradeable
  // loader's): then its lamports are the program's own rent, never sweepable (the rule leftovers uses)
  const programKey = load("program.json", j.program_id);
  const pa = programKey ? await account(fetchFn, url, programKey.id, undefined, "confirmed") : null;
  const holders = [funder, ...(programKey && !(pa?.executable && pa.owner === LOADER_V3) ? [programKey] : [])];
  // the run's buffer (buffer.json, or the journal's buffer field): read by its own address, listed or not
  const bufferKey = load("buffer.json", j.buffer ?? null);
  const known = new Set(j.txs.map((t) => t.signature));
  // --return's rule (a look-alike address poisoner sends one plain 1-lamport transfer into a run key, and the run's own
  // history labels any plain transfer a funding): a sender counts only when its plain transfers into the key add up to
  // at least the run's need; a journal from before the need was journaled takes the senders it labels a funding
  const need = /^\d+$/.test(String(j.need ?? "")) ? BigInt(j.need) : null;
  const journaledFunding = new Set(j.txs.filter((t) => /^(first run: )?funding \(/.test(t.step)).map((t) => t.signature));
  // the plain transfers into a key, read on chain: [{ signature, from, lamports }]
  const incoming = async (k) => {
    const out = [];
    for (const f of (await rpc(fetchFn, url, "getSignaturesForAddress", [k.id, { commitment: "confirmed" }])).reverse()) {
      if (f.err !== null) continue;
      const t = await rpc(fetchFn, url, "getTransaction", [f.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      // a funding only (one plain System Transfer from its payer): a stranger's dust is never a sender --return may name
      const p = plainTransfer(t);
      if (p?.to === k.id && p.from !== k.id) out.push({ signature: f.signature, from: p.from, lamports: p.lamports });
    }
    return out;
  };
  // what the run left under the funder's authority goes first, while the funder still holds the fees (the cleanup keeps
  // its reserve when it gave one up): a buffer, a program it can still upgrade, a live lookup table. Each failure is
  // said and kept in the journal's why; the CLI's own transactions are read from the funder's history after each call
  // (the funder's fee payer only: a transfer into it is a funding, which the sweep below reads as one)
  const cliTxs = async (step) => {
    for (const f of (await rpc(fetchFn, url, "getSignaturesForAddress", [funder.id, { commitment: "confirmed" }])).reverse()) {
      if (f.err === null) raise(floor, f.slot);
      if (known.has(f.signature)) continue;
      const t = await rpc(fetchFn, url, "getTransaction", [f.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (t?.transaction.message.accountKeys[0] === funder.id) known.add(f.signature), j.txs.push({ step, signature: f.signature, state: f.err === null ? "landed" : "failed", cli: true });
    }
  };
  const mainnet = j.genesis_hash === MAINNET_GENESIS;
  const floor = { slot: 0 }; // the sweep's own highest landed slot: its reads of what is left are held to it
  const ops = chainOps({
    fetchFn, url, second, funder, programId: j.program_id, buffer: bufferKey?.id ?? j.buffer ?? null, keyFile: path.join(dir, "funder.json"), returnTo: j.return_to, cli: run, wait, now, tableOf: () => j.table ?? null,
    afterCli: cliTxs, priced: (ixs) => (mainnet ? [priceIx(PRIORITY_MICRO_LAMPORTS), ...ixs] : ixs), floor,
  });
  const failed = [];
  let left = null;
  try {
    for (const [name, step] of [
      ["buffer close", () => ops.closeBuffers()],
      ["program close", async () => {
        if (await ops.upgradeableByFunder()) await ops.closeProgram();
      }],
      ["table freeze", async () => {
        const sig = await ops.freezeTable();
        if (sig) known.add(sig), j.txs.push({ step: "lookup table: freeze (authority none), by --sweep-kept", signature: sig, state: "landed" });
      }],
    ]) {
      try {
        await step();
      } catch (e) {
        failed.push(`${name}: ${String(e.message).split("\n")[0]}`);
        log(`sweep-kept: ${name} failed: ${String(e.message).split("\n")[0]}`);
      }
    }
    for (const k of holders) {
      const balance = await ops.balanceAt(url, k.id);
      const ins = await incoming(k);
      const sent = (from) => ins.filter((i) => i.from === from).reduce((a, i) => a + i.lamports, 0n);
      const counts = (i) => (need === null ? journaledFunding.has(i.signature) : sent(i.from) >= need);
      const who = k === funder ? "the funder" : "the program id";
      for (const i of ins) {
        if (!known.has(i.signature)) known.add(i.signature), j.txs.push({ step: need === null || counts(i) ? `funding (to ${who})` : `a plain transfer into ${who} below the run's need: not a funding`, signature: i.signature, state: "landed" });
      }
      // a close or freeze that failed keeps the reserve in the funder, so a later --sweep-kept can still pay for it
      const keep = k === funder && failed.length ? CLEANUP_RESERVE : 0n;
      if (balance <= FEE_PER_SIGNATURE + keep) continue;
      // to the run's return address, which the run read as a wallet in use before any key; --return may name another
      // only when it funded this key (another wallet of the owner's): its plain transfers into it at least the need
      const sources = [...new Set(ins.filter(counts).map((i) => i.from))];
      if (to && !sources.includes(to) && to !== j.return_to) {
        throw new Error(`--return ${to} is neither a sender to ${k.id} (${sources.join(", ") || "none read"}${need === null ? "" : `, each sending at least the run's need ${need} lamports`}) nor the run's return address`);
      }
      const dest = to ?? j.return_to;
      const sig = await sendAndConfirm(fetchFn, url, [transferIx(k.id, dest, balance - FEE_PER_SIGNATURE - keep)], k, [k], { wait, now, floor });
      j.txs.push({ step: `sweep (kept keys, to ${dest === j.return_to ? "the run's return address" : "a sender of the funding"})`, signature: sig, state: "landed" });
      log(`sweep-kept: ${balance - FEE_PER_SIGNATURE - keep} lamports from ${k.id} to ${dest}: ${sig}`);
    }
    // what is left, read again for about 20 s while it is not nothing: a read right after the sweep can lag on either RPC
    const leftNow = async () => {
      const out = [...failed];
      for (const k of holders) for (const u of [...new Set([url, second])]) {
        const b = await ops.balanceAt(u, k.id);
        if (b !== 0n) out.push(`${k.id} holds ${b} lamports on ${u}`);
      }
      return [...out, ...(await ops.leftovers())];
    };
    left = await settledLeft(leftNow, { wait, again: !failed.length });
  } catch (e) {
    left = [...(left ?? failed), `--sweep-kept stopped: ${String(e.message).split("\n")[0]}`];
    throw e;
  } finally {
    if (left?.length) Object.assign(j.keys, { state: "kept", why: [...new Set(left)] });
    else {
      rmSync(dir, { recursive: true, force: true });
      Object.assign(j.keys, { state: "removed", why: ["swept by --sweep-kept: every key of the run reads 0 on both RPCs, nothing under the funder's authority"] });
    }
    writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    log(`sweep-kept: keys ${j.keys.state}${left?.length ? `: ${left.join("; ")}` : ""}; wrote ${file}`);
  }
  return j;
}

/** What is left after a run or a sweep (`read()`: [] when nothing), read again up to 10 times 2 s apart while it is not
 * [] and `again`: the reads right after the sweep can lag on either RPC (a stale balance kept a good run's keys). */
export async function settledLeft(read, { wait = sleep, again = true, tries = 10 } = {}) {
  let left = await read();
  for (let i = 0; again && left.length && i < tries; i++) {
    await wait(2000);
    left = await read();
  }
  return left;
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
    const r = await chainRecord(fetchFn, url, d, { say: log });
    const target = fromJournal ? rebuild.replace(/\.journal\.json$/, ".json") : rebuild;
    writeFileSync(target, JSON.stringify(r, null, 2) + "\n");
    log(`rebuilt ${target} from ${url}: ${r.txs.length} transactions, funders ${r.funders.join(", ")}`);
    for (const t of r.txs) log(`tx ${t.step}: ${t.signature}`);
    return r;
  }
  // mainnet: one program, ever. A record there means the run completed; a second paste would deploy a second program
  const outFile = opt("--out", path.join(REPO, `scripts/live-checks/pool-sol-deploy.${cluster}.json`));
  if (cluster === "mainnet" && existsSync(outFile)) {
    throw new Error(`${path.relative(REPO, outFile)} exists: the program is deployed: run its live check alone: ${MAINNET_LIVE_CHECK}`);
  }
  const returnTo = opt("--return");
  if (!returnTo) throw new Error("--return <address> is required: the funder's rest goes back there");
  address(returnTo);
  // a public cluster: the return address is a wallet someone holds, read on both RPCs before any key. A typo or a
  // program address still decodes to 32 bytes, and the funder's rest (all of the funding, should the run stop after
  // it) would go where nobody can spend it
  if (cluster !== "localnet") {
    for (const u of [url, second0]) {
      const why = await returnProblems(fetchFn, u, returnTo);
      if (why) throw new Error(`${cluster} refused: --return ${returnTo} ${why}: nothing was made or sent`);
    }
  }
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

  // the run's journal, beside the record and never the record itself: a stopped run leaves the record as it was. One
  // that exists is a stopped run's, never written over: refused while its keys are kept (its sweep goes first), when it
  // is another cluster's, when it is another program's than --program, and for a fresh run while its program is final
  // with this code (that run is resumed, not deployed twice). Otherwise it is moved aside unchanged, and a resume takes
  // its landed transactions (not the CLI's writes) into the record
  const journalFile = journalOf(outFile);
  const priorTxs = [];
  let priorTable = null; // a resume: the stopped run's lookup table, reused when it reads frozen with exactly the list
  if (existsSync(journalFile)) {
    const j = JSON.parse(readFileSync(journalFile, "utf8"));
    const refuse = (why) => {
      throw new Error(`${journalFile} exists: a stopped run's journal ${why}`);
    };
    if (j.genesis_hash !== genesis) refuse(`of genesis ${j.genesis_hash}, not ${url}'s: move it aside before another run to ${outFile}`);
    if (j.keys?.state !== "removed") refuse(`, its keys ${j.keys?.state ?? "in an unknown state"}: sweep them first with: ${j.keys?.sweep ?? "its keys.sweep command"}`);
    if (resumeId && j.program_id !== resumeId) refuse(`of program ${j.program_id}, not --program ${resumeId}: move it aside before another run to ${outFile}`);
    // either RPC reading it final refuses: one lagging must never let a second program be deployed
    if (!resumeId && j.program_id && (!(await programProblems(fetchFn, url, j.program_id, so)).length || !(await programProblems(fetchFn, second0, j.program_id, so)).length)) {
      refuse(`, its program ${j.program_id} is final with this code: resume it with --program ${j.program_id}${cluster === "mainnet" ? ` (sh contracts/pool-solana/scripts/mainnet-deploy.sh ${returnTo} --program ${j.program_id})` : ""}`);
    }
    const aside = `${outFile.replace(/\.json$/, "")}.stopped-${String(j.stopped_at ?? j.at ?? new Date().toISOString()).replace(/[^0-9TZ]/g, "")}.journal.json`;
    if (existsSync(aside)) refuse(`, and ${aside} exists too: move one of them aside`);
    if (resumeId) for (const t of j.txs ?? []) if (t.state === "landed" && !t.cli) priorTxs.push({ step: t.step.startsWith("first run") ? t.step : `first run: ${t.step}`, signature: t.signature });
    if (resumeId && typeof j.table === "string") priorTable = address(j.table) && j.table;
    renameSync(journalFile, aside);
    log(`the stopped run's journal (keys removed) moved to ${aside}${resumeId ? `; its ${priorTxs.length} landed transaction(s) go in the record` : ""}`);
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
  // the deploy's buffer, a key of the run's own, so a failed try is resumed into the same buffer
  const bufferKey = resumeId ? null : newKey();
  const bufferFile = bufferKey ? fileOf(bufferKey, "buffer.json") : null;
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
  // a resume's: the stopped run's landed transactions and --prior's, journaled from the start, so a resume that stops
  // before its funding still hands them on (the record adds the programdata's own: the deploy and its SetAuthority)
  const txs = [...priorTxs.map((t) => ({ ...t, state: "landed" })), ...prior.map((sig) => ({ step: "first run (--prior)", signature: sig, state: "landed" }))];
  const floor = { slot: 0 }; // the run's highest landed slot (raise): what the cleanup's reads are held to
  const unsettled = new Map(); // signature -> { step, signature, base64, lastValid }
  const fields = {
    cluster, genesis_hash: genesis, rpc: new URL(url).host, program_id: program.id, programdata: programDataAddress(program.id), pool: poolAddress(program.id).address,
    so_len: so.length, so_sha256: soSha, build, ci_run: ci?.run ?? null, commit: ci?.commit ?? null, funder: funder.id, return_to: returnTo,
    // a resume's journal names the stopped run's table from its start: a resume that stops before the table step
    // leaves it for the next one to reuse, never a journal with no table (a second table, its rent locked for good)
    ...(tableList ? { table: priorTable, table_addresses: tableList } : {}),
    ...(bufferKey ? { buffer: bufferKey.id } : {}),
  };
  const keys = { folder: path.basename(dir), state: "in use", why: [], sweep: sweepCommand(journalFile, url, cluster) };
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
    const sigs = (await rpc(fetchFn, url, "getSignaturesForAddress", [funder.id, { commitment: "confirmed" }], wait)).reverse();
    const found = [];
    for (const f of sigs) {
      if (f.err === null) raise(floor, f.slot);
      if (txs.some((t) => t.signature === f.signature)) continue;
      const t = await rpc(fetchFn, url, "getTransaction", [f.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      const payer = t?.transaction.message.accountKeys[0];
      const state = f.err === null ? "landed" : "failed";
      if (payer === funder.id) found.push({ step: cliStep ?? "the funder's own (not this run's journal)", signature: f.signature, state, cli: true });
      else if (state === "landed") found.push({ step: plainTransferTo(t) === funder.id ? "funding (to the funder)" : "another payer's transaction naming the funder: not a funding", signature: f.signature, state });
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
    const send = (step, ixs) => sendAndConfirm(fetchFn, url, priced(ixs), funder, [funder], { step, journal, floor, ...clock });
    const ops = chainOps({ fetchFn, url, second, funder, programId: program.id, keyFile: funderFile, returnTo, resume: !!resumeId, cli: runCli, journal, afterCli, tableOf: () => fields.table ?? null, priced, floor, ...clock });
    // funded: the funder held the need and its funding was read; until then a stop keeps the keys (a transfer may land
    // at any time: a paste made after a terminal closed)
    let funded = false;
    stoppedRecord();
    try {
      const rent = async (n) => BigInt(await rpc(fetchFn, url, "getMinimumBalanceForRentExemption", [n]));
      const need = await needOf(rent, so.length, { resume: !!resumeId, poolExists, mainnet: withTable, tableLen: tableList?.length ?? 0 });
      Object.assign(fields, { need: String(need.total), need_parts: Object.fromEntries(Object.entries(need.parts).map(([k, v]) => [k, String(v)])) });
      log(`program id ${program.id}`);
      log(`funder ${funder.id} needs ${need.total} lamports (${solOf(need.total)} SOL: ${Object.entries(need.parts).map(([k, v]) => `${k} ${v}`).join(", ")}); the rest is swept back to ${returnTo}`);
      log(`waiting for ${funder.id} to hold ${need.total} lamports (${solOf(need.total)} SOL): send from ${returnTo}, the return address`);
      for (;;) {
        if (stop) throw new Error(`stopped by ${stop}`);
        // a read that fails (its five tries all rate-limited or reset, as api.devnet answered on 5 Nov 18:47Z) is read
        // again at the next poll: a run that ended here would leave the owner's transfer to a run that is gone
        let held = -1n;
        try {
          held = await ops.balance();
        } catch (e) {
          log(`the funder's balance not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
        }
        if (held >= need.total) break;
        await wait(WAITS.poll);
      }
      // the funding's history: a read that fails is read again, as the balance is (a run that ended here would sweep
      // the owner's transfer back with no deploy: one more paste)
      let funding;
      for (;;) {
        if (stop) throw new Error(`stopped by ${stop}`);
        try {
          funding = await history();
          break;
        } catch (e) {
          log(`the funder's history not read (${e.message}): reading it again in ${WAITS.poll / 1000} s`);
          await wait(WAITS.poll);
        }
      }
      txs.push(...funding);
      funded = true;
      stoppedRecord();
      log(`funded: ${funding.filter((t) => !t.cli).length} incoming transfer(s)`);
      check("funding");

      if (resumeId) {
        // the first run's transactions are in the journal from its start (txs above)
        log(`resume: ${priorTxs.length + prior.length} prior transaction(s) kept for the record`);
      } else {
        // each try is a new CLI process (a fresh leader socket: v4.4.0 reads leaders from one websocket that never
        // reconnects), with no --final: the CLI sends its SetAuthority with no compute unit price (agave v4.4.0
        // cli/src/program.rs 1496-1508, process_set_authority) and its failure would cost a whole try; the run sends its
        // own below. Before a retry, what the last try left is read at confirmed: this code (the funder its authority,
        // or final) is deployed, never deployed again (the CLI's upgrade path refuses it and the cleanup would close
        // it); anything else is deployed again from the run's buffer, while the funder holds one more try's bound and
        // the rest of the run, so the cleanup can always pay to close the buffer
        const writes = BigInt(Math.ceil(so.length / WRITE_CHUNK));
        const prio = cluster === "mainnet" ? PRIORITY_PER_TX : 0n;
        // the rest of the run after the deploy (a resume's need), and the SetAuthority
        const afterDeploy = (await needOf(rent, so.length, { resume: true, poolExists, mainnet: withTable, tableLen: tableList?.length ?? 0 })).total + FEE_PER_SIGNATURE + prio;
        // one try at most: the program account, the programdata less what the run's buffer holds (the deploy drains the
        // buffer to the payer), the buffer's make (2 signatures), every write, the deploy (2), each priced on mainnet
        const oneTry = async () => {
          const buf = await readAgain(() => account(fetchFn, url, bufferKey.id, undefined, "confirmed"), "the run's buffer", clock);
          const held = BigInt(buf?.lamports ?? 0);
          return need.parts.program_account + (need.parts.programdata > held ? need.parts.programdata - held : 0n) + FEE_PER_SIGNATURE * (2n + writes + 2n) + prio * (1n + writes + 1n);
        };
        const deployedNow = () => readAgain(() => deployedState(fetchFn, url, program.id, so, funder.id), "the program", clock);
        let dep = null;
        for (let attempt = 1; ; attempt++) {
          if (stop) throw new Error(`stopped by ${stop}`);
          const left = attempt === 1 ? "absent" : await deployedNow();
          if (left !== "absent") {
            log(`deploy try ${attempt - 1} of ${DEPLOY_TRIES} left ${program.id} deployed with this code (${left === "final" ? "final" : "the funder its authority"})`);
            break;
          }
          if (attempt > 1) {
            const held = await readAgain(() => ops.balance(), "the funder's balance", clock);
            const want = afterDeploy + (await oneTry());
            if (held < want) throw new Error(`deploy try ${attempt} of ${DEPLOY_TRIES} not started: the funder holds ${held} lamports, below the ${want} one more try and the rest of the run need (the cleanup closes the run's buffer)`);
          }
          log(`deploy try ${attempt} of ${DEPLOY_TRIES}: at most about ${DEPLOY_SIGN_ATTEMPTS} min (${DEPLOY_SIGN_ATTEMPTS} sign attempts, a blockhash's ~60 s each)`);
          try {
            dep = runCli(["program", "deploy", codeFile, "--program-id", programFile, "--upgrade-authority", funderFile, "--buffer", bufferFile, "--max-len", String(so.length),
              "--max-sign-attempts", String(DEPLOY_SIGN_ATTEMPTS), ...(cluster === "mainnet" ? ["--with-compute-unit-price", String(PRIORITY_MICRO_LAMPORTS)] : []), "--output", "json", ...common], { allowFail: true });
          } finally {
            await afterCli(`the solana CLI: program deploy${attempt > 1 ? ` (try ${attempt})` : ""} (buffer, writes, deploy)`).catch((e) => log(`the CLI's transactions not read: ${e.message}`));
          }
          if (dep.status === 0) break;
          const why = (dep.stderr || dep.stdout || dep.error?.message || "").trim().split("\n").slice(-3).join(" | ");
          if (attempt >= DEPLOY_TRIES) throw new Error(`solana program deploy: exit ${dep.status}: ${why} (try ${attempt} of ${DEPLOY_TRIES})`);
          log(`deploy try ${attempt} of ${DEPLOY_TRIES} failed: ${why}: trying again from the run's buffer in ${WAITS.poll / 1000} s`);
          dep = null;
          await wait(WAITS.poll);
        }
        if (dep) {
          const out = JSON.parse(dep.stdout.slice(dep.stdout.indexOf("{")));
          if (out.programId !== program.id) throw new Error(`deployed ${out.programId}, not ${program.id}`);
          const t = txs.find((x) => x.signature === out.signature);
          if (t) Object.assign(t, { step: "deploy with the upgradeable loader", cli: false });
          else txs.push({ step: "deploy with the upgradeable loader", signature: out.signature, state: "landed" });
        }
        stoppedRecord();
        // the SetAuthority to none, the run's own send: the upgradeable loader's instruction 4 (SetAuthority, its bincode
        // u32 LE) on [programdata (writable), the current authority (signer)] with no new authority, which makes the
        // program final (solana-loader-v3-interface instruction.rs set_upgrade_authority). Priced on mainnet, journaled
        // before its send and sent again for WAITS.confirm (sendAndConfirm); one that does not land is tried again from a
        // fresh read, up to AUTHORITY_TRIES times. A deploy the CLI said landed that this node does not read yet is
        // read again for 90 s
        const setAuthority = { program: LOADER_V3, keys: [{ id: programDataAddress(program.id), signer: false, writable: true }, { id: funder.id, signer: true, writable: false }], data: le(4, 4) };
        let lastTry = null;
        for (let n = 1, until = clock.now() + 90_000; ; ) {
          if (stop) throw new Error(`stopped by ${stop}`);
          const left = await deployedNow();
          if (left === "final") break;
          if (left === "absent") {
            if (clock.now() > until) throw new Error(`${program.id} is not read deployed with this code at confirmed on ${url} 90 s after its deploy`);
            await wait(2000);
            continue;
          }
          if (n > AUTHORITY_TRIES) throw new Error(`the SetAuthority to none did not land in ${AUTHORITY_TRIES} tries: ${lastTry}`);
          log(`the upgradeable loader: SetAuthority (to none) try ${n} of ${AUTHORITY_TRIES}`);
          try {
            log(`SetAuthority (to none) landed: ${await send("the upgradeable loader: SetAuthority (to none)", [setAuthority])}`);
          } catch (e) {
            lastTry = e.message;
            log(`SetAuthority (to none) try ${n} of ${AUTHORITY_TRIES} failed: ${e.message}: reading the program again in ${WAITS.poll / 1000} s`);
            await wait(WAITS.poll);
          }
          n++;
        }
        stoppedRecord();
        await settled(fetchFn, url, programDataAddress(program.id), undefined, clock);
        // the SetAuthority is the deploy's second transaction: a finalized read right after it can still show
        // the funder as authority (the table rehearsal on a local validator, 5 Nov), so the read is retried up to 90 s
        // on both RPCs: the run is done only once each reads the program final with this code. A read that fails is a
        // problem of that pass, read again
        let problems;
        for (const until = clock.now() + 90_000; ; await clock.wait(2000)) {
          try {
            problems = [...(await programProblems(fetchFn, url, program.id, so)), ...(await programProblems(fetchFn, second, program.id, so))];
          } catch (e) {
            if (!e.transient) throw e;
            problems = [`not read: ${e.message}`];
          }
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
        // step 6m: the pool buy's lookup table, made, read back, frozen, read back; no test deposit. A resume whose
        // stopped run made it and froze it (the same bytes on both RPCs at finalized, active, authority none, exactly
        // this list) reuses it: a second frozen table would lock its rent for good
        let reused = false;
        if (priorTable) {
          const reads = await readAgain(() => Promise.all([url, second].map((u) => account(fetchFn, u, priorTable, wait))), "the stopped run's lookup table", clock);
          const same = reads.every((r) => r && reads[0] && r.owner === reads[0].owner && Buffer.from(r.data).equals(Buffer.from(reads[0].data)));
          const why = same ? tableProblems(reads[0], tableList, null) : [`the reads on ${url} and ${second} are not the same bytes`];
          if (!why.length) {
            fields.table = priorTable;
            stoppedRecord();
            reused = true;
            log(`lookup table ${priorTable}, the stopped run's, is frozen (authority none) and holds exactly the list on both RPCs at finalized: reused`);
          } else log(`lookup table ${priorTable}, the stopped run's, is not reused (${why.join("; ")}): a new one is made`);
        }
        if (!reused) {
        const slot = BigInt(await readAgain(() => rpc(fetchFn, url, "getSlot", [{ commitment: "finalized" }], wait), "the slot", clock));
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
        }
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
      // when funded, read again for about 20 s while something reads left: a read right after the sweep can lag
      let left;
      try {
        let after = c.after;
        left = await settledLeft(async () => {
          const l = [...(funded ? [] : ["the run stopped before its funding was read: a transfer can still land on the funder"]),
            ...(after === 0n ? [] : [`the cleanup left the funder at ${after ?? "an unread balance"}`]), ...(await ops.leftovers())];
          if (l.length) after = await ops.balance().catch(() => after);
          return l;
        }, { wait, again: funded && c.problems.every((p) => !p.startsWith("kept ")) });
        c.after = after;
      } catch (e) {
        left = [`the check for what is left failed: ${String(e.message).split("\n")[0]}`];
      }
      if (left.length) {
        Object.assign(keys, { state: "kept", why: left });
        log(`KEYS KEPT in ${dir} (0700; funder.json${programFile ? ", program.json" : ""}${bufferFile ? ", buffer.json" : ""}): ${left.join("; ")}; sweep them later with: ${keys.sweep}`);
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
    const done = result;
    try {
      await waitFinalized(fetchFn, url, done.txs.map((t) => t.signature), clock);
      result = await readAgain(() => chainRecord(fetchFn, url, done, { ...clock, say: log }), "the record's transactions", clock);
    } catch (e) {
      // the keys are removed and every lamport is back: the record is written later from the journal, from chain reads
      log(`the record not written (${e.message}): write it from the journal with: node contracts/pool-solana/scripts/deploy.mjs --rebuild-record ${journalFile} --url ${url}${cluster === "mainnet" ? " --mainnet" : ""}`);
      throw e;
    }
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
