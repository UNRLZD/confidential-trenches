// Mainnet copies of a pump.fun bonding curve and a PumpSwap pool, with the venue steps W runs, for the Solana pool's
// LiteSVM tests (card pool-sol-buy-sell). Reads only: nothing is sent to any cluster.
//
// Run from contracts/pool-solana:
//   node fixtures/venues/dump.mjs [--pump <mint>] [--pumpswap <mint>]   writes pump.json, pumpswap.json, programs/*.so
//   node fixtures/venues/dump.mjs --pumpswap <mint> --out <name>.json   writes only that PumpSwap pool, to <name>.json
//                                                                        (pumpswap-cashback.json: CASHBACK_MINT)
//   node fixtures/venues/dump.mjs --programs-only                        re-fetches the ELFs; fails unless each sha256
//                                                                        equals the JSON's
// KIT_DIR: the kit's package folder (default this repo's packages/kit, after `pnpm install`); its readSolanaPoolBuyVenue,
// solanaPoolBuySteps and readSolanaReference build the buy and the expected out.
//
// - Every account is read on two public RPCs at `confirmed`; provider A's copy is written, and the accounts whose two
//   copies differ (moving state) are listed in `providers_differed`.
// - A program's code is its programdata after the 45-byte header, and must hash the same on both providers.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = process.env.KIT_DIR ?? join(HERE, "..", "..", "..", "..", "packages", "kit");
// A PumpSwap pool whose coin is cashback (Pool byte 244 = 1), for the sell from a W with no cashback accounts
// (card signpage-pool-sell): found by getProgramAccounts on api.mainnet-beta, 2026-11-04 11:50Z.
const CASHBACK_MINT = "2hbzoDxzvyspvXhxFkHkuxRNDyo3j2Z6aXUDy1A7pump";
// What to run when mainnet's code no longer hashes as the JSON says: a fresh dump of every fixture, from the repo root.
const REFRESH = "pnpm install --frozen-lockfile && node contracts/pool-solana/fixtures/venues/dump.mjs && " +
  `node contracts/pool-solana/fixtures/venues/dump.mjs --pumpswap ${CASHBACK_MINT} --out pumpswap-cashback.json`;
// VENUE_RPCS and VENUE_RPC_BACKOFF_MS are for dump.test.mjs, which points the script at local fake RPCs.
const RPCS = process.env.VENUE_RPCS ? process.env.VENUE_RPCS.split(",") : ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
// An RPC's error or rate limit is retried 3 times, after 0.5, 1 and 2 s, before the run fails as an RPC failure.
const RETRIES = 3;
const BACKOFF_MS = Number(process.env.VENUE_RPC_BACKOFF_MS ?? 500);
const SPEND = 5_000_000n;
const SLIPPAGE_BPS = 300n;
const PUMP_SELL = [51, 230, 133, 164, 1, 127, 131, 173];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
// --out names one PumpSwap fixture beside the others: a bare lowercase name, never a path, refused before any read.
const OUT = arg("--out");
if (process.argv.includes("--out")) {
  if (typeof OUT !== "string" || !/^[a-z0-9-]{1,40}\.json$/.test(OUT) || OUT === "pump.json") { console.log("FAIL: --out takes a bare name like pumpswap-cashback.json"); process.exit(64); }
  if (!arg("--pumpswap") || process.argv.includes("--pump") || process.argv.includes("--programs-only")) { console.log("FAIL: --out dumps one PumpSwap pool: give --pumpswap <mint> and no other venue"); process.exit(64); }
}

/** An RPC that did not answer, rate-limited or answered with an error, every try: no read of mainnet's code. */
class RpcFailure extends Error {}

async function rpc(url, method, params) {
  let last = "";
  for (let i = 0; i <= RETRIES; i++) {
    if (i > 0) await new Promise((x) => setTimeout(x, BACKOFF_MS * 2 ** (i - 1)));
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!r.ok) { last = `HTTP ${r.status}`; continue; }
      const j = await r.json();
      if (j.error) { last = `error ${JSON.stringify(j.error)}`; continue; }
      return j.result;
    } catch (e) {
      last = String(e?.cause?.code ?? e?.message ?? e);
    }
  }
  throw new RpcFailure(`${url} ${method}: ${last}, after ${RETRIES + 1} tries`);
}

// A program's ELF on one provider: the program account's programdata address (jsonParsed, so no base58 library is
// needed and --programs-only runs on a bare checkout), then that account's data after its 45-byte header.
async function programElf(url, address) {
  const prog = await rpc(url, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!prog?.value?.executable) throw new Error(`${address}: not an executable account on ${url}`);
  const pd = prog.value.data?.parsed?.type === "program" ? prog.value.data.parsed.info.programData : null;
  if (typeof pd !== "string") throw new Error(`${address}: not an upgradeable program account`);
  const pdAcc = await rpc(url, "getAccountInfo", [pd, { encoding: "base64", commitment: "confirmed" }]);
  const data = Buffer.from(pdAcc.value.data[0], "base64");
  if (data.length <= 45 || data.readUInt32LE(0) !== 3) throw new Error(`${pd}: not a programdata account`);
  return data.subarray(45);
}

async function dumpPrograms(addresses) {
  const out = [];
  for (const p of addresses) {
    const elfs = [];
    for (const url of RPCS) elfs.push(await programElf(url, p));
    const hashes = elfs.map(sha);
    if (hashes[0] !== hashes[1]) throw new Error(`${p}: the providers' code differs`);
    const file = `programs/${p}.so`;
    mkdirSync(join(HERE, "programs"), { recursive: true });
    writeFileSync(join(HERE, file), elfs[0]);
    console.log(`program ${p}: ${elfs[0].length} B, sha256 ${hashes[0]} (equal on both providers)`);
    out.push({ address: p, sha256: hashes[0], file });
  }
  return out;
}

// --programs-only exits 0 when every program hashes as the JSON says; 1 when mainnet's code changed (refresh the
// fixtures); 2 when an RPC failed every try (mainnet's code was not read: nothing is known to have changed).
if (process.argv.includes("--programs-only")) {
  const refresh = (why) => {
    console.log(`FAIL (code change): ${why}. Refresh the fixtures from the repo root with: ${REFRESH}`);
    console.log("then run the pool's LiteSVM tests on the new code and commit contracts/pool-solana/fixtures/venues/*.json");
    process.exit(1);
  };
  let bad = 0;
  try {
    // every fixture in this folder: pump.json, pumpswap.json and any --out one
    for (const name of readdirSync(HERE).filter((f) => f.endsWith(".json")).sort()) {
      const fx = JSON.parse(readFileSync(join(HERE, name), "utf8"));
      const got = await dumpPrograms(fx.programs.map((p) => p.address));
      for (const p of fx.programs) {
        const g = got.find((x) => x.address === p.address);
        if (g.sha256 !== p.sha256) { bad++; console.log(`MISMATCH ${name} ${p.address}: json ${p.sha256}, chain ${g.sha256}`); }
      }
    }
  } catch (e) {
    if (e instanceof RpcFailure) {
      console.log(`FAIL (RPC, not a code change): ${e.message}. Mainnet's code was not read, so nothing is known to have changed: run the job again.`);
      process.exit(2);
    }
    refresh(e.message);
  }
  if (bad) refresh(`${bad} program(s) changed on mainnet since the dump`);
  console.log("PASS: every program's sha256 equals the JSON's");
  process.exit(0);
}

const kreq = createRequire(pathToFileURL(join(KIT_DIR, "package.json")));
const { base58 } = await import(pathToFileURL(kreq.resolve("@scure/base")).href);
const kit = await import(pathToFileURL(join(KIT_DIR, "src/index.ts")).href);
// program ids from the kit, never retyped
const PUMP = kit.SOLANA_PUMP_PROGRAM, AMM = kit.SOLANA_PUMP_AMM_PROGRAM, FEES = kit.SOLANA_PUMP_FEES_PROGRAM;
const SYSTEM = kit.SOLANA_SYSTEM_PROGRAM;
const BUILTINS = [SYSTEM, kit.SOLANA_TOKEN_PROGRAM, kit.SOLANA_TOKEN_2022_PROGRAM, kit.SOLANA_ATA_PROGRAM];
const KNOWN_PROGRAMS = [PUMP, AMM, FEES];
if ([...BUILTINS, ...KNOWN_PROGRAMS].some((k) => typeof k !== "string" || base58.decode(k).length !== 32)) throw new Error("the kit does not export a program id");
const poolFx = JSON.parse(readFileSync(process.env.POOL_FIXTURE ?? join(HERE, "..", "release-spends.json"), "utf8"));
const W = base58.encode(Buffer.from(poolFx.w, "hex"));
const providers = RPCS.map((url) => (method, params) => rpc(url, method, params));

const hexOf = (b) => Buffer.from(b).toString("hex");
const stepJson = (s) => ({ program: s.program, accounts: s.accounts.map((a) => ({ address: a.key, signer: a.signer, writable: a.writable })), data: hexOf(s.data) });
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return [...b]; };
const pda = (seeds, program) => kit.solanaProgramAddress(seeds, program);
const enc = (s) => new TextEncoder().encode(s);

// W's pump `sell` of `amount` tokens for at least 1 lamport, with the accounts @pump-fun/pump-sdk 4.3.1
// getSellInstructionRaw passes (IDL `sell`, then remaining: W's volume accumulator only for a cashback coin,
// bonding-curve-v2, the buyback recipient writable).
function pumpSell(venue, wallet, amount, cashback) {
  const tp = venue.tokenProgram;
  const a = (key, signer, writable) => ({ key, signer, writable });
  return {
    program: PUMP,
    accounts: [
      a(pda([enc("global")], PUMP), false, false),
      a(venue.feeRecipient, false, true),
      a(venue.mint, false, false),
      a(venue.curve, false, true),
      a(kit.solanaAta(venue.curve, venue.mint, tp), false, true),
      a(kit.solanaAta(wallet, venue.mint, tp), false, true),
      a(wallet, true, true),
      a(SYSTEM, false, false),
      a(pda([enc("creator-vault"), base58.decode(venue.creator)], PUMP), false, true),
      a(tp, false, false),
      a(pda([enc("__event_authority")], PUMP), false, false),
      a(PUMP, false, false),
      a(pda([enc("fee_config"), base58.decode(PUMP)], FEES), false, false),
      a(FEES, false, false),
      ...(cashback ? [a(pda([enc("user_volume_accumulator"), base58.decode(wallet)], PUMP), false, true)] : []),
      a(pda([enc("bonding-curve-v2"), base58.decode(venue.mint)], PUMP), false, false),
      a(venue.buybackFeeRecipient, false, true),
    ],
    data: Uint8Array.from([...PUMP_SELL, ...u64le(amount), ...u64le(1n)]),
  };
}

// W's PumpSwap `sell` of `amount` base tokens for at least 1 lamport, as @pump-fun/pump-sdk 4.3.1 offlinePumpAmm.ts
// sellInstructionsNoPool builds it: the IDL's 21 accounts are the buy's first 19 and its fee config and fee program
// (no volume accumulators); remaining: for a cashback pool W's volume accumulator's wSOL account and the accumulator,
// pool-v2 when the coin has a creator, the buyback recipient and its wSOL account. Around it: W's wSOL account made
// again (the buy closed it) and closed after, so W ends with plain SOL.
function pumpswapSell(buySteps, venue, wallet, amount) {
  const [createWsol, , , , buy, closeWsol] = buySteps;
  if (buy.program !== AMM || buy.accounts.length < 25) throw new Error("the buy step is not PumpSwap's buy_exact_quote_in");
  const a = (key, signer, writable) => ({ key, signer, writable });
  const vol = pda([enc("user_volume_accumulator"), base58.decode(wallet)], AMM);
  const rest = buy.accounts.slice(23);
  const remaining = venue.cashback
    ? [a(kit.solanaAta(vol, kit.SOLANA_SOL_MINT, kit.SOLANA_TOKEN_PROGRAM), false, true), a(vol, false, true), ...rest.slice(1)]
    : rest;
  const sell = {
    program: AMM,
    accounts: [...buy.accounts.slice(0, 19), ...buy.accounts.slice(21, 23), ...remaining],
    data: Uint8Array.from([...PUMP_SELL, ...u64le(amount), ...u64le(1n)]),
  };
  return [createWsol, sell, closeWsol];
}

async function dumpVenue(kind, mint) {
  const venue = await kit.readSolanaPoolBuyVenue(providers, kind, mint, () => 0);
  const ref = await kit.readSolanaReference(providers, { side: "buy", token: mint, amount: SPEND });
  const refPool = ref?.pools.find((p) => p.venue === kind);
  if (!refPool) throw new Error(`${kind} ${mint}: no reference read on two providers`);
  const expectedOut = refPool.expectedOut;
  const minOut = (expectedOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const buy = kit.solanaPoolBuySteps(venue, W, SPEND, minOut);
  let sell = [];
  if (kind === "pump-curve") {
    // the curve's is_cashback_coin: after the discriminator (8), five u64 reserves (40), complete (1), creator (32),
    // is_mayhem_mode (1), at byte 82 (pump IDL BondingCurve)
    const curve = await rpc(RPCS[0], "getAccountInfo", [venue.curve, { encoding: "base64", commitment: "confirmed" }]);
    const cb = Buffer.from(curve.value.data[0], "base64")[82];
    if (cb !== 0 && cb !== 1) throw new Error("the curve's cashback flag is not a bool");
    sell = [pumpSell(venue, W, minOut, cb === 1)];
  } else {
    sell = pumpswapSell(buy, venue, W, minOut);
  }
  const steps = [...buy, ...sell];
  const programs = [...new Set(steps.map((s) => s.program))];
  const named = [...new Set(steps.flatMap((s) => s.accounts.map((a) => a.key)))];
  const unknown = programs.filter((p) => !BUILTINS.includes(p) && !KNOWN_PROGRAMS.includes(p));
  if (unknown.length) throw new Error(`a step invokes an unknown program: ${unknown.join(",")}`);
  const venueProgram = kind === "pump-curve" ? PUMP : AMM;
  const nonBuiltin = [venueProgram, FEES];
  // every named account but W, the programs and the builtins; kept only when it exists and is not executable
  const toRead = named.filter((k) => k !== W && !BUILTINS.includes(k) && !nonBuiltin.includes(k));
  const accounts = [];
  const differed = [];
  let slot = null;
  for (let i = 0; i < toRead.length; i += 10) {
    const list = toRead.slice(i, i + 10);
    const [a, b] = await Promise.all(RPCS.map((url) => rpc(url, "getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])));
    if (slot === null) slot = a.context.slot;
    list.forEach((k, j) => {
      const va = a.value[j], vb = b.value[j];
      if (JSON.stringify(va) !== JSON.stringify(vb)) differed.push(k);
      if (!va) { if (vb) console.log(`  ${k}: none on provider A, present on B (provider A's absence used)`); return; }
      if (va.executable) throw new Error(`${k}: an executable account the steps name that is not a known program`);
      accounts.push({ address: k, owner: va.owner, lamports: String(va.lamports), data: va.data[0], executable: false });
    });
  }
  // the chain time of the read slot (an empty slot has none: the nearest block before it)
  let unix = null;
  for (let s = slot; unix === null && s > slot - 50; s--) {
    try { unix = await rpc(RPCS[0], "getBlockTime", [s]); } catch { unix = null; }
  }
  if (unix === null) throw new Error(`no block time near slot ${slot}`);
  const progs = await dumpPrograms(nonBuiltin);
  const out = {
    venue: kind, mint, token_program: venue.tokenProgram,
    read_at: new Date().toISOString(), unix_timestamp: String(unix), slot: String(slot),
    providers: RPCS, wallet: W,
    spend: String(SPEND), min_out: String(minOut), expected_out: String(expectedOut),
    accounts, programs: progs, builtins: BUILTINS,
    buy: buy.map(stepJson), sell: sell.map(stepJson),
    providers_differed: differed,
  };
  const file = OUT ?? (kind === "pump-curve" ? "pump.json" : "pumpswap.json");
  writeFileSync(join(HERE, file), JSON.stringify(out, null, 1) + "\n");
  console.log(`${file}: ${mint}, slot ${slot}, time ${unix}, ${accounts.length} accounts (${differed.length} differed between providers: ${differed.join(",") || "none"}), E ${expectedOut}, min out ${minOut}, ${buy.length} buy step(s), ${sell.length} sell step(s)`);
}

if (OUT) {
  await dumpVenue("pumpswap", arg("--pumpswap"));
  if (!existsSync(join(HERE, OUT))) process.exit(1);
} else {
  await dumpVenue("pump-curve", arg("--pump") ?? "FGmQ6Csma7PPdYyoQT7Pw38cqCPg8Y7GxBKjspXKpump");
  await dumpVenue("pumpswap", arg("--pumpswap") ?? "9rZR9nCQbaiBvotWVpifN8z1vckVFshnsATuAJrXpump");
  if (!existsSync(join(HERE, "pump.json")) || !existsSync(join(HERE, "pumpswap.json"))) process.exit(1);
}
