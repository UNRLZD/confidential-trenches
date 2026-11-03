#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Deploys the Blindfill pool program to Solana devnet (or a local validator, the dry run), immutable, then makes its
// SOL pool and one test deposit. Every key lives only in this run.
//
//   node contracts/pool-solana/scripts/deploy.mjs --return <address> [--url <rpc>] [--no-build] [--out <file>]
//
// Steps:
//  1. The cluster from its genesis hash: devnet, or a local validator on a loopback URL. Mainnet is refused (its
//     deploy is the owner's, on a program id of its own: M351).
//  2. The build: cargo-build-sbf --sbf-out-dir out -- --locked (CI's command, refused when a stack frame overflows), its
//     sha256 and length printed. The keypair cargo-build-sbf writes beside the .so is deleted unread: the program id
//     is made here, fresh.
//  3. Two keys made in memory: the program's and the run's funder. The solana CLI reads keys only from files, so both
//     go to a 0700 temp folder, files 0600, removed at exit; neither is ever printed.
//  4. The funder's need, printed with its parts: rent of the program account (36 B) and its programdata (45 B + the
//     code), the pool (POOL_LEN), the deposit (0.01 SOL, its 16 B mark and two first page entries), the funder's own
//     rent(0) (it must stay rent-exempt between steps), and a fee bound for
//     every signature (the CLI's write chunks counted at 900 B, fewer than it writes). Then it waits until the
//     funder holds that much, and records the funding transactions.
//  5. solana program deploy --final (the upgradeable loader; --final sets the upgrade authority to none in the deploy
//     itself), then reads the authority back.
//  6. Tag 0 init, then a 0.01 SOL deposit from the funder with a fresh note (nullifier and secret random in this run,
//     never printed or kept; the precommitment is public). The mark and both page leaves are read back and checked:
//     the label leaf against keccak256(scope, nonce) mod p, the state leaf against Poseidon(value, label,
//     precommitment).
//  7. Always, in a finally: any buffer the funder still owns is closed, a program the funder can still upgrade is
//     closed, and the funder's rest is swept to --return (retried), its signature printed; then the keys are removed.
//  8. Waits for every transaction to be finalized, writes the deployment record (scripts/live-checks/pool-sol-deploy.
//     <cluster>.json) and prints the live check to run next.
import "../../../scripts/net-window.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVNET_GENESIS, MAINNET_GENESIS, LOADER_V3, SYSTEM, POOL_LEN, PRE_MARK_LEN, P,
  RPCS as DEVNET_RPCS, account, address, b58encode, be32, cat, hex, labelOf, le, pageAddress, poolAddress, preMarkAddress, programDataAddress, rpc,
  scopeOf,
} from "../../../scripts/live-checks/pool-sol-deploy.mjs";

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

/** Sends a transaction and waits until it is confirmed with no error, resending while it is not. */
export async function sendAndConfirm(fetchFn, url, ixs, payer, keys) {
  const { value } = await rpc(fetchFn, url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = signTx(compileMessage(payer.id, ixs, value.blockhash), keys);
  const until = Date.now() + 90_000;
  const status = async () => (await rpc(fetchFn, url, "getSignatureStatuses", [[tx.signature], { searchTransactionHistory: true }])).value[0];
  while (Date.now() < until) {
    try {
      await rpc(fetchFn, url, "sendTransaction", [tx.base64, { encoding: "base64", preflightCommitment: "confirmed" }]);
    } catch (e) {
      // a resend of a transaction that already landed ("already been processed") is not a failure: its status says
      const s = await status();
      if (s?.err) throw new Error(`${tx.signature} failed: ${JSON.stringify(s.err)}`);
      if (s && ["confirmed", "finalized"].includes(s.confirmationStatus)) return tx.signature;
      if (!/already been processed/i.test(e.message)) throw e;
    }
    for (let i = 0; i < 4; i++) {
      await sleep(500);
      const s = (await rpc(fetchFn, url, "getSignatureStatuses", [[tx.signature]])).value[0];
      if (s?.err) throw new Error(`${tx.signature} failed: ${JSON.stringify(s.err)}`);
      if (s && ["confirmed", "finalized"].includes(s.confirmationStatus)) return tx.signature;
    }
  }
  throw new Error(`${tx.signature} not confirmed in 90 s`);
}

// ---- the solana CLI ----
function cli(args, { allowFail = false } = {}) {
  const r = spawnSync("solana", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 && !allowFail) throw new Error(`solana ${args[0]} ${args[1]}: exit ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

// ---- the need ----
/** The funder's need: each part in lamports, and their sum. `rent(n)` is the cluster's rent-exempt minimum. */
export async function needOf(rent, soLen, { resume = false, poolExists = false } = {}) {
  const writes = BigInt(Math.ceil(soLen / WRITE_CHUNK));
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
/**
 * Runs every step, whichever one throws, each retried: closes the funder's buffers, closes the program while the
 * funder can still upgrade it, then sweeps the funder's balance less one fee to `returnTo`, retried. Returns { swept, signature,
 * after, problems }. `ops` holds the chain calls (the test plants failures in them).
 */
export async function cleanup(ops, returnTo, { tries = 5, wait = sleep } = {}) {
  const problems = [];
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
  let signature = null;
  let swept = 0n;
  for (let i = 0; i < tries; i++) {
    try {
      const bal = await ops.balance();
      if (bal <= FEE_PER_SIGNATURE) {
        return { swept, signature, after: bal, problems: bal > 0n ? [...problems, `${bal} lamports left: not more than one fee`] : problems };
      }
      swept = bal - FEE_PER_SIGNATURE;
      signature = await ops.transfer(returnTo, swept);
      return { swept, signature, after: await ops.balance(), problems };
    } catch (e) {
      problems.push(`sweep try ${i + 1}: ${e.message}`);
      await wait(2000 * (i + 1));
    }
  }
  return { swept: 0n, signature: null, after: null, problems };
}

/** An account once a finalized read shows it (and `ready(acc)` holds), waiting up to 60 s: steps confirm at
 * "confirmed", reads are "finalized". */
async function settled(fetchFn, url, addr, ready = () => true) {
  const until = Date.now() + 60_000;
  for (;;) {
    const a = await account(fetchFn, url, addr);
    if (a && ready(a)) return a;
    if (Date.now() > until) throw new Error(`${addr} not readable at finalized in 60 s`);
    await sleep(2000);
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

async function waitFinalized(fetchFn, url, sigs) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const v = (await rpc(fetchFn, url, "getSignatureStatuses", [sigs, { searchTransactionHistory: true }])).value;
    if (v.every((s) => s?.confirmationStatus === "finalized" && s.err === null)) return;
    await sleep(2000);
  }
  throw new Error("not every transaction finalized in 120 s");
}

export async function main(argv, fetchFn = fetch) {
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const url = opt("--url", "https://api.devnet.solana.com");
  const returnTo = opt("--return");
  if (!returnTo) throw new Error("--return <address> is required: the funder's rest goes back there");
  address(returnTo);
  const genesis = await rpc(fetchFn, url, "getGenesisHash", []);
  const cluster = genesis === DEVNET_GENESIS ? "devnet" : genesis === MAINNET_GENESIS ? "mainnet" : LOOPBACK.test(url) ? "localnet" : null;
  if (cluster === "mainnet") throw new Error("mainnet refused: its deploy is the owner's, with a program id of its own (M351)");
  if (!cluster) throw new Error(`genesis ${genesis} at ${url} is neither devnet nor a loopback validator`);
  const failAfter = opt("--fail-after");
  if ((failAfter || argv.includes("--flaky")) && cluster !== "localnet") throw new Error("--fail-after and --flaky are for the local dry run only");
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

  if (!argv.includes("--no-build")) {
    const b = spawnSync("cargo-build-sbf", ["--sbf-out-dir", "out", "--", "--locked"], { cwd: POOL_DIR, encoding: "utf8" });
    const out = `${b.stdout}${b.stderr}`;
    if (b.status !== 0) throw new Error(`cargo-build-sbf: exit ${b.status}: ${out.trim().split("\n").slice(-3).join(" | ")}`);
    if (out.includes("overflows the maximum allowed frame space")) throw new Error("a stack frame overflows 4 KiB");
    log(`built with ${spawnSync("cargo-build-sbf", ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0]}`);
  }
  rmSync(path.join(POOL_DIR, "out/blindfill_pool_solana-keypair.json"), { force: true }); // unread: the id is made below
  const so = readFileSync(SO);
  const soSha = createHash("sha256").update(so).digest("hex");
  log(`code ${so.length} bytes, sha256 ${soSha}`);

  const second = cluster === "devnet" ? DEVNET_RPCS.find((u) => u !== url) ?? DEVNET_RPCS[1] : url.replace("127.0.0.1", "localhost");
  let poolExists = false;
  if (resumeId) {
    const problems = [...(await programProblems(fetchFn, url, resumeId, so)), ...(await programProblems(fetchFn, second, resumeId, so))];
    if (problems.length) throw new Error(`--program ${resumeId} refused: ${problems.join("; ")}`);
    const ps = poolState(await account(fetchFn, url, poolAddress(resumeId).address), resumeId);
    if (ps !== "missing" && ps !== "ours") throw new Error(`--program ${resumeId} refused: its pool address holds ${ps}`);
    poolExists = ps === "ours";
    log(`resume: ${resumeId} is final with this build's code on ${url} and ${second}; its pool ${poolExists ? "exists, init skipped" : "is missing, init runs"}`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "pool-sol-deploy-"));
  chmodSync(dir, 0o700);
  const program = resumeId ? { id: resumeId } : newKey();
  const funder = newKey();
  const fileOf = (k, name) => {
    const f = path.join(dir, name);
    writeFileSync(f, JSON.stringify([...k.secret, ...k.pub]), { mode: 0o600 });
    return f;
  };
  const programFile = resumeId ? null : fileOf(program, "program.json");
  const funderFile = fileOf(funder, "funder.json");
  const common = ["--url", url, "--keypair", funderFile, "--commitment", "confirmed"];
  const txs = [];
  let result = null;
  let stop = false;
  const onSignal = () => ((stop = true), log("stopping: the cleanup runs next"));
  process.on("SIGINT", onSignal).on("SIGTERM", onSignal);
  const check = (step) => {
    if (stop) throw new Error("stopped");
    if (failAfter === step) throw new Error(`planted failure after ${step} (--fail-after)`);
  };
  const ops = {
    closeBuffers: async () => {
      const r = cli(["program", "close", "--buffers", "--recipient", funder.id, "--bypass-warning", ...common]);
      const said = `${r.stdout}${r.stderr}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      log(`buffers closed: ${said}`);
    },
    upgradeableByFunder: async () => {
      if (resumeId) return false; // final already: read on two RPCs before this run spent anything
      const pd = await account(fetchFn, url, programDataAddress(program.id)).catch(() => null);
      return !!pd && pd.data[12] === 1 && b58encode(pd.data.subarray(13, 45)) === funder.id;
    },
    closeProgram: async () => {
      if (resumeId) throw new Error("a resumed program is never closed here");
      cli(["program", "close", program.id, "--recipient", funder.id, "--bypass-warning", ...common]);
      log(`program ${program.id} closed (it was not final)`);
    },
    balance: async () => BigInt((await rpc(fetchFn, url, "getBalance", [funder.id, { commitment: "confirmed" }])).value),
    transfer: async (to, lamports) => sendAndConfirm(fetchFn, url, [transferIx(funder.id, to, lamports)], funder, [funder]),
  };
  try {
    const rent = async (n) => BigInt(await rpc(fetchFn, url, "getMinimumBalanceForRentExemption", [n]));
    const need = await needOf(rent, so.length, { resume: !!resumeId, poolExists });
    log(`program id ${program.id}`);
    log(`funder ${funder.id} needs ${need.total} lamports (${Object.entries(need.parts).map(([k, v]) => `${k} ${v}`).join(", ")}); the rest is swept back to ${returnTo}`);
    log(`waiting for ${funder.id} to hold ${need.total} lamports`);
    for (;;) {
      if (stop) throw new Error("stopped");
      if ((await ops.balance()) >= need.total) break;
      await sleep(5000);
    }
    const funding = (await rpc(fetchFn, url, "getSignaturesForAddress", [funder.id, { commitment: "confirmed" }])).filter((s) => s.err === null);
    for (const f of funding.reverse()) txs.push({ step: "funding (to the funder)", signature: f.signature });
    log(`funded: ${funding.length} incoming transfer(s)`);
    check("funding");

    if (resumeId) {
      // the first run's transactions: its own (--prior: its funding and sweep), then the program's history before now
      for (const sig of prior) txs.push({ step: "first run (--prior)", signature: sig });
      const hist = (await rpc(fetchFn, url, "getSignaturesForAddress", [program.id, { commitment: "confirmed" }])).filter((x) => x.err === null);
      for (const h of hist.reverse()) txs.push({ step: "first run: deploy with the upgradeable loader, --final, or an earlier step on the program", signature: h.signature });
      log(`resume: ${prior.length} prior and ${hist.length} program transaction(s) kept for the record`);
    } else {
      const dep = cli(["program", "deploy", SO, "--program-id", programFile, "--upgrade-authority", funderFile, "--max-len", String(so.length),
        "--final", "--use-rpc", "--output", "json", ...common]);
      const out = JSON.parse(dep.stdout.slice(dep.stdout.indexOf("{")));
      if (out.programId !== program.id) throw new Error(`deployed ${out.programId}, not ${program.id}`);
      txs.push({ step: "deploy with the upgradeable loader, --final", signature: out.signature });
      await settled(fetchFn, url, programDataAddress(program.id));
      const problems = await programProblems(fetchFn, url, program.id, so);
      if (problems.length) throw new Error(problems.join("; "));
      log(`deployed ${program.id}, upgrade authority none, code sha256 ${soSha}`);
      check("deploy");
    }

    const pool = poolAddress(program.id);
    const sysKey = { id: SYSTEM, signer: false, writable: false };
    if (poolExists) log(`pool ${pool.address} exists: init skipped`);
    else {
      const init = await sendAndConfirm(fetchFn, url, [{ program: program.id, keys: [{ id: pool.address, signer: false, writable: true }, { id: funder.id, signer: true, writable: true }, sysKey], data: Uint8Array.of(0) }], funder, [funder]);
      txs.push({ step: "init (tag 0)", signature: init });
      log(`pool ${pool.address} made`);
    }
    check("init");

    // a fresh note: its nullifier and secret live only in this block
    const before = await settled(fetchFn, url, pool.address);
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
    const deposit = await sendAndConfirm(fetchFn, url, [{
      program: program.id,
      keys: [
        { id: pool.address, signer: false, writable: true }, { id: funder.id, signer: true, writable: true },
        { id: pageAddress(program.id, 0, pageNo).address, signer: false, writable: true }, { id: pageAddress(program.id, 1, pageNo).address, signer: false, writable: true },
        { id: mark.address, signer: false, writable: true }, sysKey,
      ],
      data,
    }], funder, [funder]);
    txs.push({ step: "deposit 0.01 SOL (tag 1)", signature: deposit });
    const mk = await settled(fetchFn, url, mark.address);
    const value = Buffer.from(mk.data.subarray(0, 8)).readBigUInt64LE();
    const nonce = Buffer.from(mk.data.subarray(8, 16)).readBigUInt64LE();
    const scope = scopeOf(program.id, pool.address);
    const label = labelOf(scope, nonce);
    const commitment = be32(poseidon3([value, BigInt("0x" + hex(label)), precommitment]));
    const slot = Number((nonce - 1n) % 1024n) * 72 + 16;
    for (const [tree, want] of [[0, commitment], [1, label]]) {
      const pg = await settled(fetchFn, url, pageAddress(program.id, tree, (nonce - 1n) / 1024n).address, (a) => a.data.length >= slot + 32);
      if (!Buffer.from(pg.data.subarray(slot, slot + 32)).equals(Buffer.from(want))) throw new Error(`page ${tree}'s leaf is not the deposit's`);
    }
    if (value !== DEPOSIT) throw new Error(`the mark reads value ${value}`);
    log(`deposit: mark ${mark.address} value ${value} nonce ${nonce}, precommitment ${hex(pre)}; both leaves match`);
    check("deposit");
    result = {
      cluster, genesis_hash: genesis, rpc: url, at: new Date().toISOString(),
      program_id: program.id, programdata: programDataAddress(program.id), pool: pool.address, scope: hex(scope),
      so_len: so.length, so_sha256: soSha, build: "cargo-build-sbf 4.4.0 (agave v4.4.0), --locked",
      deposit: { value: String(value), nonce: String(nonce), precommitment: hex(pre), label: hex(label), commitment: hex(commitment) },
      funder: funder.id, return_to: returnTo, need: String(need.total), need_parts: Object.fromEntries(Object.entries(need.parts).map(([k, v]) => [k, String(v)])),
    };
  } finally {
    const c = await cleanup(ops, returnTo);
    for (const p of c.problems) log(`cleanup: ${p}`);
    if (c.signature) {
      txs.push({ step: "sweep (the funder's rest back)", signature: c.signature });
      log(`swept ${c.swept} lamports to ${returnTo}: ${c.signature}; the funder holds ${c.after}`);
    } else log(`no sweep sent; the funder holds ${c.after ?? "an unread balance"}`);
    rmSync(dir, { recursive: true, force: true });
    log(`keys removed (${existsSync(dir) ? "STILL THERE" : "gone"})`);
    if (result) Object.assign(result, { funder_after: String(c.after), swept: String(c.swept) });
    if (c.after === null || c.after > FEE_PER_SIGNATURE) result = null;
    process.removeListener("SIGINT", onSignal).removeListener("SIGTERM", onSignal);
  }
  if (!result) throw new Error("the sweep left the funder with more than one fee");
  // one line per transaction: a --prior signature may also be in the program's history
  const seen = new Set();
  result.txs = txs.filter((t) => !seen.has(t.signature) && seen.add(t.signature));
  await waitFinalized(fetchFn, url, result.txs.map((t) => t.signature));
  const outFile = opt("--out", path.join(REPO, `scripts/live-checks/pool-sol-deploy.${cluster}.json`));
  writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  log(`every transaction finalized; wrote ${path.relative(process.cwd(), outFile)}`);
  for (const t of result.txs) log(`tx ${t.step}: ${t.signature}`);
  const rpcArg = cluster === "localnet" ? ` --rpc ${url},${url.replace("127.0.0.1", "localhost")} --deployment ${path.relative(process.cwd(), outFile)}` : "";
  log(`next: node scripts/live-checks/pool-sol-deploy.mjs${rpcArg}${cluster === "devnet" ? " --record /tmp/pool-sol-deploy.devnet-answers.json --write-record" : ""}`);
  return result;
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
