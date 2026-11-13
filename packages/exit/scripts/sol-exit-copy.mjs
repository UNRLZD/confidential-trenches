// Card exit-with-only-the-words: the Solana pool's exit on a local copy of mainnet, with no real money and no test network.
//   node packages/exit/scripts/sol-exit-copy.mjs        (a heavy job: solana-test-validator, through scripts/heavy.sh)
// 1. solana-test-validator clones, from mainnet (read only, nothing is signed or sent there), the release's pool
//    program (contracts/pool-solana/deployments/mainnet.json, as EXIT_SOL_CLUSTERS.mainnet names it), its pool account and
//    every account the program owns, with mainnet's feature set.
// 2. A depositor, a fresh key the copy's faucet funds, deposits one note of the published all-zero words
//    (packages/wallet/test/vectors/a8.json) by the program's own tag 1, built by the kit (solanaPoolDepositTx): no helper.
// 3. The command runs (test/sol-exit-cli.ts: runCli and solExitWith, its RPCs named as the mainnet pair, both reading the
//    copy), given on stdin a fresh typed address X and the words. It says the fee wallet F's address and the amount
//    short; this script sends exactly that amount to F from the faucet (F is never funded before it asks).
// 4. Read on the copy after, never from the command's word: X holds the note less the relay fee and W's own fee, W holds
//    0, the note's spent mark exists, and every tx the command names reads back succeeded.
// SOL_EXIT_PLANT=x expects one lamport more at X, so the run must fail there.
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solanaPoolDepositTx, solanaPoolFee, solanaPoolSpentMark, solanaPoolTreeSizes, solanaRentOf } from "@blindfill/kit";
import { noteSecrets, solanaPoolOf, wordsToSeed64 } from "@blindfill/kit/core";
import { b58encode, solFeeWallet } from "../src/sol-out.ts";
import { EXIT_SOL_CLUSTERS } from "../src/sol-rpc.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VALUE = 50_000_000n; // 0.05 SOL
const MAINNET = "https://api.mainnet-beta.solana.com";
const PROGRAM = EXIT_SOL_CLUSTERS.mainnet.program;
const { pool: POOL, scope: SCOPE } = solanaPoolOf(PROGRAM);
const log = (s) => console.log(`${new Date().toISOString()} sol-exit-copy: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (url, method, params = []) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
};

// 1. the pool program's accounts on mainnet (read only)
const owned = (await rpc(MAINNET, "getProgramAccounts", [PROGRAM, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }])).map((a) => a.pubkey);
if (!owned.includes(POOL)) throw new Error(`mainnet holds no pool account ${POOL} under ${PROGRAM}`);
log(`cloning ${PROGRAM} and its ${owned.length} accounts from mainnet`);
const TMP = mkdtempSync(join(tmpdir(), "sol-exit-copy-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const LOCAL = `http://127.0.0.1:${port}`;
const vargs = ["--ledger", join(TMP, "ledger"), "--reset", "--quiet", "--rpc-port", String(port), "--faucet-port", String(port + 2), "--dynamic-port-range", `${port + 10}-${port + 60}`, "--url", MAINNET, "--clone-feature-set", "--clone-upgradeable-program", PROGRAM, ...owned.flatMap((a) => ["--maybe-clone", a])];
const validator = spawn("solana-test-validator", vargs, { stdio: ["ignore", "pipe", "pipe"] });
let vlog = "";
validator.stdout.on("data", (b) => (vlog += b));
validator.stderr.on("data", (b) => (vlog += b));
let child = null;
process.on("exit", () => {
  try { child?.kill("SIGTERM"); } catch {}
  try { validator.kill("SIGTERM"); } catch {}
  rmSync(TMP, { recursive: true, force: true });
});
const local = (method, params) => rpc(LOCAL, method, params);
for (let i = 0; ; i++) {
  if (validator.exitCode !== null) throw new Error(`the validator stopped: ${vlog.slice(-2000)}`);
  try {
    if ((await local("getHealth")) === "ok") break;
  } catch {}
  if (i > 300) throw new Error(`the validator did not start: ${vlog.slice(-2000)}`);
  await sleep(1_000);
}
log(`copy up on ${LOCAL}: ${JSON.stringify(await local("getVersion"))}`);
const prog = (await local("getAccountInfo", [PROGRAM, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value;
if (!prog?.executable) throw new Error("the pool program is not on the copy");

const confirmed = async (sig, what) => {
  for (let i = 0; i < 120; i++) {
    const st = (await local("getSignatureStatuses", [[sig]])).value[0];
    if (st?.err) throw new Error(`${what} ${sig}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await sleep(500);
  }
  throw new Error(`${what} ${sig}: not confirmed`);
};
const airdrop = async (to, lamports) => confirmed(await local("requestAirdrop", [to, Number(lamports), { commitment: "confirmed" }]), `airdrop to ${to}`);
const balance = async (a) => BigInt((await local("getBalance", [a, { commitment: "confirmed" }])).value);
const ed = () => {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), randomBytes(32)]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  der.fill(0);
  return { key, address: b58encode(new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32))) };
};

// 2. one note of the words, deposited by the program's own tag 1
const seed = wordsToSeed64(WORDS);
const note = noteSecrets(seed, { kind: "deposit", s: SCOPE, i: 0 });
const rentAcc = (await local("getAccountInfo", ["SysvarRent111111111111111111111111111111111", { encoding: "base64" }])).value;
const rent = solanaRentOf({ owner: rentAcc.owner, data: new Uint8Array(Buffer.from(rentAcc.data[0], "base64")) });
const poolAcc = (await local("getAccountInfo", [POOL, { encoding: "base64", commitment: "confirmed" }])).value;
const sizes = solanaPoolTreeSizes({ owner: poolAcc.owner, data: new Uint8Array(Buffer.from(poolAcc.data[0], "base64")) }, PROGRAM);
const depositor = ed();
await airdrop(depositor.address, 1_000_000_000n);
const { blockhash } = (await local("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
const { message, wire } = solanaPoolDepositTx(PROGRAM, depositor.address, { value: VALUE, precommitment: note.precommitment }, sizes, blockhash, rent);
wire.set(sign(null, message, depositor.key), 1);
const depositSig = await confirmed(await local("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]), "deposit");
log(`deposited ${VALUE} lamports on the words' note (scope ${SCOPE}, tree sizes ${JSON.stringify(sizes)}): tx ${depositSig}`);
// the restore reads at finalized: wait until the deposit is final
for (let i = 0; i < 120; i++) {
  if ((await local("getSignatureStatuses", [[depositSig]])).value[0]?.confirmationStatus === "finalized") break;
  await sleep(500);
}

// 3. the command, the typed address and the words on stdin
const X = ed().address;
const fw = solFeeWallet(seed);
fw.secretKey.fill(0);
const F = fw.address;
log(`X = ${X}; F = ${F} holds ${await balance(F)}`);
child = spawn(process.execPath, [join(ROOT, "packages/exit/test/sol-exit-cli.ts"), LOCAL], { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"] });
child.stdin.write(`${X}\n${WORDS}\n`);
child.stdin.end();
let out = "";
let funded = null;
const said = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  out += chunk;
  for (;;) {
    const nl = out.indexOf("\n");
    if (nl < 0) break;
    const line = out.slice(0, nl);
    out = out.slice(nl + 1);
    said.push(line);
    console.log(`  cli| ${line}`);
    const m = line.match(/Send ([0-9.]+) SOL to ([1-9A-HJ-NP-Za-km-z]{32,44}) to pay the fees/);
    if (m && funded === null) {
      if (m[2] !== F) throw new Error(`the command asks to fund ${m[2]}, not F ${F}`);
      const [w, f = ""] = m[1].split(".");
      funded = BigInt(w) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
      airdrop(F, funded).then((s) => log(`sent exactly ${funded} lamports to F: tx ${s}`), (e) => log(`funding F failed: ${e.message}`));
    }
  }
});
const code = await new Promise((done) => child.on("exit", done));
child = null;
log(`the command ended with ${code}`);

// 4. the end state, read on the copy
const done = said.find((l) => l.startsWith("solana: done:"));
const txs = done?.match(/txs (.*)$/)?.[1]?.split(" ") ?? [];
const reads = [];
for (const s of txs) {
  const t = await local("getTransaction", [s, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  reads.push({ tx: s, ok: t !== null && t.meta?.err === null, fee: t?.meta?.fee ?? null, signers: t?.transaction.message.accountKeys.slice(0, t.transaction.message.header.numRequiredSignatures) ?? null });
}
// W: the release's second signer, which the command named as the note's W ("released ... to W")
const W = { address: reads[0]?.signers?.[1] ?? "" };
const fee = solanaPoolFee(rent);
const want = VALUE - fee - 5_000n + (process.env.SOL_EXIT_PLANT === "x" ? 1n : 0n);
const atX = await balance(X);
const mark = (await local("getAccountInfo", [solanaPoolSpentMark(PROGRAM, be32(note.nullifierHash)), { encoding: "base64" }])).value;
const wAfter = await balance(W.address);
seed.fill(0);
const checks = {
  exit0: code === 0,
  funded: funded !== null,
  txsRead: txs.length === 2 && reads.every((r) => r.ok),
  releaseSigners: reads[0]?.signers?.[0] === F && W.address !== "" && said.some((l) => l.includes(`to ${W.address}: tx ${txs[0]}`)),
  onwardSigner: reads[1]?.signers?.length === 1 && reads[1]?.signers?.[0] === W.address,
  xHolds: atX === want,
  wEmpty: wAfter === 0n,
  spentMark: mark !== null && mark.owner === PROGRAM,
};
log(`read back: ${JSON.stringify({ X, atX: atX.toString(), want: want.toString(), relayFee: fee.toString(), W: W.address, wAfter: wAfter.toString(), F, Fafter: (await balance(F)).toString(), spentMark: mark !== null, reads })}`);
log(`checks ${JSON.stringify(checks)}`);
const ok = Object.values(checks).every(Boolean);
log(ok ? "PASS: the words alone brought the note to X" : "FAIL");
process.exit(ok ? 0 : 1);

function be32(x) {
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
}
