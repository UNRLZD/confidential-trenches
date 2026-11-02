// Self-check of the venue fixtures (card pool-sol-buy-sell): loads pump.json or pumpswap.json into LiteSVM (mainnet's
// accounts and program code as dumped), funds W with 13,000,000 lamports, runs the buy steps top-level in one
// transaction W signs and pays, then the sell steps in a second one. Nothing is sent to any cluster.
//
//   LITESVM_DIR=<a folder with `npm i --no-package-lock litesvm@1.5.0`> node fixtures/venues/check.mjs pump.json|pumpswap.json
//
// W's key is the pool fixture's test key "W": ed25519 seed sha256("pool-sol-core/test-key/W"), a published test key.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!["pump.json", "pumpswap.json"].includes(name)) throw new Error("usage: check.mjs pump.json|pumpswap.json");
const dir = process.env.LITESVM_DIR ?? (() => { throw new Error("LITESVM_DIR is not set"); })();
const req = createRequire(pathToFileURL(join(dir, "package.json")));
const { LiteSVM, FailedTransactionMetadata } = await import(pathToFileURL(req.resolve("litesvm")).href);
const k = await import(pathToFileURL(req.resolve("@solana/kit")).href);

const fx = JSON.parse(readFileSync(join(HERE, name), "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const seed = createHash("sha256").update("pool-sol-core/test-key/W").digest();
const W = await k.createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
if (W.address !== fx.wallet) throw new Error("the fixture's wallet is not the test key W");

const svm = new LiteSVM();
for (const p of fx.programs) {
  const elf = readFileSync(join(HERE, p.file));
  if (sha(elf) !== p.sha256) throw new Error(`${p.file}: sha256 is not the fixture's`);
  svm.addProgram(k.address(p.address), elf);
}
for (const a of fx.accounts) {
  const data = Buffer.from(a.data, "base64");
  svm.setAccount({ address: k.address(a.address), lamports: k.lamports(BigInt(a.lamports)), programAddress: k.address(a.owner), executable: false, data: new Uint8Array(data), space: BigInt(data.length) });
}
svm.warpToSlot(BigInt(fx.slot));
const clock = svm.getClock();
clock.unixTimestamp = BigInt(fx.unix_timestamp);
svm.setClock(clock);
svm.airdrop(W.address, k.lamports(13_000_000n));

const toIx = (s) => ({
  programAddress: k.address(s.program),
  accounts: s.accounts.map((a) => ({ address: k.address(a.address), role: a.signer ? (a.writable ? k.AccountRole.WRITABLE_SIGNER : k.AccountRole.READONLY_SIGNER) : a.writable ? k.AccountRole.WRITABLE : k.AccountRole.READONLY, ...(a.signer ? { signer: W } : {}) })),
  data: new Uint8Array(Buffer.from(s.data, "hex")),
});
// CU of each top-level instruction, from the logs ("consumed" at invoke depth 1; a builtin that logs none shows "-")
function cuPerStep(logs, steps) {
  const out = [];
  let depth = 0, cur = null;
  for (const l of logs) {
    const inv = l.match(/^Program (\S+) invoke \[(\d+)\]$/);
    if (inv) { depth = Number(inv[2]); if (depth === 1) cur = { program: inv[1], cu: "-" }; continue; }
    const used = l.match(/^Program (\S+) consumed (\d+) of/);
    if (used && depth === 1 && cur && used[1] === cur.program) cur.cu = used[2];
    if (/^Program \S+ (success|failed)/.test(l)) { if (depth === 1 && cur) { out.push(cur); cur = null; } depth--; }
  }
  return steps.map((s, i) => `${i}:${s.program.slice(0, 6)}… ${out[i]?.cu ?? "?"}`).join(", ");
}
async function send(label, steps) {
  svm.expireBlockhash();
  const msg = k.pipe(k.createTransactionMessage({ version: 0 }), (t) => k.setTransactionMessageFeePayerSigner(W, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t), (t) => k.appendTransactionMessageInstructions(steps.map(toIx), t));
  const tx = await k.signTransactionMessageWithSigners(msg);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) { console.log(r.meta().logs().join("\n")); console.log(`${label}: FAIL ${r.err()}`); process.exit(1); }
  console.log(`${label}: OK, CU total ${r.computeUnitsConsumed()}; per step ${cuPerStep(r.logs(), steps)}`);
}
// W's token account: the ATA the first buy step creates (its account 1)
const ata = fx.buy.find((s) => s.accounts.length === 6 && s.accounts[3].address === fx.mint).accounts[1].address;
const tokens = () => {
  const a = svm.getAccount(k.address(ata));
  return !a || a.exists === false ? 0n : Buffer.from(a.data).readBigUInt64LE(64);
};
const lamportsW = () => BigInt(svm.getBalance(W.address) ?? 0n);

console.log(`${fx.venue} ${fx.mint} at slot ${fx.slot} (time ${fx.unix_timestamp}); spend ${fx.spend}, E ${fx.expected_out}, min out ${fx.min_out}`);
const w0 = lamportsW();
await send("buy", fx.buy);
const got = tokens();
const w1 = lamportsW();
console.log(`after the buy: W holds ${got} of ${fx.mint} (min out ${fx.min_out}, E ${fx.expected_out}); W lamports ${w0} -> ${w1}`);
if (got < BigInt(fx.min_out) || got === 0n) { console.log("FAIL: W holds less than min out"); process.exit(1); }
if (fx.sell.length) {
  await send("sell", fx.sell);
  const w2 = lamportsW();
  console.log(`after the sell: W holds ${tokens()} of ${fx.mint}; W gained ${w2 - w1} lamports on the sell (net of the 5,000 fee)`);
  if (w2 <= w1) { console.log("FAIL: the sell paid W nothing"); process.exit(1); }
}
console.log("PASS");
