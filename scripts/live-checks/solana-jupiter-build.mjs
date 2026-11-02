#!/usr/bin/env node
// Live check of card solana-jupiter-build (markets paper row M1.1, docs/plan1/markets.md l.3054; T2.1 l.291-336): the
// kit builds the paper's Solana swap shapes through HELPER_HOST's Jupiter proxy and assembles each on the device, at
// most 1,232 bytes, signing nothing. The shapes are the self-mode frames of T2.1 (06c S-1 buy and S-2 sell; P4's float
// shapes are gone in Plan 1, the fresh wallet pays and signs alone), each built twice: at maxAccounts=40, the first
// build, and uncapped, the one retry the paper allows when the cap finds no route (P4S run 3, Fail 3). So four:
//   S-1 buy at maxAccounts=40, S-1 buy uncapped, S-2 sell at maxAccounts=40, S-2 sell uncapped.
// One live token: the first pump.fun token (the lane's subject, M1's end state) in the helper's Jupiter top-trending
// (1h) list with at least $50k of liquidity, or --token. The taker is a random address nobody holds a key for, made
// per run (so no wallet is linked to the check).
// The device's reads come from two public RPCs: the mint and every lookup table the builds name (processed), and the
// blockhash from getLatestBlockhash at finalized on the first (never the build's blockhashWithMetadata).
// It passes only when every shape: answers 200; parses; assembles at most 1,232 bytes on the device's own blockhash
// and tables; decodes back with that blockhash; and passes the quote checks on the frame the assembly builds (S2 tables,
// S3 programs, S4 signer, S5 transfers and tips, S8 compute budget, S9 size, S13 creates and closes). The checks on the
// route instruction and the mint (S1, S6, S7 with minOut 1, S10) are printed as info: they judge Jupiter's route and
// the token, not the assembly (S1, S6 and S7 decode route_v2 only; for some multi-hop routes Jupiter answers
// shared_accounts_route_v2, discriminator d19853937cfed8e9 = sha256("global:shared_accounts_route_v2")[0..8], read
// 2026-11-02 05:05Z). S11 and S12 need a funded simulation and the reference pool, the buy flow's.
//   node scripts/live-checks/solana-jupiter-build.mjs [--base <helper origin>] [--token <mint>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes every answer the run read, so the test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import {
  SOLANA_JUPITER_MAX_ACCOUNTS,
  SOLANA_MAX_TX_BYTES,
  SOLANA_SOL_MINT,
  assembleSolanaSwap,
  checkSolanaQuote,
  parseSolanaJupiterBuild,
  readSolanaBlockhash,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaJsonRpc,
  solanaJupiterBuildQuery,
} from "../../packages/kit/src/index.ts";

const KEY = "solana-jupiter-build";
export const BASE = "https://api.confidential.unrealized.trade";
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
export const SLIPPAGE_BPS = 1000;
export const SHAPES = [
  { name: "S-1 buy, maxAccounts=40", side: "buy", maxAccounts: SOLANA_JUPITER_MAX_ACCOUNTS },
  { name: "S-1 buy, uncapped", side: "buy", maxAccounts: null },
  { name: "S-2 sell, maxAccounts=40", side: "sell", maxAccounts: SOLANA_JUPITER_MAX_ACCOUNTS },
  { name: "S-2 sell, uncapped", side: "sell", maxAccounts: null },
];
// The checks a build is judged by here; S11 and S12 need the buy flow's simulation and reference pool.
export const JUDGED = ["S2", "S3", "S4", "S5", "S8", "S9", "S13"];
export const INFO = ["S1", "S6", "S7", "S10"];
const PATH = "/v1/proxy/jupiter/swap/v2/build";

// base58 of bytes (Bitcoin alphabet), for the per-run random taker only.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const accRead = (a) => (a ? { owner: a.owner, data: b64(a.data) } : null);

/** The check on one recorded run. */
export function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.shapes?.length === SHAPES.length && SHAPES.every((s, i) => r.shapes[i]?.name === s.name), `the four shapes: ${(r.shapes ?? []).map((s) => s.name).join("; ")}`);
  const [ma, mb] = r.reads?.accounts?.[r.mint] ?? [null, null];
  const mintOk = !!ma && !!mb && ma.owner === mb.owner && ma.data === mb.data;
  say(mintOk, `mint ${r.mint} read equal on both providers, owner ${ma?.owner}`);
  const bh = r.blockhash;
  say(!!bh && typeof bh.blockhash === "string" && Number.isSafeInteger(bh.lastValidBlockHeight), `the device's blockhash at finalized: ${bh?.blockhash} valid to height ${bh?.lastValidBlockHeight}`);
  for (const [i, s] of (r.shapes ?? []).entries()) {
    const want = SHAPES[i];
    const at = `${s.name}:`;
    if (!want) { say(false, `${at} not a shape of this check`); continue; }
    const req = { side: want.side, wallet: r.wallet, token: r.mint, amount: BigInt(want.side === "buy" ? r.amounts.buy : r.amounts.sell), slippageBps: SLIPPAGE_BPS };
    const query = solanaJupiterBuildQuery(req, want.maxAccounts);
    if (s.query !== query) { say(false, `${at} asked ${s.query}, not the kit's query ${query}`); continue; }
    if (s.status !== 200) { say(false, `${at} HTTP ${s.status} ${String(s.body).slice(0, 120)}`); continue; }
    let build;
    try {
      build = parseSolanaJupiterBuild(JSON.parse(s.body));
    } catch (e) {
      say(false, `${at} ${e.message}`);
      continue;
    }
    const tables = {};
    const pairs = {};
    for (const t of build.tables) {
      const [a, b] = r.reads.accounts[t] ?? [null, null];
      pairs[t] = [accRead(a), accRead(b)];
      if (a && a.owner === "AddressLookupTab1e1111111111111111111111111") {
        try { tables[t] = solanaDecodeLookupTable(b64(a.data)); } catch { /* not used: S2 then refuses if the message needs it */ }
      }
    }
    let tx;
    try {
      tx = assembleSolanaSwap(req, build, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, tables, tokenProgram: ma?.owner });
    } catch (e) {
      say(false, `${at} refused: ${e.message} (route ${build.route.join(" + ")})`);
      continue;
    }
    const dec = solanaDecodeTransaction(tx.wire);
    const sameHash = dec.message.blockhash === bh.blockhash;
    const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut: 1n }, {
      tables: pairs,
      mint: [accRead(ma), accRead(mb)],
      rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
      simulations: [null, null],
      reference: null,
    });
    const off = v.results.filter((x) => JUDGED.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`);
    const info = v.results.filter((x) => INFO.includes(x.id)).map((x) => `${x.id} ${x.ok ? "pass" : `refuses: ${x.detail}`}`);
    const ok = tx.size <= SOLANA_MAX_TX_BYTES && sameHash && off.length === 0;
    say(ok, `${at} ${tx.size} bytes (limit ${SOLANA_MAX_TX_BYTES}), route ${build.route.join(" + ")}, ${dec.message.instructions.length} instructions, ${tx.tablesUsed.length} table(s), CU limit ${tx.cuLimit}, build ${Math.round(s.ms)} ms${sameHash ? "" : `, blockhash ${dec.message.blockhash} is not the device's`}${off.length ? `; refused: ${off.join("; ")}` : `; ${JUDGED.join(",")} pass`}`);
    lines.push(`    info ${s.name}: ${info.join("; ")}`);
  }
  const judged = lines.filter((l) => !l.startsWith("    info "));
  return { ok: judged.length > 0 && judged.every((l) => l.startsWith("ok ")), lines };
}

async function post(base, path, query) {
  const t = performance.now();
  const r = await fetch(`${base}${path}${query ? `?${query}` : ""}`, { method: "POST", redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  const body = await r.text();
  return { status: r.status, body, ms: performance.now() - t };
}

export async function read({ base = BASE, token } = {}) {
  base = base.replace(/\/$/, "");
  const readAt = new Date().toISOString();
  if (!token) {
    const l = await post(base, "/v1/proxy/jupiter/tokens/v2/toptrending/1h", "limit=50");
    if (l.status !== 200) throw new Error(`top-trending list: HTTP ${l.status}`);
    const rows = JSON.parse(l.body);
    const pick = Array.isArray(rows) ? rows.find((t) => typeof t?.id === "string" && t.id !== SOLANA_SOL_MINT && t.launchpad === "pump.fun" && (t.liquidity ?? 0) >= 50_000) : undefined;
    if (!pick) throw new Error("no top-trending pump.fun token with $50k of liquidity");
    token = pick.id;
  }
  const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const amounts = { buy: BUY_LAMPORTS.toString(), sell: "" };
  const shapes = [];
  for (const s of SHAPES) {
    if (s.side === "sell" && !amounts.sell) {
      // the sell size: what the capped buy quoted out (a size only; nothing signed rests on it)
      const out = JSON.parse(shapes[0]?.body ?? "{}").outAmount;
      amounts.sell = /^[1-9]\d{0,19}$/.test(String(out)) ? String(out) : "1000000";
    }
    const req = { side: s.side, wallet, token, amount: BigInt(s.side === "buy" ? amounts.buy : amounts.sell), slippageBps: SLIPPAGE_BPS };
    const query = solanaJupiterBuildQuery(req, s.maxAccounts);
    shapes.push({ name: s.name, query, ...(await post(base, PATH, query)) });
  }
  const names = new Set([token]);
  for (const s of shapes) {
    try { for (const t of Object.keys(JSON.parse(s.body).addressesByLookupTableAddress ?? {}).slice(0, 8)) names.add(t); } catch { /* judged later */ }
  }
  const keys = [...names];
  // public RPCs answer 429 under load: up to 4 tries each, 1, 2 and 4 s apart (a read, never a judgement)
  const again = (rpc) => Object.assign(async (m, p) => {
    for (let i = 0; ; i++) {
      try { return await rpc(m, p); } catch (e) { if (i >= 3 || !/HTTP 429/.test(e.message)) throw e; await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i)); }
    }
  }, { url: rpc.url });
  const rpcs = RPCS.map((u) => again(solanaJsonRpc(u)));
  const [blockhash, ...reads] = await Promise.all([
    readSolanaBlockhash(rpcs[0]),
    ...rpcs.map((rpc) => rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: "processed" }])),
  ]);
  const accounts = {};
  keys.forEach((k, i) => {
    accounts[k] = reads.map((x) => {
      const a = x?.value?.[i];
      return a ? { owner: a.owner, data: a.data[0] } : null;
    });
  });
  // `mint`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
  return { base, readAt, mint: token, wallet, amounts, shapes, reads: { rpcs: RPCS, accounts }, blockhash };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token") });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, token ${answer.mint})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
