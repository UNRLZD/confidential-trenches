#!/usr/bin/env node
// Live check of card solana-jupiter-build (markets paper row M1.1, docs/plan1/markets.md l.3054; T2.1 l.291-336): the
// kit builds the paper's Solana swap shapes through HELPER_HOST's Jupiter proxy and assembles each on the device, at
// most 1,232 bytes, signing nothing. The shapes are the self-mode frames of T2.1 (06c S-1 buy and S-2 sell; P4's float
// shapes are gone in Plan 1, the fresh wallet pays and signs alone), each on two live tokens, so four:
//   S-1 buy and S-2 sell of a listed token: the first pump.fun token (the lane's subject, M1's end state) on the
//   helper's Solana Discover lists (GET /v1/market/lists?chain=solana, the read a device makes; Trending 1h first)
//   with at least $50k of liquidity, or --token;
//   S-1 buy and S-2 sell of a token with no route at 40: the first token of the New, then Graduating, list whose buy
//   at maxAccounts=40 Jupiter answers "No routes found" and at 64 (Jupiter's most) a route (at most PROBES asked), or
//   --no-route-token.
// Every shape is built as the device builds a trade (card solana-uncapped-fits): the kit's fetchSolanaJupiterBuildThatFits,
// the cap search judged on the device's own assembly (40, up on no route, down when over 1,232 bytes, at most 3
// builds), live and on replay. So the check asks only paths a device takes: the second token's shapes must start with
// "No routes found" at 40 and end in a build that fits, the first token's go as its route goes.
// The check's Jupiter calls are a device's builds and its probes, each at least PACE_MS after the last, so one runner
// stays within a device's share of 4 a 10 s window (apps/helper/src/proxy/proxy.ts; card helper-crowd-429). The taker
// is a random address nobody holds a key for, made per run (so no wallet is linked to the check).
// The device's reads come from two public RPCs: both mints and every lookup table any build names (processed), and the
// blockhash from getLatestBlockhash at finalized on the first (never the build's blockhashWithMetadata).
// It passes only when every shape: answers 200; parses; assembles at most 1,232 bytes on the device's own blockhash
// and tables; decodes back with that blockhash; and passes the quote checks on the frame the assembly builds (S2 tables,
// S3 programs, S4 signer, S5 transfers and tips, S8 compute budget, S9 size, S13 creates and closes) and on Jupiter's
// route and the token (S1 request match, S6 the output to the wallet's own account, S7 the floor, S10 the mint), on
// either route instruction /build answers: route_v2 (discriminator bb64facc31c4af14) or shared_accounts_route_v2
// (d19853937cfed8e9, which /build answers for many multi-hop routes). S7's minOut is the floor of the build's own
// outAmount at the slippage this check asked for, so the floor decoded from the signed bytes must be at least what was
// asked. S11 and S12 need a funded simulation and the reference pool, the buy flow's.
//   node scripts/live-checks/solana-jupiter-build.mjs [--base <helper origin>] [--token <mint>] [--no-route-token <mint>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2 (no such token among PROBES is an error, not a FAIL).
//   --record writes every answer the run read, so the test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import {
  SOLANA_BUILD_TIMEOUT_MS,
  SOLANA_MAX_TX_BYTES,
  SOLANA_SOL_MINT,
  assembleSolanaSwap,
  checkSolanaQuote,
  SolanaBuildError,
  fetchSolanaJupiterBuild,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaJsonRpc,
} from "../../packages/kit/src/index.ts";

const KEY = "solana-jupiter-build";
export const BASE = "https://api.confidential.unrealized.trade";
export const RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
export const BUY_LAMPORTS = 10_000_000n; // 0.01 SOL
export const SLIPPAGE_BPS = 1000;
/** Tokens asked at 40 to find one with no route there; 7 of 40 listed tokens had none on 2026-11-05 03:30Z. */
export const PROBES = 16;
/** A device's Jupiter share is 4 a 10 s window: one call every 3 s stays inside it, at most 20 a minute of the 26 the
 * helper leaves devices on Jupiter's Free plan (PROXY_RESERVE). */
export const PACE_MS = 3_000;
export const SHAPES = [
  { name: "S-1 buy, a listed token", side: "buy", token: "listed" },
  { name: "S-1 buy, a token with no route at 40", side: "buy", token: "noRoute" },
  { name: "S-2 sell, a listed token", side: "sell", token: "listed" },
  { name: "S-2 sell, a token with no route at 40", side: "sell", token: "noRoute" },
];
// The checks a build is judged by here; S11 and S12 need the buy flow's simulation and reference pool.
export const JUDGED = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S13"];
// The route instruction by its Anchor discriminator, for the line only (the checks decode the bytes themselves).
const ROUTES = { bb64facc31c4af14: "route_v2", d19853937cfed8e9: "shared_accounts_route_v2" };
const ALT = "AddressLookupTab1e1111111111111111111111111";

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

// A fetch that answers the kit's build calls from a shape's recorded calls, in order, and refuses a call the kit makes
// that the record does not hold, so the replay runs the kit's own query, cap search and parse.
function replay(calls) {
  const left = [...calls];
  return async (url) => {
    const c = left.shift();
    if (!c) throw new Error(`the kit asked ${url}, past the recorded calls`);
    if (c.url !== url) throw new Error(`the kit asked ${url}, the record holds ${c.url}`);
    if (c.status === 0) throw new Error(c.error ?? "no answer");
    return new Response(c.body, { status: c.status, headers: { "content-type": "application/json" } });
  };
}

/** The device's assembly of one build on the record's reads: the cap search's judge. */
function assembler(r, req) {
  const [ma] = r.reads?.accounts?.[req.token] ?? [null];
  return (build) => {
    const tables = {};
    for (const t of build.tables) {
      const a = r.reads.accounts[t]?.[0];
      if (a && a.owner === ALT) {
        try { tables[t] = solanaDecodeLookupTable(b64(a.data)); } catch { /* not used: S2 then refuses if the message needs it */ }
      }
    }
    return assembleSolanaSwap(req, build, { blockhash: r.blockhash.blockhash, lastValidBlockHeight: r.blockhash.lastValidBlockHeight, tables, tokenProgram: ma?.owner });
  };
}

/** The check on one recorded run. */
export async function judge(r) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(r.shapes?.length === SHAPES.length && SHAPES.every((s, i) => r.shapes[i]?.name === s.name), `the four shapes: ${(r.shapes ?? []).map((s) => s.name).join("; ")}`);
  for (const kind of ["listed", "noRoute"]) {
    const mint = r.mints?.[kind];
    const [ma, mb] = r.reads?.accounts?.[mint] ?? [null, null];
    say(!!ma && !!mb && ma.owner === mb.owner && ma.data === mb.data, `${kind === "listed" ? "listed" : "no-route"} mint ${mint} read equal on both providers, owner ${ma?.owner}`);
  }
  const bh = r.blockhash;
  say(!!bh && typeof bh.blockhash === "string" && Number.isSafeInteger(bh.lastValidBlockHeight), `the device's blockhash at finalized: ${bh?.blockhash} valid to height ${bh?.lastValidBlockHeight}`);
  for (const [i, s] of (r.shapes ?? []).entries()) {
    const want = SHAPES[i];
    const at = `${s.name}:`;
    if (!want || s.name !== want.name) { say(false, `${at} not a shape of this check`); continue; }
    const token = r.mints?.[want.token];
    const req = { side: want.side, wallet: r.wallet, token, amount: BigInt(r.amounts?.[want.token]?.[want.side] ?? "0"), slippageBps: SLIPPAGE_BPS };
    let found;
    try {
      found = await fetchSolanaJupiterBuildThatFits(r.base, req, assembler(r, req), { fetch: replay(s.calls ?? []) });
    } catch (e) {
      const last = (s.calls ?? []).at(-1);
      say(false, `${at} ${e instanceof SolanaBuildError ? e.message : `replay: ${e.message}`}${last ? ` (HTTP ${last.status} ${String(last.body).slice(0, 80)})` : ""}`);
      continue;
    }
    if (s.calls.length !== found.calls.length) { say(false, `${at} ${s.calls.length} recorded calls, the kit made ${found.calls.length}`); continue; }
    const steps = found.steps.map((x) => `${x.maxAccounts} ${x.outcome === "fits" ? "fits" : x.outcome === "no_route" ? "no route" : `${x.size} bytes`}`).join(", ");
    // the second token's shapes are the device's retry path: they must start with "No routes found" at 40
    if (want.token === "noRoute" && found.steps[0]?.outcome !== "no_route") { say(false, `${at} the token routes at 40 (${steps}), so this is not the retry path`); continue; }
    const tx = found.fitted;
    const dec = solanaDecodeTransaction(tx.wire);
    const sameHash = dec.message.blockhash === bh.blockhash;
    const build = found.build;
    // S7's minOut: the fitting build's outAmount at the asked slippage, rounded down (read from the answer, so checked
    // as a bounded integer first)
    let out;
    try { out = JSON.parse(s.calls.at(-1).body).outAmount; } catch { out = undefined; }
    if (!/^[1-9]\d{0,19}$/.test(String(out))) { say(false, `${at} outAmount ${String(out).slice(0, 40)} is not a positive integer`); continue; }
    const minOut = (BigInt(out) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    const kind = ROUTES[Buffer.from(build.swap.data).subarray(0, 8).toString("hex")] ?? "an unknown Jupiter instruction";
    const pairs = Object.fromEntries(build.tables.map((t) => [t, (r.reads.accounts[t] ?? [null, null]).map(accRead)]));
    const [ma, mb] = r.reads.accounts[token] ?? [null, null];
    const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut }, {
      tables: pairs,
      mint: [accRead(ma), accRead(mb)],
      rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
      simulations: [null, null],
      reference: null,
    });
    const off = v.results.filter((x) => JUDGED.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`);
    const ms = s.calls.reduce((n, c) => n + c.ms, 0);
    const ok = tx.size <= SOLANA_MAX_TX_BYTES && sameHash && off.length === 0;
    say(ok, `${at} ${tx.size} bytes (limit ${SOLANA_MAX_TX_BYTES}), caps ${steps}, route ${build.route.join(" + ")} by ${kind}, ${dec.message.instructions.length} instructions, ${tx.tablesUsed.length} table(s), CU limit ${tx.cuLimit}, builds ${Math.round(ms)} ms${sameHash ? "" : `, blockhash ${dec.message.blockhash} is not the device's`}${off.length ? `; refused: ${off.join("; ")}` : `; ${JUDGED.join(",")} pass`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

async function get(base, path) {
  const r = await fetch(`${base}${path}`, { redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  return { status: r.status, body: await r.text() };
}

export async function read({ base = BASE, token, noRouteToken } = {}) {
  base = base.replace(/\/$/, "");
  const readAt = new Date().toISOString();
  const l = await get(base, "/v1/market/lists?chain=solana");
  if (l.status !== 200) throw new Error(`Solana lists: HTTP ${l.status}`);
  const lists = JSON.parse(l.body)?.lists ?? {};
  const rows = (keys) => keys.flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : [])).filter((t) => typeof t?.token === "string" && t.token !== SOLANA_SOL_MINT);
  if (!token) {
    const pick = rows(["trending_1h", "trending", "trending_5m", "graduating", "new"]).find((t) => t.launchpad === "pump.fun" && Number(t.liq_usd ?? 0) >= 50_000);
    if (!pick) throw new Error("no listed pump.fun token with $50k of liquidity");
    token = pick.token;
  }
  const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  // every Jupiter call of the run, paced; the kit's own calls, this fetch only keeps what each answered
  let last = 0;
  const paced = async (url, init) => {
    const wait = last + PACE_MS - Date.now();
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    last = Date.now();
    const t = performance.now();
    // the kit's own timeout, started after the pace's wait (the kit's signal was started before it)
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SOLANA_BUILD_TIMEOUT_MS) });
    const body = await res.text();
    return { url, status: res.status, body, ms: performance.now() - t, res };
  };
  const probes = [];
  if (!noRouteToken) {
    const seen = new Set([token]);
    for (const t of rows(["new", "graduating"])) {
      if (seen.has(t.token) || probes.length >= PROBES) continue;
      seen.add(t.token);
      const req = { side: "buy", wallet, token: t.token, amount: BUY_LAMPORTS, slippageBps: SLIPPAGE_BPS };
      // at 40, and when it has no route there, at 64, Jupiter's most: a token with no route at any cap is not the retry
      // path (it cannot be bought anywhere), so it is passed over
      const at = async (maxAccounts) => {
        let status = 0;
        return fetchSolanaJupiterBuild(base, req, { maxAccounts, fetch: async (url, init) => { const c = await paced(url, init); status = c.status; return new Response(c.body, { status: c.status }); } })
          .then(() => "route", (e) => (e instanceof SolanaBuildError && e.code === "no_route" ? "no route" : `HTTP ${status}`));
      };
      const p = { mint: t.token, at40: await at(40) };
      if (p.at40 === "no route") p.at64 = await at(64);
      probes.push(p);
      if (p.at40 === "no route" && p.at64 === "route") { noRouteToken = t.token; break; }
    }
    if (!noRouteToken) throw new Error(`no token with no route at 40 and a route at 64 among ${probes.length} probed (${probes.map((p) => `${p.mint.slice(0, 8)} ${p.at40}${p.at64 ? `, ${p.at64} at 64` : ""}`).join("; ")})`);
  }
  const mints = { listed: token, noRoute: noRouteToken };
  const amounts = { listed: { buy: BUY_LAMPORTS.toString(), sell: "" }, noRoute: { buy: BUY_LAMPORTS.toString(), sell: "" } };
  // the reads the judge needs, made after the builds: both mints, every table any build names, the blockhash
  const rpcAgain = (rpc) => Object.assign(async (m, p) => {
    // public RPCs answer 429 or time out under load: up to 4 tries each, 1, 2 and 4 s apart (a read, never a judgement)
    for (let i = 0; ; i++) {
      try { return await rpc(m, p); } catch (e) { if (i >= 3 || !/HTTP 429|timeout/i.test(e.message)) throw e; await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i)); }
    }
  }, { url: rpc.url });
  const rpcs = RPCS.map((u) => rpcAgain(solanaJsonRpc(u)));
  const blockhash = await readSolanaBlockhash(rpcs[0]);
  const shapes = [];
  for (const s of SHAPES) {
    const mint = mints[s.token];
    if (s.side === "sell" && !amounts[s.token].sell) {
      // the sell size: what the token's buy quoted out (a size only; nothing signed rests on it)
      let out;
      try { out = JSON.parse(shapes.find((x) => x.name === SHAPES.find((y) => y.token === s.token && y.side === "buy").name)?.calls.at(-1)?.body ?? "{}").outAmount; } catch { out = undefined; }
      amounts[s.token].sell = /^[1-9]\d{0,19}$/.test(String(out)) ? String(out) : "1000000";
    }
    const req = { side: s.side, wallet, token: mint, amount: BigInt(amounts[s.token][s.side]), slippageBps: SLIPPAGE_BPS };
    const calls = [];
    const keep = async (url, init) => {
      let c;
      try {
        c = await paced(url, init);
      } catch (e) {
        // a call the helper did not answer (the kit's 5 s timeout, a dropped connection) is kept too, as status 0
        calls.push({ url, status: 0, body: "", ms: 0, error: String(e?.message ?? e).slice(0, 120) });
        throw e;
      }
      calls.push({ url: c.url, status: c.status, body: c.body, ms: c.ms });
      return new Response(c.body, { status: c.status, headers: { "content-type": c.res.headers.get("content-type") ?? "" } });
    };
    // the device's cap search, its judge the assembly on reads made now (the judge assembles again on the record's)
    const live = { reads: { accounts: {} }, blockhash };
    const fit = async (build) => {
      const keys = [mint, ...build.tables].filter((k) => !live.reads.accounts[k]);
      if (keys.length) Object.assign(live.reads.accounts, await readAccounts(rpcs, keys));
      return assembler(live, req)(build);
    };
    await fetchSolanaJupiterBuildThatFits(base, req, fit, { fetch: keep }).catch(() => {}); // judged on replay
    shapes.push({ name: s.name, calls });
  }
  const names = new Set([mints.listed, mints.noRoute]);
  for (const s of shapes) for (const c of s.calls) {
    try { for (const t of Object.keys(JSON.parse(c.body).addressesByLookupTableAddress ?? {}).slice(0, 8)) names.add(t); } catch { /* judged later */ }
  }
  const accounts = await readAccounts(rpcs, [...names]);
  return { base, readAt, mints, wallet, amounts, probes, shapes, reads: { rpcs: RPCS, accounts }, blockhash };
}

// Both providers' reads of the keys, at processed: at most 10 keys per getMultipleAccounts (solana-rpc.publicnode.com
// refuses more: "A maximum of 10 accounts is allowed", -32602, read 2026-11-02 05:55Z).
async function readAccounts(rpcs, keys) {
  const chunks = [];
  for (let i = 0; i < keys.length; i += 10) chunks.push(keys.slice(i, i + 10));
  const readAll = async (rpc) => {
    const value = [];
    for (const c of chunks) value.push(...(await rpc("getMultipleAccounts", [c, { encoding: "base64", commitment: "processed" }])).value);
    return value;
  };
  const reads = await Promise.all(rpcs.map(readAll));
  return Object.fromEntries(keys.map((k, i) => [k, reads.map((v) => (v[i] ? { owner: v[i].owner, data: v[i].data[0] } : null))]));
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token"), noRouteToken: opt("--no-route-token") });
    // `mints`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = await judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, tokens ${answer.mints.listed} and ${answer.mints.noRoute})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
