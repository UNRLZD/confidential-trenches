#!/usr/bin/env node
// Live check of card signpage-pool-flow: the devnet pool the signing page's testnet build pins (SOL_POOLS.devnet,
// packages/wallet/src/pool/solana.ts) is the deployed one. The pins are not read from the wallet:
//   - the program and pool are those of contracts/pool-solana's devnet deployment record
//     (scripts/live-checks/pool-sol-deploy.devnet.json, read by devnetPin); a replay is judged on today's record too, so
//     a recording on another program or pool FAILs;
//   - on two devnet RPCs of two operators, pool-sol-deploy's own check passes for that program:
//     - an executable upgradeable-loader program with its upgrade authority none, and the build's code;
//     - the pool account the program's, with the record's deposit in its trees;
//     - the run's funder emptied.
//   - SIGN_HOST (https://confidential.unrealized.trade) serves the mainnet build: its /app.js carries none of the
//     testnet build's pins or providers (TESTNET_ONLY).
// - The run (card signpage-pool-flow-run, scripts/live-checks/signpage-pool-flow.md), on both devnet RPCs at finalized:
//   - the lookup table run 7's buy loaded (RUN_TABLE; the testnet build's curve table until card sol-pool-venue-tables
//     pinned each venue's generations from contracts/pool-solana/deployments/devnet.json): the ALT program's, the same bytes on both, active, holding the
//     pool and both trees' first pages;
//   - the deposit: succeeded, a call of the pinned program on the pool;
//   - the pool buy: succeeded, a call of the pinned program and of pump.fun, paid by the helper's devnet fee payer (the
//     pin) and loading the table;
//   - the sell back: succeeded, a call of pump.fun and of the pinned program on the pool, paid by the buy's W alone.
//   - the helper's own GET /v1/pool/fee for the pool names the pin's program and fee payer.
// - Card signpage-pool-flow-answers: a read that answers null names the provider's own answer (its HTTP status, the null
//   and its context slot), a JSON-RPC error its code and message; a 429 is read again after its Retry-After; a null at
//   a slot behind the other provider's value is read again within the walk's bound (onTwoOperators), the same slot never.
// After: sign
//   node scripts/live-checks/signpage-pool-flow.mjs [--program <id>] [--table <id>] [--record <file>]
// --program or --table reads another account in the pin's place (the recorded bad answers). PASS exit 0, FAIL exit 1,
// error exit 2.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRecord } from "./sol-pool-venue-tables.mjs";
import { DEVNET_PROVIDERS, RETRY_AFTER_CAP_MS, account, answerOf, check as deployCheck, onTwoOperators, operatorOf, pageAddress, poolAddress, programDataAddress, recorder, retryAfterMs, rpc, devnetPin } from "./pool-sol-deploy.mjs";

const KEY = "signpage-pool-flow";
/** SOL_POOLS.devnet in the testnet build: its program and pool are today's deploy record's (devnetPin), its fee payer
 *  the helper's devnet one. */
export const PIN = Object.freeze({
  program: devnetPin().program,
  feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb",
  pool: devnetPin().pool,
});
/** The lookup table run 7's buy loaded (below): the testnet build's curve table then, retired from the build since card
 *  sol-pool-venue-tables (the wallet's SOL_POOL_TABLES.devnet pins deployments/devnet.json's generations). */
export const RUN_TABLE = "6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ";
/** Every lookup table the testnet build pins: each venue's generations in contracts/pool-solana/deployments/devnet.json
 *  (packages/wallet/test/sol-pool-venue-tables.test.ts holds the build's pins equal to it). */
export const DEVNET_TABLES = Object.freeze(
  Object.values(readRecord("devnet")?.tables ?? {}).flatMap((gens) => gens.map((g) => g.table)),
);
/** Run 7's transactions (signpage-pool-flow.md): the deposit, the pool buy and the sell back, through the page's testnet
 *  flow, on today's devnet pool (program 9Z6Yi2Vc, pool 92YuYhb4) and the helper serving it. */
export const RUN = Object.freeze({
  deposit: "53ppgpzgRj1Ler5byRWVpUhxgXRizaEtnkYBuQjoSWXH1KAk9xyVkhrphgWkigWCVakKuEs1z2h7ErHXo2rr8jTx",
  buy: "2r3panFRXsEE4K4duP9juAXpVjLpzQPNetEDUmyowJ8EbDq6wWbPPQs3eoRjBCSDoU5jrKbNZ14SQMtXv3wCWnD7",
  sell: "2BATzt6gAKUzhgTUvoUs3keMEAyLZW3x1M3VeWzLNpqqnRjCEssGv3LzFmcZrSpueDVYdQgToYuDPAyztN87u3Ty",
});
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const HELPER = "https://ct-api.unrealized.trade";

export const SIGN = "https://confidential.unrealized.trade";
/** What only the testnet build carries: the devnet pins and the testnet RPC hosts (src/pool-testnet.ts). */
export const TESTNET_ONLY = Object.freeze([PIN.program, PIN.feePayer, ...DEVNET_TABLES, "api.devnet.solana.com", "/v1/rpc/solana-devnet", "sepolia.base.org", "base-sepolia-rpc.publicnode.com", "rpc.testnet.chain.robinhood.com", "robinhood-sepolia-rpc.publicnode.com"]);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** A GET read again on a 429 or a 5xx, three tries at most, after its Retry-After when it gives one (at most
 * RETRY_AFTER_CAP_MS), else 1.5 s more each time; the last answer is the read's. */
export async function getRead(fetchFn, url, sleep = sleepMs, tries = 3) {
  for (let i = 1; ; i++) {
    const r = await fetchFn(url);
    if (!(r.status === 429 || r.status >= 500) || i >= tries) return r;
    await sleep(Math.min(retryAfterMs(r) ?? 1500 * i, RETRY_AFTER_CAP_MS));
  }
}

/** SIGN_HOST's /app.js: its status and which of TESTNET_ONLY it carries. */
export async function readSign(fetchFn = fetch, sleep = sleepMs) {
  const r = await getRead(fetchFn, `${SIGN}/app.js`, sleep);
  const text = await r.text();
  return { status: r.status, bytes: text.length, found: TESTNET_ONLY.filter((s) => text.includes(s)) };
}

/** The helper's GET /v1/pool/fee for the pinned pool: its status and answer. */
export async function readHelper(fetchFn = fetch, sleep = sleepMs) {
  const r = await getRead(fetchFn, `${HELPER}/v1/pool/fee?pool=${PIN.pool}`, sleep);
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** A transaction at finalized on one RPC: its error, its static keys, its tables and the programs it calls. Read as
 * base64 and decoded here (a v0 or legacy message), so the recorded answer names no table under a key-like field. */
async function txOf(fetchFn, url, sig, sleep) {
  const t = await rpc(fetchFn, url, "getTransaction", [sig, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }], ...(sleep ? [sleep] : []));
  if (!t) return null;
  const m = message(Buffer.from(t.transaction[0], "base64"));
  const keys = [...m.keys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
  const calls = [...m.programs, ...(t.meta?.innerInstructions ?? []).flatMap((x) => x.instructions.map((ix) => ix.programIdIndex))].map((i) => keys[i]);
  return { err: t.meta ? t.meta.err : "no meta", payer: m.keys[0], signers: m.signers, keys, tables: m.tables, calls: [...new Set(calls)] };
}

/** A wire transaction's message: its signer count, its static keys, each instruction's program index and its lookup tables. */
function message(b) {
  let o = 0;
  const compact = () => {
    let n = 0;
    for (let s = 0; ; s += 7) {
      const x = b[o++];
      n |= (x & 0x7f) << s;
      if (!(x & 0x80)) return n;
    }
  };
  const skip = (n) => void (o += n); // compact() moves o: read the length before adding it
  skip(64 * compact());
  const v0 = (b[o] & 0x80) !== 0;
  if (v0) o++;
  const signers = b[o];
  o += 3;
  const keys = Array.from({ length: compact() }, () => b58(b.subarray(o, (o += 32))));
  o += 32;
  const programs = Array.from({ length: compact() }, () => {
    const p = b[o++];
    skip(compact());
    skip(compact());
    return p;
  });
  const tables = v0
    ? Array.from({ length: compact() }, () => {
        const k = b58(b.subarray(o, (o += 32)));
        skip(compact());
        skip(compact());
        return k;
      })
    : [];
  if (o !== b.length) throw new Error(`a transaction of ${b.length} bytes parsed to ${o}`);
  return { signers, keys, programs, tables };
}

/** The run's reads: the table and the run's transactions on the first two devnet operators that answer
 * (onTwoOperators: one that is out moves the read to the next, fewer than two FAILs), and the helper's fee answer. */
async function checkRun({ pin, pinTable, table, fetchFn, rpcs, sleep, helper }, say) {
  // each read that answers null keeps the provider's own answer (answerOf: its HTTP status, the null and its slot), and
  // a JSON-RPC error FAILs on the provider that answered it, named
  const walk = await onTwoOperators(rpcs, (u) => operatorOf(u, "devnet"), fetchFn, async (u, say, fetchFn) => {
    const txs = {}, said = {};
    let read = null;
    try {
      for (const [name, sig] of Object.entries(RUN)) {
        txs[name] = await txOf(fetchFn, u, sig, sleep);
        if (!txs[name]) said[name] = `${answerOf(fetchFn, "getTransaction", sig)} on ${u}`;
      }
      read = await account(fetchFn, u, table, sleep);
      if (!read) said.table = `${answerOf(fetchFn, "getAccountInfo", table)} on ${u}`;
    } catch (e) {
      if (e?.transient) throw e;
      say(false, `read on ${u}: ${String(e.message).split("\n")[0]}`);
    }
    return { table: read, txs, said };
  }, ...(sleep ? [{ sleep }] : []));
  for (const [pass, text] of walk.lines) say(pass, text);
  const reads = walk.values.map((v) => v.table);
  const same = reads[0] && reads[1] && Buffer.from(reads[0].data).equals(Buffer.from(reads[1].data));
  const d = reads[0]?.data;
  const addrs = d && d.length >= 56 ? Array.from({ length: (d.length - 56) / 32 }, (_, i) => b58(d.subarray(56 + 32 * i, 88 + 32 * i))) : [];
  const active = d && d.length >= 56 && Buffer.from(d.subarray(4, 12)).equals(Buffer.alloc(8, 0xff));
  const need = [pin.pool, pageAddress(pin.program, 0, 0).address, pageAddress(pin.program, 1, 0).address];
  say(table === pinTable, `the table read is the pin's: ${table}`);
  say(reads.every((r) => r?.owner === ALT_PROGRAM) && same && active && need.every((a) => addrs.includes(a)), `table ${table}: the ALT program's, the same bytes on both RPCs, active, holding the pool and both first pages: ${walk.values.map((v) => v.table?.owner ?? v.said.table ?? "not read").join(", ")}, ${addrs.length} addresses`);
  let w = null; // the buy's W: its second static key (the fee payer first)
  for (const [name, sig] of Object.entries(RUN)) {
    const txs = walk.values.map((v) => v.txs[name]);
    const saidOf = walk.values.map((v) => v.said[name] ?? "not read");
    const ok = txs.length === 2 && txs.every((t) => t && t.err === null && t.calls.includes(pin.program) && t.keys.includes(pin.pool));
    if (name === "buy") w = txs[0]?.keys[1] ?? null;
    const shape =
      name === "buy" ? txs.every((t) => t && t.payer === PIN.feePayer && t.tables.includes(pinTable) && t.calls.includes(PUMP_PROGRAM) && t.keys[1] === w)
      : name === "sell" ? txs.every((t) => t && w !== null && t.payer === w && t.signers === 1 && t.calls.includes(PUMP_PROGRAM))
      : true;
    const what = name === "buy" ? ", paid by the pin's fee payer, loading the pin's table, calling pump.fun" : name === "sell" ? ", signed and paid by the buy's W alone, calling pump.fun" : "";
    say(ok && shape, `${name} ${sig}: succeeded on both RPCs at finalized, the pinned program on the pool${what}: ${txs.map((t, i) => (t ? `err ${JSON.stringify(t.err)}, payer ${t.payer}` : `not found (${saidOf[i]})`)).join("; ")}`);
  }
  const h = helper?.json;
  say(helper?.status === 200 && h?.cluster === "devnet" && h?.program === pin.program && h?.pool === pin.pool && h?.fee_payer === PIN.feePayer, `the helper's fee answer names the pin's program and fee payer: ${!helper ? "not read" : h?.program && h?.fee_payer ? `${helper.status}, ${h.program}, ${h.fee_payer}` : `HTTP ${helper.status}, ${JSON.stringify(h).slice(0, 160)}`}`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) (out = B58[Number(n % 58n)] + out), (n /= 58n);
  for (const b of bytes) if (b === 0) out = `1${out}`; else break;
  return out;
}

/** The verdict for `program` read through `fetchFn` (live, or a recorded answer replayed), and SIGN_HOST's read `sign`,
 *  against today's devnet pin (devnetPin(), the deploy record pool-sol-deploy.devnet.json) and run 7's table
 *  RUN_TABLE, the ones a live run reads: a replay is judged on them too, so a recording on another program, pool or
 *  table FAILs (it takes no deploy record or table pin of its own). */
export async function check({ program, table = RUN_TABLE, fetchFn = fetch, rpcs = DEVNET_PROVIDERS, sleep, sign, helper, ...rest } = {}) {
  if ("deployment" in rest || "pinTable" in rest) throw new Error("check reads today's devnet pin and table only: no deploy record or table pin is passed in");
  const pinTable = RUN_TABLE;
  const pin = devnetPin();
  const record = pin.record;
  program ??= pin.program;
  const lines = [];
  const say = (pass, text) => lines.push(`${pass === null ? "info" : pass ? "ok  " : "BAD "} ${text}`);
  say(sign?.status === 200 && sign.bytes > 0 && Array.isArray(sign.found) && sign.found.length === 0, `SIGN_HOST's /app.js is the mainnet build, with no testnet pin or provider: ${sign ? `${sign.status}, ${sign.bytes} chars, carries [${sign.found.join(", ")}]` : "not read"}`);
  say(program === pin.program, `the program read is the pin's: ${program}`);
  say(record.program_id === pin.program && record.pool === pin.pool && poolAddress(pin.program).address === pin.pool, `the deployment record's program and pool, its pool derived from its program: ${record.program_id}, ${record.pool}`);
  const read = program === pin.program ? record : { ...record, program_id: program, programdata: programDataAddress(program), pool: poolAddress(program).address };
  const r = await deployCheck({ deployment: read, fetchFn, rpcs, ...(sleep ? { sleep } : {}) });
  for (const l of r.lines) lines.push(l.startsWith("FAIL") ? `BAD ${l.slice(4)}` : l);
  await checkRun({ pin, pinTable, table, fetchFn, rpcs, sleep, helper }, say);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const rec = recorder();
    const sign = await readSign();
    const helper = await readHelper();
    const deployment = devnetPin().record;
    const program = opt("--program") ?? PIN.program;
    const table = opt("--table") ?? RUN_TABLE;
    const r = await check({ program, table, fetchFn: opt("--record") ? rec.fetchFn : fetch, sign, helper });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ deployment, pin_table: RUN_TABLE, program, table, rpcs: DEVNET_PROVIDERS, at: new Date().toISOString(), sign, helper, answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
