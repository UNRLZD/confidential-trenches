// A deposit, buy, sell and withdraw of the Solana pool on a local copy of mainnet, with no real money.
//   <heavy.sh> sol-copy -- node packages/signpage/scripts/sol-mainnet-copy.mjs <out.json> [curve=<mint>] [mayhem=<mint>] [graduated=<mint>]
// - Picks one coin of each kind (an open bonding curve, a Mayhem curve, a graduated PumpSwap coin) from the helper's
//   GET /v1/market/lists?chain=solana unless given, each classified by its own accounts read on mainnet.
// - Reads, on public mainnet RPCs only and paced (read-only: nothing is signed or sent there), every account the pool
//   buy and sell name: the pool program and its pool, pages and lookup table, the pump.fun and PumpSwap programs, their
//   globals, fee configs and every fee, buyback and reserved (Mayhem) recipient, the eight Jito tip accounts, the token
//   programs, and each coin's mint, curve or pool and their token accounts. They load into solana-test-validator with
//   mainnet's feature set (--clone-feature-set); the upgradeable programs are cloned by the validator itself.
// - Then, for each coin, the signing page's own pool flow (packages/signpage/scripts/pool-flow-devnet.mjs, FLOW_COPY:
//   the mainnet build, its pins, its tip, the helper's own sender pointed at the copy, its block engine a local stand-in)
//   runs deposit, buy and sell, and pool-withdraw-devnet.mjs runs a tag 2 withdraw of the sell's return note to a plain
//   address. Every transaction is read back from the copy into the record: per coin and step its signature, its
//   result, compute units used against the limit it set, the last log lines on a failure.
// - SOL_COPY_ENGINE (./copy-net.mjs): the engine stand-in's answer to the helper's bundle: swallow (the default: takes it
//   and never lands it), busy, refused, or lands. The record keeps the helper's send line and the ms from the page's
//   send to filled.
// - A graduated coin runs on a PumpSwap lookup table the copy makes (copyTable: mainnet has none yet), named only in
//   that run's table argument.
// - SOL_COPY_ONLY=<kind,...> runs those kinds only; SOL_COPY_STEPS=buy stops each after its buy.
// - SOL_COPY_PLANT=mayhem-drop: the Mayhem coin's buy is built with its curve read as not Mayhem, so the buy names the
//   plain fee recipient in place of the Mayhem one; the run must fail with pump's own error.
// - Keys are made fresh for the copy and live only in the run's temp folder, removed at the end.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { RENT_FEATURES, clonePlan, listCandidates, pendingFeature, txRecord } from "./sol-mainnet-copy-parse.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const [OUT, ...given] = process.argv.slice(2);
if (!OUT) throw new Error("usage: sol-mainnet-copy.mjs <out.json> [curve=<mint>] [mayhem=<mint>] [graduated=<mint>]");
const ONLY = (process.env.SOL_COPY_ONLY ?? "").split(",").filter(Boolean);
const PLANT = process.env.SOL_COPY_PLANT ?? "";
const STEPS = process.env.SOL_COPY_STEPS ?? "all"; // "buy": deposit and buy only
// the helper's block engine stand-in (./copy-net.mjs): swallow (takes the bundle, never lands it), busy, refused, lands
const ENGINE = process.env.SOL_COPY_ENGINE ?? "swallow";
if (!["swallow", "busy", "refused", "lands"].includes(ENGINE)) throw new Error(`SOL_COPY_ENGINE: swallow, busy, refused or lands, not ${ENGINE}`);
const log = (s) => console.log(`${new Date().toISOString()} copy: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { solanaPoolAddresses, solanaDecodeBondingCurve } = await import("../../kit/src/trade/solana/pool.ts");
const { readSolanaPoolBuyVenue, solanaPoolBuySteps, solanaPoolSellSteps } = await import("../../kit/src/trade/solana/pool-buy.ts");
const { SOLANA_JITO_TIP_ACCOUNTS, SOLANA_PUMP_PROGRAM, SOLANA_PUMP_AMM_PROGRAM } = await import("../../kit/src/checks/solana/checks.ts");
const { solanaJsonRpc } = await import("../../kit/src/trade/solana/send.ts");
const DEPLOY = JSON.parse(readFileSync(join(ROOT, "contracts/pool-solana/deployments/mainnet.json"), "utf8"));

// public mainnet RPCs, read only, each paced to one request a second
const MAINNET = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const paced = (url) => {
  const rpc = solanaJsonRpc(url);
  let next = 0;
  const p = async (method, params) => {
    const wait = next - Date.now();
    next = Math.max(Date.now(), next) + 1_000;
    if (wait > 0) await sleep(wait);
    return rpc(method, params);
  };
  p.url = url;
  return p;
};
const main = MAINNET.map(paced);
let mainnetReads = 0;
const many = async (keys) => {
  const out = [];
  let slot = null;
  for (let i = 0; i < keys.length; i += 100) {
    mainnetReads++;
    const r = await main[0]("getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }]);
    slot ??= r.context?.slot ?? null;
    out.push(...r.value);
  }
  return { slot, value: out };
};

// 1. the coins
const coins = Object.fromEntries(given.map((g) => g.split("=")).map(([k, v]) => [k, { mint: v, list: "given" }]));
const KINDS = ["curve", "mayhem", "graduated"].filter((k) => ONLY.length === 0 || ONLY.includes(k));
let candidates = [];
if (KINDS.some((k) => !coins[k])) {
  const lists = await (await fetch("https://ct-api.unrealized.trade/v1/market/lists?chain=solana", { headers: { origin: "https://ct.unrealized.trade" } })).json();
  const cands = listCandidates(lists).slice(0, 120);
  const reads = [];
  for (let i = 0; i < cands.length && KINDS.some((k) => !coins[k] && reads.filter((r) => r.kind === k).length < 4); i += 30) {
    const part = cands.slice(i, i + 30);
    const keys = part.flatMap((c) => { const a = solanaPoolAddresses(c.mint); return [a.curve, a.pool]; });
    const { value } = await many(keys);
    part.forEach((c, j) => {
      const [curve, pool] = [value[2 * j], value[2 * j + 1]];
      let kind = null;
      if (curve && curve.owner === SOLANA_PUMP_PROGRAM) {
        const bc = solanaDecodeBondingCurve({ owner: curve.owner, data: Buffer.from(curve.data[0], "base64") });
        if (!bc.complete) kind = bc.isMayhemMode ? "mayhem" : "curve";
        else if (pool && pool.owner === SOLANA_PUMP_AMM_PROGRAM) kind = "graduated";
      }
      reads.push({ ...c, kind });
    });
  }
  candidates = reads;
}
// each kind's first coin whose venue the kit builds (a curve quoted in another coin than SOL is one it does not)
const skipped = [];
const venues = {};
for (const k of KINDS) {
  const list = coins[k] ? [coins[k]] : candidates.filter((r) => r.kind === k);
  coins[k] = null;
  for (const c of list) {
    try {
      venues[k] = await readSolanaPoolBuyVenue(main, k === "graduated" ? "pumpswap" : "pump-curve", c.mint, () => 0);
      coins[k] = { mint: c.mint, list: c.list, symbol: c.symbol ?? "" };
      break;
    } catch (e) {
      skipped.push({ kind: k, mint: c.mint, why: String(e?.message ?? e).slice(0, 160) });
    }
  }
}
log(`skipped ${JSON.stringify(skipped)}`);
log(`coins ${JSON.stringify(coins)}`);

// 2. what to clone: the pool's own accounts and table, the tip accounts, and each coin's buy and sell accounts
const DUMMY = [0, 1].map(() => base58.encode(ed25519.getPublicKey(randomBytes(32))));
const keysOf = (ixs) => ixs.flatMap((x) => [x.programId ?? x.program, ...x.accounts.map((a) => a.pubkey ?? a.key)]).filter(Boolean);
const { solanaAta: solanaAtaOf } = await import("../../kit/src/checks/solana/message.ts");
const want = new Set([...DEPLOY.table_addresses, DEPLOY.table, DEPLOY.program_id, ...SOLANA_JITO_TIP_ACCOUNTS, SOLANA_PUMP_AMM_PROGRAM]);
for (const [kind, c] of Object.entries(coins)) {
  if (!c || !KINDS.includes(kind)) continue;
  const venue = venues[kind];
  const a = solanaPoolAddresses(c.mint);
  const perW = DUMMY.map((w) => new Set([...keysOf(solanaPoolBuySteps(venue, w, 1n, 0n)), ...keysOf(solanaPoolSellSteps(venue, w, 1n, 1n))]));
  for (const k of perW[0]) if (perW[1].has(k)) want.add(k);
  for (const k of [...a.curveList, ...a.poolList, ...venue.buybackFeeRecipients]) want.add(k);
  // a PumpSwap buy pays its buyback fee into the recipient's wSOL account, and the page picks one of the eight at random:
  // PumpSwap makes a missing one at the buyer's cost, which a copy missing it would show as W short of rent
  if (venue.kind === "pumpswap") for (const r of venue.buybackFeeRecipients) want.add(solanaAtaOf(r, "So11111111111111111111111111111111111111112", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
}
// pump Global's and PumpSwap GlobalConfig's 8 reserved (Mayhem) recipients each, and their wSOL accounts
const { solanaAta } = await import("../../kit/src/checks/solana/message.ts");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const glob = await many([solanaPoolAddresses(SOL_MINT).pumpGlobal, solanaPoolAddresses(SOL_MINT).ammGlobalConfig]);
const keysAt = (b64, first, rest) => {
  const d = Buffer.from(b64, "base64");
  return [first, ...Array.from({ length: 7 }, (_, i) => rest + 32 * i)].map((o) => base58.encode(d.subarray(o, o + 32)));
};
const reserved = [...keysAt(glob.value[0].data[0], 483, 516), ...keysAt(glob.value[1].data[0], 385, 418)];
for (const r of reserved) want.add(r), want.add(solanaAta(r, SOL_MINT, TOKEN));
// every account the pool program owns on mainnet (its pool, pages and every deposit's and release's mark): a settle
// counts the marks against the leaves, so a copy missing one mark refuses every later settle
mainnetReads++;
for (const a of await main[0]("getProgramAccounts", [DEPLOY.program_id, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }])) want.add(a.pubkey);
const keys = [...want];
const read = await many(keys);
const plan = clonePlan(keys, read.value);
log(`clone at mainnet slot ${read.slot}: ${plan.files.length} accounts, ${plan.programs.length} programs (${plan.programs.join(", ")}), ${plan.missing.length} absent on mainnet, tables reset ${plan.resets.join(", ") || "none"}`);

// mainnet's Rent sysvar, which the copy must hold before anything runs
const RENT = "SysvarRent111111111111111111111111111111111";
mainnetReads++;
const mainRent = Buffer.from((await main[0]("getAccountInfo", [RENT, { encoding: "base64", commitment: "confirmed" }])).value.data[0], "base64").subarray(0, 17).toString("hex");

// 3. the copy
const TMP = mkdtempSync(join(tmpdir(), "sol-copy-"));
const ACC = join(TMP, "accounts");
mkdirSync(ACC, { mode: 0o700 });
for (const f of plan.files) writeFileSync(join(ACC, `${f.pubkey}.json`), JSON.stringify(f));
// The rent: a validator's genesis gives 6,960 lamports a byte, and a feature active in genesis never runs its change to
// the Rent sysvar, which only an activation at an epoch boundary does. So the features that set mainnet's lamports per
// byte (SIMD-0437-1, 6,333, then SIMD-0437-2, 5,080; solana feature status -um, 11 Nov 18:37Z) start pending, and the
// copy's 32-slot epochs activate them within seconds; the run waits until the copy's Rent sysvar is mainnet's bytes.
for (const f of RENT_FEATURES) writeFileSync(join(ACC, `${f}.json`), JSON.stringify(pendingFeature(f)));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const vargs = ["--ledger", join(TMP, "ledger"), "--reset", "--quiet", "--rpc-port", String(port), "--faucet-port", String(port + 2), "--dynamic-port-range", `${port + 10}-${port + 60}`, "--url", MAINNET[0], "--clone-feature-set", "--slots-per-epoch", "32", ...RENT_FEATURES.flatMap((f) => ["--deactivate-feature", f]), "--account-dir", ACC, ...plan.programs.flatMap((p) => ["--clone-upgradeable-program", p])];
log(`solana-test-validator on port ${port}`);
const validator = spawn("solana-test-validator", vargs, { stdio: ["ignore", "pipe", "pipe"] });
let vlog = "";
validator.stdout.on("data", (b) => (vlog += b));
validator.stderr.on("data", (b) => (vlog += b));
const URLS = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const local = async (method, params = []) => {
  const r = await fetch(URLS[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
};
const stop = () => {
  try { validator.kill("SIGTERM"); } catch {}
};
process.on("exit", () => {
  stop();
  rmSync(TMP, { recursive: true, force: true });
});
for (let i = 0; ; i++) {
  if (validator.exitCode !== null) throw new Error(`the validator stopped: ${vlog.slice(-2000)}`);
  try {
    if ((await local("getHealth")) === "ok") break;
  } catch {}
  if (i > 240) throw new Error(`the validator did not start: ${vlog.slice(-2000)}`);
  await sleep(1_000);
}
let copyRent = null;
for (let i = 0; i < 120; i++) {
  copyRent = Buffer.from((await local("getAccountInfo", [RENT, { encoding: "base64" }])).value.data[0], "base64").subarray(0, 17).toString("hex");
  if (copyRent === mainRent) break;
  await sleep(1_000);
}
if (copyRent !== mainRent) throw new Error(`the copy's rent ${copyRent} is not mainnet's ${mainRent}`);
// the copy's clock: its confirmed and finalized slots and their block times, against this machine's clock
const clockRead = async () => {
  const [c, f] = [await local("getSlot", [{ commitment: "confirmed" }]), await local("getSlot", [{ commitment: "finalized" }])];
  return { wallMs: Date.now(), confirmed: { slot: c, time: await local("getBlockTime", [c]) }, finalized: { slot: f, time: await local("getBlockTime", [f]) } };
};
const clock = [await clockRead()];
log(`copy clock ${JSON.stringify(clock[0])}`);
const version = await local("getVersion");
log(`copy up: ${JSON.stringify(version)}`);
// every cloned program is there and executable
const progRead = await local("getMultipleAccounts", [plan.programs, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
const progMissing = plan.programs.filter((_, i) => !progRead.value[i]?.executable);
if (progMissing.length) throw new Error(`programs not cloned: ${progMissing.join(", ")}`);

// the helper's fee payer on the copy: a fresh key in TMP, funded by the copy's own airdrop
const fpSeed = randomBytes(32);
const fpPub = ed25519.getPublicKey(fpSeed);
const FP = base58.encode(fpPub);
const fpFile = join(TMP, "fee-payer.key");
writeFileSync(fpFile, base58.encode(Buffer.concat([fpSeed, Buffer.from(fpPub)])), { mode: 0o600 });
fpSeed.fill(0);
const airdrop = async (to, lamports) => {
  const sig = await local("requestAirdrop", [to, lamports, { commitment: "confirmed" }]);
  for (let i = 0; i < 60; i++) {
    const st = (await local("getSignatureStatuses", [[sig]])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await sleep(500);
  }
  throw new Error(`airdrop to ${to} not confirmed`);
};
await airdrop(FP, 10_000_000_000);
log(`fee payer ${FP} funded on the copy`);

clock.push(await clockRead());
log(`copy clock ${JSON.stringify(clock[1])}`);
// The PumpSwap table: mainnet has none yet (the mainnet build pins the pump curve's alone, so the page refuses a
// graduated coin venue_not_pinned), so the copy makes one the way contracts/pool-solana/scripts/venue-table.mjs would
// on mainnet: the kit's list for the venue and the pool's next range, created, extended and frozen by tableSteps, from
// a key the copy funds. Only this run's table argument names it, never a product file.
async function copyTable(venue) {
  const vt = await import("../../../contracts/pool-solana/scripts/venue-table.mjs");
  const { pda, le } = await import("../../../scripts/live-checks/pool-sol-deploy.mjs");
  const kit = await import("../../kit/src/trade/solana/pool-buy.ts");
  const { solanaPoolTreeSizes } = await import("../../kit/src/trade/solana/pool-deposit.ts");
  const { solanaCompileV0 } = await import("../../kit/src/trade/solana/build.ts");
  const { solanaDecodeMessage } = await import("../../kit/src/checks/solana/message.ts");
  const { solanaJsonRpc: rpcOf } = await import("../../kit/src/trade/solana/send.ts");
  const providers = [rpcOf(URLS[0]), rpcOf(URLS[1])];
  const cfg = { program: DEPLOY.program_id, pool: DEPLOY.pool };
  const tv = await kit.readSolanaPoolTableVenue(providers, venue);
  const pa = (await local("getAccountInfo", [DEPLOY.pool, { encoding: "base64", commitment: "finalized" }])).value;
  const t = solanaPoolTreeSizes({ owner: pa.owner, data: new Uint8Array(Buffer.from(pa.data[0], "base64")) }, DEPLOY.program_id);
  const range = kit.solanaPoolNextTableRange(cfg, tv, { state: t.stateSize, label: t.labelSize });
  const list = kit.solanaPoolVenueTableList(cfg, tv, range);
  const key = randomBytes(32);
  const pub = ed25519.getPublicKey(key);
  const funder = base58.encode(pub);
  await airdrop(funder, 1_000_000_000);
  const slot = await vt.recentSlot(local);
  const at = pda([pub, le(slot, 8)], ALT_PROGRAM);
  const sigs = [];
  for (const st of vt.tableSteps(funder, at.address, slot, at.bump, list, 0n)) {
    const { blockhash } = (await local("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
    // deploy.mjs's instruction shape ({ program, keys: [{ id, signer, writable }], data }) as the kit compiles it
    const ixs = st.ixs.map((x) => ({ program: x.program, accounts: x.keys.map((k) => ({ key: k.id, signer: k.signer, writable: k.writable })), data: Uint8Array.from(x.data) }));
    const { message } = solanaCompileV0(funder, ixs, blockhash, [], [funder]);
    const m = solanaDecodeMessage(message);
    const wire = new Uint8Array(1 + 64 * m.requiredSignatures + message.length);
    wire[0] = m.requiredSignatures;
    wire.set(ed25519.sign(message, key), 1);
    wire.set(message, 1 + 64 * m.requiredSignatures);
    const sig = await local("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    for (let i = 0; ; i++) {
      const v = (await local("getSignatureStatuses", [[sig]])).value[0];
      if (v?.err) throw new Error(`${st.step}: ${JSON.stringify(v.err)}`);
      if (v?.confirmationStatus === "finalized") break;
      if (i > 120) throw new Error(`${st.step}: not finalized`);
      await sleep(500);
    }
    sigs.push({ step: st.step, signature: sig });
  }
  key.fill(0);
  await sleep(1_000); // the addresses of the last extend serve from the next slot
  return { venue, table: at.address, range, addresses: list.length, txs: sigs };
}
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const madeTables = {};

// 4. each coin's run, through the page's own flow and withdraw drivers
const cfg = join(TMP, "copy.json");
const records = [];
const runs = {};
const runNode = (args, env) =>
  new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => ((out += b), process.stdout.write(b)));
    p.stderr.on("data", (b) => ((out += b), process.stderr.write(b)));
    p.on("exit", (code) => done({ code, out }));
  });
for (const kind of KINDS) {
  const c = coins[kind];
  if (!c) {
    records.push({ coin: kind, step: "pick", ok: false, err: "no live coin of this kind in the helper's lists" });
    continue;
  }
  const dir = join(TMP, kind);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(cfg, JSON.stringify({ rpcs: URLS, feePayerKeyFile: fpFile, dir, mint: c.mint, engine: ENGINE, plant: kind === "mayhem" ? PLANT : "" }));
  const flowOut = join(dir, "flow.json");
  log(`${kind} ${c.mint}: deposit, buy${STEPS === "buy" ? "" : ", sell"}`);
  // a graduated coin runs on the copy's own PumpSwap table, with the pump curve's pinned one
  let tables = "pinned";
  if (kind === "graduated") {
    madeTables.pumpswap ??= await copyTable("pumpswap");
    log(`the copy's PumpSwap table ${JSON.stringify(madeTables.pumpswap)}`);
    tables = `pump-curve=${DEPLOY.table},pumpswap=${madeTables.pumpswap.table}`;
  }
  const flow = await runNode(["packages/signpage/scripts/pool-flow-devnet.mjs", tables, c.mint, "max", flowOut], { FLOW_COPY: cfg, ...(STEPS === "buy" ? { FLOW_COPY_STOP: "buy" } : {}) });
  const f = existsSync(flowOut) ? JSON.parse(readFileSync(flowOut, "utf8")) : null;
  runs[kind] = { exit: flow.code, flow: f, tail: flow.out.split("\n").slice(-30) };
  let withdraw = null;
  if (STEPS !== "buy" && f?.filled && f.seedFile) {
    const to = base58.encode(ed25519.getPublicKey(randomBytes(32)));
    const wOut = join(dir, "withdraw.json");
    log(`${kind}: tag 2 withdraw of the return note to the plain address ${to}`);
    const w = await runNode(["packages/signpage/scripts/pool-withdraw-devnet.mjs", to, "max", wOut], { FLOW_COPY: cfg, FLOW_RESUME: f.seedFile });
    withdraw = existsSync(wOut) ? JSON.parse(readFileSync(wOut, "utf8")) : null;
    runs[kind].withdraw = { exit: w.code, out: withdraw, to, tail: w.out.split("\n").slice(-30) };
  }
  // every transaction read back from the copy
  const steps = [...(f?.steps ?? []), ...(withdraw?.steps ?? [])];
  let W = null;
  const seen = new Set();
  for (const s of steps) {
    if (seen.has(s.signature)) continue; // a rebroadcast of the same transaction
    seen.add(s.signature);
    const tx = await local("getTransaction", [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    // W: the buy's second key (the release pays W, which signs the buy)
    if (s.step === "buy" && tx) W = tx.transaction.message.accountKeys[1];
    records.push(txRecord(kind, s.step, s.signature, tx, { ...(s.watch ?? {}), W }, (x) => base58.decode(x)));
  }
  for (const s of [...(f?.simFails ?? []), ...(withdraw?.simFails ?? [])]) records.push({ coin: kind, step: s.phase, ok: false, simulation: s });
  if (f && !f.filled) records.push({ coin: kind, step: "flow", ok: false, exit: flow.code, buyAnswer: f.buy?.answer ?? null, sellAnswer: f.sell?.answer ?? null });
  // the buy's send as the helper logged it, and the ms from the page's send to its fill (the buy's timeline)
  const tl = f?.buyTimeline ?? [];
  const sendAt = tl.find((x) => x.what.startsWith("helper POST /v1/pool/solana/send"));
  const filledAt = tl.find((x) => x.what === "progress filled");
  runs[kind].proofWait = f?.proofWait ?? null;
  runs[kind].buySend = { lines: (f?.sendLines ?? []).filter((x) => x.phase === "buy").map((x) => x.line), sendStartMs: sendAt?.at ?? null, helperMs: sendAt?.ms ?? null, filledMs: filledAt?.at ?? null, sendToFilledMs: sendAt && filledAt ? filledAt.at - sendAt.at : null, engineCalls: f?.engineCalls ?? [] };
  log(`${kind} buy send: ${JSON.stringify(runs[kind].buySend)}`);
  if (withdraw && !withdraw.sent) records.push({ coin: kind, step: "withdraw", ok: false, op: withdraw.op ?? null, view: withdraw.view?.state ?? null, tail: runs[kind].withdraw.tail.slice(-8) });
  if (!f) records.push({ coin: kind, step: "flow", ok: false, exit: flow.code, tail: flow.out.split("\n").slice(-15) });
}
const record = {
  at: new Date().toISOString(),
  what: "deposit, buy, sell and withdraw of the Solana pool on a local copy of mainnet (solana-test-validator, mainnet's feature set, mainnet accounts cloned)",
  validator: version,
  mainnetSlot: read.slot,
  rent: { mainnet: mainRent, copy: copyRent },
  clock,
  mainnetReads,
  plant: PLANT || null,
  copyTables: madeTables,
  engine: ENGINE,
  coins,
  skippedCoins: skipped,
  cloned: { accounts: plan.files.map((f) => f.pubkey), programs: plan.programs, absentOnMainnet: plan.missing, tablesReset: plan.resets },
  records,
  runs,
  cannotShow: [
    "whether a block builder or a leader includes the transaction: the copy has no Jito block engine and one leader, itself; the helper's engine is a local stand-in (busy, refused, swallowing or landing the bundle) and its plain copies go to the copy",
    "the real engines' answers and their timing: the stand-in answers at once",
    "a graduated coin's buy on mainnet's own PumpSwap table: mainnet has none yet, so the copy makes one with the same list (contracts/pool-solana/scripts/venue-table.mjs's steps) from a key it funds",
    "priority fee levels: the copy's only transactions are the run's own, so no fee market",
    "rate limits of real providers: the page reads the copy's one RPC under two names",
    "the helper's mainnet fee payer: the copy's fee payer is a fresh local key (the pool program binds the fee payer only through the proof's context, release.rs, so any key it signs with is accepted)",
    "mainnet's slot and clock: the copy starts near slot 0 on this machine's clock; accounts are as of the clone slot",
  ],
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
log(`record ${OUT}: ${records.map((r) => `${r.coin}/${r.step} ${r.ok ? "ok" : "FAIL"}`).join(", ")}`);
// the plant fails only with pump's own refusal of the buy, in the program's log
const pumpRefused = (r) => r.coin === "mayhem" && r.step === "buy" && !r.ok && (r.simulation?.logsTail ?? r.logsTail ?? []).some((l) => l.includes(`Program ${SOLANA_PUMP_PROGRAM} failed`));
const plantOk = PLANT ? records.some(pumpRefused) : true;
if (PLANT) log(`plant ${PLANT}: ${plantOk ? "the buy failed with pump's own error" : "NOT refused by pump"}`);
process.exit(records.length > 0 && (PLANT ? plantOk : records.every((r) => r.ok)) ? 0 : 1);
