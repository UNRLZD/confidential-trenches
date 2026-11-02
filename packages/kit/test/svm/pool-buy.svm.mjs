// LiteSVM proof of card sol-pool-buy-tx: one transaction, signed by the fee payer and W, releases a chunk from the
// Blindfill pool on Solana and buys on pump.fun or PumpSwap with W as the venue's user; W ends holding the tokens.
//
// Run (keyless mainnet reads only, nothing is sent to any cluster):
//   LITESVM_DIR=<a folder with `npm i --no-package-lock litesvm@1.5.0`> \
//   POOL_SO=<blindfill_pool_solana.so from pool-sol-core, cargo-build-sbf> \
//   POOL_FIXTURE=<contracts/pool-solana/fixtures/release-spends.json> \
//   node packages/kit/test/svm/pool-buy.svm.mjs pump-curve|pumpswap <mint> [--record <file>]
//
// - Every program and account the buy touches is read on two public RPCs (getMultipleAccounts at `confirmed`); the
//   programs' bytes must hash the same on both, and the copy LiteSVM runs is provider A's.
// - The pool is pool-sol-core's program at the fixture's test id, made and given the fixture's six deposits; the
//   release is the fixture's "release" spend (a real proof bound to the test W and fee payer).
// - The kit builds, checks and the test keys sign: readSolanaReference and readSolanaPoolBuyVenue answer from the
//   recorded reads of the two providers, buildSolanaPoolBuy builds shape A, checkSolanaPoolBuy must pass on it and
//   refuse it with min_out changed.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [venueKind, mint] = process.argv.slice(2);
const recordAt = process.argv.indexOf("--record");
if (!["pump-curve", "pumpswap"].includes(venueKind) || !mint) throw new Error("usage: pool-buy.svm.mjs pump-curve|pumpswap <mint>");
const need = (k) => process.env[k] ?? (() => { throw new Error(`${k} is not set`); })();
const req = createRequire(pathToFileURL(need("LITESVM_DIR") + "/package.json"));
const { LiteSVM, FailedTransactionMetadata } = await import(pathToFileURL(req.resolve("litesvm")).href);
const kitSol = await import(pathToFileURL(req.resolve("@solana/kit")).href);
const kit = await import(new URL("../../src/index.ts", import.meta.url).href);
const kreq = createRequire(new URL("../../package.json", import.meta.url));
const { base58, base64 } = await import(pathToFileURL(kreq.resolve("@scure/base")).href);
const { ed25519 } = await import(pathToFileURL(kreq.resolve("@noble/curves/ed25519.js")).href);
const { sha256 } = await import(pathToFileURL(kreq.resolve("@noble/hashes/sha2.js")).href);

const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const b58 = (b) => base58.encode(b);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (...a) => console.log(...a);

async function rpc(url, method, params) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await new Promise((x) => setTimeout(x, 800 * (i + 1))); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${url} ${method}: rate limited`);
}
// getMultipleAccounts on both providers: the kit's own reads are recorded per list (--record) for the unit tests
const recorded = [new Map(), new Map()];
async function readBoth(list) {
  const out = [];
  for (const url of RPCS) out.push(await rpc(url, "getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }]));
  return out;
}
const replay = (p) => {
  const f = async (method, params) => {
    if (method !== "getMultipleAccounts") throw new Error(`replayed provider has no ${method}`);
    const k = JSON.stringify(params[0]);
    if (!recorded[p].has(k)) {
      const ans = await rpc(RPCS[p], "getMultipleAccounts", [params[0], { encoding: "base64", commitment: "confirmed" }]);
      recorded[p].set(k, ans);
    }
    return recorded[p].get(k);
  };
  return f;
};

// ------------------------------------------------------------------ the test keys and the pool fixture
const fx = JSON.parse(readFileSync(need("POOL_FIXTURE"), "utf8"));
const seed = (name) => sha256(enc("pool-sol-core/test-key/" + name));
const keyOf = (name) => ({ seed: seed(name), address: b58(ed25519.getPublicKey(seed(name))) });
const W = keyOf("W");
const FEE_PAYER = keyOf("FEE_PAYER");
if (hex(base58.decode(W.address)) !== fx.w || hex(base58.decode(FEE_PAYER.address)) !== fx.fee_payer) throw new Error("the test keys are not the fixture's");
const PROGRAM = b58(unhex(fx.program));
const POOL = b58(unhex(fx.pool));
if (kit.solanaPoolAccount(PROGRAM) !== POOL) throw new Error("the pool PDA is not the fixture's");
const spend = fx.spends.find((s) => s.name === "release");
const release = {
  proof: unhex(spend.proof), newCommitmentHash: unhex(spend.new_commitment), existingNullifierHash: unhex(spend.nullifier_hash),
  withdrawnValue: BigInt(spend.withdrawn), stateRootIndex: spend.state_root_index, stateTreeDepth: spend.state_depth,
  labelRootIndex: spend.label_root_index, labelTreeDepth: spend.label_depth, relayFee: 2_000_000n,
  relayFeeCap: BigInt(fx.relay_fee_cap), tipCap: BigInt(fx.tip_cap), deadlineMs: BigInt(fx.deadline_ms), salt: unhex(spend.salt),
};

// ------------------------------------------------------------------ mainnet copies
const providers = [replay(0), replay(1)];
const venue = await kit.readSolanaPoolBuyVenue(providers, venueKind, mint);
log("venue (equal on both providers):", JSON.stringify(venue));
const cfg = { program: PROGRAM, pool: POOL };
const SPEND = 5_000_000n;
const ref = await kit.readSolanaReference(providers, { side: "buy", token: mint, amount: SPEND });
const refPool = ref?.pools.find((p) => p.venue === venueKind);
if (!refPool) throw new Error("no reference read for the venue");
const SLIPPAGE_BPS = 300;
const minOut = (refPool.expectedOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
log(`reference E for ${SPEND} lamports: ${refPool.expectedOut} (both providers' depth ${refPool.depth.join(" / ")}); min out ${minOut}`);

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
// The Jito tip (lamports from W, at most the proof's tip cap); POOL_BUY_TIP=0 builds without one.
const TIP = BigInt(process.env.POOL_BUY_TIP ?? "10000");
const req0 = { wallet: W.address, feePayer: FEE_PAYER.address, token: mint, spend: SPEND, minOut, tip: TIP, cuPrice: 100_000n };
const tableAccounts = kit.solanaPoolBuyTableAccounts(cfg, venue, kit.solanaPoolPages(PROGRAM, 7, 6));
// every account of the instructions, to copy from mainnet (the pool's and W's own are made in LiteSVM)
const ixsProbe = kit.solanaPoolBuyInstructions(cfg, release, venue, req0, 6, kit.SOLANA_JITO_TIP_ACCOUNTS[0]);
const local = new Set([POOL, W.address, FEE_PAYER.address, PROGRAM, ...ixsProbe[2].accounts.map((a) => a.key)]);
const touched = [...new Set(ixsProbe.flatMap((x) => [x.program, ...x.accounts.map((a) => a.key)]))].filter((k) => !local.has(k));
const programs = [venueKind === "pump-curve" ? PUMP : AMM, FEES];
const accounts = new Map();
for (let i = 0; i < touched.length; i += 10) {
  const list = touched.slice(i, i + 10);
  const [a, b] = await readBoth(list);
  list.forEach((k, j) => {
    const va = a.value[j], vb = b.value[j];
    const same = JSON.stringify(va) === JSON.stringify(vb);
    accounts.set(k, va);
    log(`  read ${k.slice(0, 8)}… ${va ? `${va.owner.slice(0, 6)}… ${base64.decode(va.data[0]).length} B` : "none"}${same ? "" : " (providers differ: moving state; provider A's copy used)"}`);
  });
}
// a program's code: the program account names its programdata; the code is programdata after its 45-byte header
const code = new Map();
for (const p of programs) {
  const hashes = [];
  for (const url of RPCS) {
    const prog = await rpc(url, "getAccountInfo", [p, { encoding: "base64", commitment: "confirmed" }]);
    const pd = b58(base64.decode(prog.value.data[0]).subarray(4, 36));
    const pdAcc = await rpc(url, "getAccountInfo", [pd, { encoding: "base64", commitment: "confirmed" }]);
    const elf = base64.decode(pdAcc.value.data[0]).subarray(45);
    hashes.push(sha(elf));
    if (!code.has(p)) code.set(p, elf);
  }
  if (hashes[0] !== hashes[1]) throw new Error(`${p}: the providers' code differs`);
  log(`  program ${p.slice(0, 8)}… ${code.get(p).length} B, sha256 ${hashes[0].slice(0, 16)}… on both`);
}

// ------------------------------------------------------------------ LiteSVM
const svm = new LiteSVM();
const addr = kitSol.address;
svm.addProgramFromFile(addr(PROGRAM), need("POOL_SO"));
for (const [p, elf] of code) svm.addProgram(addr(p), elf);
for (const [k, v] of accounts) {
  if (!v || programs.includes(k) || v.executable) continue;
  svm.setAccount({ address: addr(k), lamports: kitSol.lamports(BigInt(v.lamports)), programAddress: addr(v.owner), executable: false, data: base64.decode(v.data[0]), space: BigInt(base64.decode(v.data[0]).length) });
}
const now = Math.floor(Date.now() / 1000);
const clock = svm.getClock();
clock.unixTimestamp = BigInt(now);
svm.setClock(clock);
svm.warpToSlot(1000n);
const depositor = await kitSol.generateKeyPairSigner();
svm.airdrop(depositor.address, kitSol.lamports(10_000_000_000n));
svm.airdrop(addr(FEE_PAYER.address), kitSol.lamports(1_000_000_000n));
const SYS = "11111111111111111111111111111111";
const R = kitSol.AccountRole;
async function sendKit(label, ixs) {
  svm.expireBlockhash();
  const tx = await kitSol.pipe(kitSol.createTransactionMessage({ version: 0 }), (t) => kitSol.setTransactionMessageFeePayerSigner(depositor, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t), (t) => kitSol.appendTransactionMessageInstructions(ixs, t),
    (t) => kitSol.signTransactionMessageWithSigners(t));
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) { console.log(r.meta().logs().join("\n")); throw new Error(`${label}: ${r.err()}`); }
}
await sendKit("init", [{ programAddress: addr(PROGRAM), accounts: [{ address: addr(POOL), role: R.WRITABLE }, { address: depositor.address, role: R.WRITABLE_SIGNER, signer: depositor }, { address: addr(SYS), role: R.READONLY }], data: Uint8Array.of(0) }]);
for (const [i, d] of fx.deposits.entries()) {
  const pre = unhex(d.precommitment);
  const data = Uint8Array.from([1, ...new Uint8Array(new BigUint64Array([BigInt(d.value)]).buffer), ...pre]);
  await sendKit(`deposit ${i}`, [{ programAddress: addr(PROGRAM), data, accounts: [
    { address: addr(POOL), role: R.WRITABLE }, { address: depositor.address, role: R.WRITABLE_SIGNER, signer: depositor },
    { address: addr(kit.solanaPoolPage(PROGRAM, 0, i)), role: R.WRITABLE }, { address: addr(kit.solanaPoolPage(PROGRAM, 1, i)), role: R.WRITABLE },
    { address: addr(kit.solanaProgramAddress([enc("pre"), pre], PROGRAM)), role: R.WRITABLE }, { address: addr(SYS), role: R.READONLY }] }]);
}
log(`pool: init and ${fx.deposits.length} deposits (fixture), state size 6`);
// our lookup table: the program-wide accounts, active from the slot after its last extension
const tableAddr = (await kitSol.generateKeyPairSigner()).address;
const meta = new Uint8Array(56);
const dv = new DataView(meta.buffer);
dv.setUint32(0, 1, true);
dv.setBigUint64(4, (1n << 64n) - 1n, true);
dv.setBigUint64(12, 1n, true);
const tableData = Uint8Array.from([...meta, ...tableAccounts.flatMap((k) => [...base58.decode(k)])]);
svm.setAccount({ address: tableAddr, lamports: kitSol.lamports(10_000_000n), programAddress: addr("AddressLookupTab1e1111111111111111111111111"), executable: false, data: tableData, space: BigInt(tableData.length) });
const table = kit.solanaDecodeLookupTable(tableData);

// ------------------------------------------------------------------ build, check, sign, send
const signSend = (message) => {
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  wire.set(ed25519.sign(message, FEE_PAYER.seed), 1);
  wire.set(ed25519.sign(message, W.seed), 65);
  return svm.sendTransaction(kitSol.getTransactionDecoder().decode(wire));
};
const tokenAmount = () => {
  const tok = svm.getAccount(addr(kit.solanaAta(W.address, mint, venue.tokenProgram)));
  return tok.exists === false ? 0n : new DataView(tok.data.buffer, tok.data.byteOffset).getBigUint64(64, true);
};
const blockhash = svm.latestBlockhash();
if (process.argv.includes("--split")) {
  // Not the product: shape A on PumpSwap is 1,408 bytes, so it waits for tag 3. This splits it in two transactions, the
  // release and then W's buy, only to run the kit's PumpSwap instructions against mainnet's code with W as the user.
  const all = kit.solanaPoolBuyInstructions(cfg, release, venue, req0, 6, null);
  const head = all.slice(0, 2);
  const one = kit.solanaCompileV0(FEE_PAYER.address, [...head, all[2]], blockhash, [{ address: tableAddr, table }], [FEE_PAYER.address, W.address]).message;
  const r1 = signSend(one);
  if (r1 instanceof FailedTransactionMetadata) { log(r1.meta().logs().join("\n")); log(`split release: FAIL ${r1.err()}`); process.exit(1); }
  svm.expireBlockhash();
  const two = kit.solanaCompileV0(FEE_PAYER.address, [...head, ...all.slice(3)], svm.latestBlockhash(), [{ address: tableAddr, table }], [FEE_PAYER.address, W.address]);
  log(`split: release ${1 + 128 + one.length} B, then buy ${1 + 128 + two.message.length} B`);
  const r2 = signSend(two.message);
  if (r2 instanceof FailedTransactionMetadata) { log(r2.meta().logs().join("\n")); log(`split buy: FAIL ${r2.err()}`); process.exit(1); }
  const cu = r2.logs().filter((l) => l.startsWith(`Program ${AMM} consumed`)).map((l) => l.match(/consumed (\d+)/)[1]).join("+");
  const amount = tokenAmount();
  log(`split buy: OK; PumpSwap CU ${cu}; W holds ${amount} of ${mint} (min out ${minOut}, E ${refPool.expectedOut}); W's wrapped SOL account ${svm.getAccount(addr(kit.solanaAta(W.address, kit.SOLANA_SOL_MINT, kit.SOLANA_TOKEN_PROGRAM))).exists === false ? "closed" : "open"}`);
  if (amount < minOut || amount === 0n) { log("FAIL: W holds less than min out"); process.exit(1); }
  if (recordAt > 0) writeFileSync(process.argv[recordAt + 1], JSON.stringify({ venueKind, mint, providers: RPCS, reads: [Object.fromEntries(recorded[0]), Object.fromEntries(recorded[1])] }, null, 1) + "\n");
  log("PASS (split)");
  process.exit(0);
}
const built = kit.buildSolanaPoolBuy(cfg, release, venue, req0, { blockhash, lastValidBlockHeight: 1_000_000, table: { address: tableAddr, table }, stateSize: 6 }, { pick: () => 0 });
const reads = { tables: { [tableAddr]: [{ owner: "AddressLookupTab1e1111111111111111111111111", data: tableData }, { owner: "AddressLookupTab1e1111111111111111111111111", data: tableData }] }, stateSize: 6, reference: { amount: SPEND, ref, slippageBps: SLIPPAGE_BPS } };
const verdict = kit.checkSolanaPoolBuy(built.wire, cfg, release, venue, req0, reads);
log(`built shape A: ${built.size} B, ${built.instructions.length} instructions; check ${verdict.ok ? "PASS" : "FAIL"}`);
for (const r of verdict.results) log(`  ${r.ok ? "ok  " : "FAIL"} ${r.id}: ${r.detail}`);
if (!verdict.ok) process.exit(1);
// the same transaction with min_out lowered by one: the check refuses it
const bent = kit.buildSolanaPoolBuy(cfg, release, venue, { ...req0, minOut: minOut - 1n }, { blockhash, lastValidBlockHeight: 1_000_000, table: { address: tableAddr, table }, stateSize: 6 }, { pick: () => 0 });
const bentVerdict = kit.checkSolanaPoolBuy(bent.wire, cfg, release, venue, req0, reads);
log(`min_out changed: check ${bentVerdict.ok ? "PASS (wrong)" : "FAIL (refused): " + bentVerdict.results.filter((r) => !r.ok).map((r) => r.id).join(",")}`);
if (bentVerdict.ok) process.exit(1);

const wire = built.wire.slice();
wire.set(ed25519.sign(built.message, FEE_PAYER.seed), 1);
wire.set(ed25519.sign(built.message, W.seed), 65);
const tx = kitSol.getTransactionDecoder().decode(wire);
const ata = kit.solanaAta(W.address, mint, venue.tokenProgram);
const before = svm.getBalance(addr(W.address)) ?? 0n;
const t0 = performance.now();
const r = svm.sendTransaction(tx);
const ms = performance.now() - t0;
if (r instanceof FailedTransactionMetadata) {
  log(r.meta().logs().join("\n"));
  log(`release and buy: FAIL ${r.err()}`);
  process.exit(1);
}
const logs = r.logs();
const cuOf = (p) => logs.filter((l) => l.startsWith(`Program ${p} consumed`)).map((l) => l.match(/consumed (\d+)/)[1]).join("+");
const tok = svm.getAccount(addr(ata));
const amount = new DataView(tok.data.buffer, tok.data.byteOffset).getBigUint64(64, true);
const spent = svm.getAccount(addr(kit.solanaPoolSpentMark(PROGRAM, release.existingNullifierHash)));
log(`release and buy: OK in ${ms.toFixed(1)} ms; CU total ${r.computeUnitsConsumed()} (pool ${cuOf(PROGRAM)}, venue ${cuOf(venueKind === "pump-curve" ? PUMP : AMM)})`);
log(`W ${W.address}: ${amount} of ${mint} (min out ${minOut}, E ${refPool.expectedOut}); W lamports ${before} -> ${svm.getBalance(addr(W.address))}; spent mark ${spent?.exists === false || !spent ? "missing" : "made"}`);
if (amount < minOut || amount === 0n) { log("FAIL: W holds less than min out"); process.exit(1); }
// the same release again: the spent mark refuses it
svm.expireBlockhash();
const again = kit.buildSolanaPoolBuy(cfg, release, venue, req0, { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000, table: { address: tableAddr, table }, stateSize: 7 }, { pick: () => 0 });
const w2 = again.wire.slice();
w2.set(ed25519.sign(again.message, FEE_PAYER.seed), 1);
w2.set(ed25519.sign(again.message, W.seed), 65);
const r2 = svm.sendTransaction(kitSol.getTransactionDecoder().decode(w2));
log(`the same proof again: ${r2 instanceof FailedTransactionMetadata ? "FAIL (refused) " + r2.err() : "OK (wrong)"}`);
if (!(r2 instanceof FailedTransactionMetadata)) process.exit(1);
if (recordAt > 0) writeFileSync(process.argv[recordAt + 1], JSON.stringify({ venueKind, mint, providers: RPCS, reads: [Object.fromEntries(recorded[0]), Object.fromEntries(recorded[1])] }, null, 1) + "\n");
log("PASS");
