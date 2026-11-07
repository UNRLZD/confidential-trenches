#!/usr/bin/env node
// Live check of card solana-legs-share-wait: a many-wallet Solana buy is never refused by the helper's limits. Six
// legs of a dry buy (nothing is signed or sent) build at once through HELPER_HOST's Jupiter proxy, as runSolanaTrade's
// legs do: each leg is the kit's own cap search (fetchSolanaJupiterBuildThatFits) judged on the device's own assembly,
// all sharing one SolanaBuildRoom with the trade's bound (SOLANA_TRADE_BUILD_WAIT_MS). Six at once is past one
// client's share (4 in 10 s, apps/helper/src/limits/limits.ts), so the helper answers some legs 429 with a Retry-After;
// a leg waits it out and asks again, at the cap another leg already fitted, never counting it as a cap step.
// The token is the first pump.fun token on the helper's Solana Discover lists with at least $50k of liquidity, or
// --token; each leg buys 0.01 SOL more by a lamport, from its own random taker nobody holds a key for, made per run.
// The device's reads come from two public RPCs: the mint and every lookup table a build names, and the blockhash at
// finalized on the first. The run is paced by the helper's own answers: the room waits each Retry-After, and the
// check asks nothing else of Jupiter.
// It passes only when: six legs, six takers; the mint reads agree on both providers (the kit's solanaMintDisagreement, as S6 and S10
// judge it: every field but the supply a burn moves); every leg's recorded calls replay
// through the kit's own cap search and room wait (the answers, Retry-After included, as recorded), so no 429 or 503
// reaches a leg as its end; each leg ends in a build that assembles at most 1,232 bytes on the device's blockhash and
// passes the quote checks on the frame (JUDGED, as solana-jupiter-build.mjs); every call answered 429 or 503 was
// followed by the leg's next call no sooner than its Retry-After; and the run ended inside the trade's bound.
//   node scripts/live-checks/solana-legs-share-wait.mjs [--base <helper origin>] [--token <mint>] [--legs <n>] [--record <file>] [--no-wait]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes every answer the run read, so the test can replay it.
//   --legs runs more legs than 6 (at most the kit's 64): 16 is past what the helper lends one client in a minute (about
//   14), so its legs meet the helper's 429 live; the test's recorded runs use it.
//   --no-wait builds the legs without the room's wait, as the kit did before this card: its record is the test's bad
//   answer (a 429 that reached a leg).
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import {
  SOLANA_BUILD_TIMEOUT_MS,
  SOLANA_MAX_TX_BYTES,
  SOLANA_SOL_MINT,
  SOLANA_TRADE_BUILD_WAIT_MS,
  SolanaBuildError,
  SolanaBuildRoom,
  assembleSolanaSwap,
  checkSolanaQuote,
  fetchSolanaJupiterBuildThatFits,
  readSolanaBlockhash,
  solanaDecodeLookupTable,
  solanaDecodeTransaction,
  solanaJsonRpc,
} from "../../packages/kit/src/index.ts";
import { BASE, BUY_LAMPORTS, JUDGED, RPCS, SLIPPAGE_BPS, base58, mintLine, noneWritten } from "./solana-jupiter-build.mjs";

const KEY = "solana-legs-share-wait";
export const LEGS = 6;
/** The kit's most legs a trade (packages/kit/src/trade/solana/pool.ts MAX_LEGS). */
export const MAX_LEGS = 64;
const ALT = "AddressLookupTab1e1111111111111111111111111";
const b64 = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const accRead = (a) => (a ? { owner: a.owner, data: b64(a.data) } : null);
const amountOf = (i) => BUY_LAMPORTS + BigInt(i);

/** One leg's recorded calls answered in order, Retry-After included; a call past the record, or another URL, throws. */
function replay(calls) {
  const left = [...calls];
  return async (url) => {
    const c = left.shift();
    if (!c) throw new Error(`the kit asked ${url}, past the recorded calls`);
    if (c.url !== url) throw new Error(`the kit asked ${url}, the record holds ${c.url}`);
    if (c.status === 0) throw new Error(c.error ?? "no answer");
    return new Response(c.body, { status: c.status, headers: { "content-type": "application/json", ...(c.retryAfter ? { "retry-after": c.retryAfter } : {}) } });
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
  const legs = r.legs ?? [];
  const takers = new Set(legs.map((l) => l.wallet));
  say(legs.length >= LEGS && legs.length <= MAX_LEGS && takers.size === legs.length, `${legs.length} legs, ${takers.size} takers (${LEGS} to ${MAX_LEGS} legs, a taker each)`);
  const [ma, mb] = r.reads?.accounts?.[r.mint] ?? [null, null];
  say(...mintLine("mint", r.mint, ma, mb));
  const bh = r.blockhash;
  say(!!bh && typeof bh.blockhash === "string" && Number.isSafeInteger(bh.lastValidBlockHeight), `the device's blockhash at finalized: ${bh?.blockhash} valid to height ${bh?.lastValidBlockHeight}`);
  let builds = 0;
  let waits = 0;
  for (const [i, l] of legs.entries()) {
    const at = `leg ${i + 1}:`;
    const calls = l.calls ?? [];
    builds += calls.length;
    const req = { side: "buy", wallet: l.wallet, token: r.mint, amount: amountOf(i), slippageBps: SLIPPAGE_BPS };
    // the leg's waits on a clock of their own: each Retry-After passes at once; the cap another leg had fitted by then
    // is the one recorded at that wait
    let t = 0;
    const known = [...(l.known ?? [])];
    const wait = { until: SOLANA_TRADE_BUILD_WAIT_MS, clock: () => t, sleep: async (ms) => { t += ms; }, knownCap: () => { const k = known.shift(); return k === null ? undefined : k; } };
    let found;
    try {
      found = await fetchSolanaJupiterBuildThatFits(r.base, req, assembler(r, req), { fetch: replay(calls), wait });
    } catch (e) {
      const last = calls.at(-1);
      say(false, `${at} ${e instanceof SolanaBuildError ? `build ${e.code}: ${e.message}` : `replay: ${e.message}`}${last ? ` (last answer HTTP ${last.status}${last.retryAfter ? `, Retry-After ${last.retryAfter}` : ""})` : ""}`);
      continue;
    }
    if (calls.length !== found.calls.length) { say(false, `${at} ${calls.length} recorded calls, the kit made ${found.calls.length}`); continue; }
    // every wait was real: the leg's next call went no sooner than the Retry-After, from the answer
    const held = calls.flatMap((c, j) => ((c.status === 429 || c.status === 503) && c.retryAfter ? [{ c, next: calls[j + 1] }] : []));
    waits += held.length;
    const early = held.filter(({ c, next }) => !next || next.sentAt < c.sentAt + c.ms + Number(c.retryAfter) * 1000 - 5);
    const steps = found.steps.map((x) => `${x.maxAccounts} ${x.outcome === "fits" ? "fits" : x.outcome === "no_route" ? "no route" : `${x.size} bytes`}`).join(", ");
    const tx = found.fitted;
    const sameHash = solanaDecodeTransaction(tx.wire).message.blockhash === bh.blockhash;
    let out;
    try { out = JSON.parse(calls.at(-1).body).outAmount; } catch { out = undefined; }
    if (!/^[1-9]\d{0,19}$/.test(String(out))) { say(false, `${at} outAmount ${String(out).slice(0, 40)} is not a positive integer`); continue; }
    const minOut = (BigInt(out) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    const pairs = Object.fromEntries(found.build.tables.map((k) => [k, (r.reads.accounts[k] ?? [null, null]).map(accRead)]));
    const v = checkSolanaQuote(tx.wire, { ...req, spendable: req.amount, minOut }, {
      tables: pairs,
      mint: [accRead(ma), accRead(mb)],
      rent: { tokenAccount: [0n, 0n], pumpVolumeAccumulator: [0n, 0n] },
      simulations: [null, null],
      writable: noneWritten(tx.wire, pairs),
      reference: null,
    });
    const off = v.results.filter((x) => JUDGED.includes(x.id) && !x.ok).map((x) => `${x.id} ${x.detail}`);
    const ok = tx.size <= SOLANA_MAX_TX_BYTES && sameHash && off.length === 0 && early.length === 0;
    const answers = calls.map((c) => `${c.status}${c.retryAfter ? `(${c.retryAfter} s)` : ""}`).join(" ");
    say(ok, `${at} answers ${answers}; caps ${steps}; ${tx.size} bytes${sameHash ? "" : `, blockhash not the device's`}${early.length ? `; ${early.length} call(s) asked before the Retry-After passed` : ""}${off.length ? `; refused: ${off.join("; ")}` : `; ${JUDGED.join(",")} pass`}`);
  }
  const wall = Number(r.wallMs);
  say(Number.isFinite(wall) && wall <= SOLANA_TRADE_BUILD_WAIT_MS, `the legs' builds: ${builds} Jupiter calls, ${waits} waited out, wall time ${(wall / 1000).toFixed(1)} s (bound ${SOLANA_TRADE_BUILD_WAIT_MS / 1000} s)`);
  return { ok: lines.length > 0 && lines.every((x) => x.startsWith("ok ")), lines };
}

async function get(base, path) {
  const r = await fetch(`${base}${path}`, { redirect: "error", credentials: "omit", headers: { "cache-control": "no-cache" } });
  return { status: r.status, body: await r.text() };
}

// Both providers' reads of the keys, at processed, at most 10 keys a getMultipleAccounts (solana-rpc.publicnode.com's cap).
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

export async function read({ base = BASE, token, noWait = false, legs: count = LEGS } = {}) {
  base = base.replace(/\/$/, "");
  if (!Number.isInteger(count) || count < LEGS || count > MAX_LEGS) throw new Error(`--legs must be ${LEGS} to ${MAX_LEGS}`);
  const readAt = new Date().toISOString();
  if (!token) {
    const l = await get(base, "/v1/market/lists?chain=solana");
    if (l.status !== 200) throw new Error(`Solana lists: HTTP ${l.status}`);
    const lists = JSON.parse(l.body)?.lists ?? {};
    const rows = ["trending_1h", "trending", "trending_5m", "graduating", "new"].flatMap((k) => (Array.isArray(lists[k]) ? lists[k] : []));
    const pick = rows.find((t) => typeof t?.token === "string" && t.token !== SOLANA_SOL_MINT && t.launchpad === "pump.fun" && Number(t.liq_usd ?? 0) >= 50_000);
    if (!pick) throw new Error("no listed pump.fun token with $50k of liquidity");
    token = pick.token;
  }
  // public RPCs answer 429 or time out under load: up to 4 tries each, 1, 2 and 4 s apart (a read, never a judgement)
  const rpcAgain = (rpc) => Object.assign(async (m, p) => {
    for (let i = 0; ; i++) {
      try { return await rpc(m, p); } catch (e) { if (i >= 3 || !/HTTP 429|timeout/i.test(e.message)) throw e; await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i)); }
    }
  }, { url: rpc.url });
  const rpcs = RPCS.map((u) => rpcAgain(solanaJsonRpc(u)));
  const blockhash = await readSolanaBlockhash(rpcs[0]);
  const live = { reads: { accounts: await readAccounts(rpcs, [token]) }, blockhash };
  const fitFor = (req) => async (build) => {
    const keys = build.tables.filter((k) => !live.reads.accounts[k]);
    if (keys.length) Object.assign(live.reads.accounts, await readAccounts(rpcs, keys));
    return assembler(live, req)(build);
  };
  const room = new SolanaBuildRoom({ total: count, boundMs: SOLANA_TRADE_BUILD_WAIT_MS });
  const t0 = performance.now();
  const legs = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const wallet = base58(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const req = { side: "buy", wallet, token, amount: amountOf(i), slippageBps: SLIPPAGE_BPS };
    const calls = [];
    const known = [];
    const keep = async (url, init) => {
      const sentAt = performance.now() - t0;
      let res;
      let body;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(SOLANA_BUILD_TIMEOUT_MS) });
        body = await res.text();
      } catch (e) {
        // a call the helper did not answer is kept too, as status 0
        calls.push({ url, status: 0, body: "", ms: performance.now() - t0 - sentAt, sentAt, error: String(e?.message ?? e).slice(0, 120) });
        throw e;
      }
      const retryAfter = res.headers.get("retry-after");
      calls.push({ url, status: res.status, body, ms: performance.now() - t0 - sentAt, sentAt, ...(retryAfter !== null ? { retryAfter } : {}) });
      return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "", ...(retryAfter !== null ? { "retry-after": retryAfter } : {}) } });
    };
    const w = room.wait;
    const wait = { ...w, knownCap: () => { const k = w.knownCap(); known.push(k ?? null); return k; } };
    try {
      const f = await fetchSolanaJupiterBuildThatFits(base, req, fitFor(req), { fetch: keep, ...(noWait ? {} : { wait }) });
      room.fitted(f.maxAccounts);
    } catch { /* judged on replay */ } finally {
      room.done();
    }
    return { wallet, calls, known };
  }));
  const wallMs = performance.now() - t0;
  return { base, readAt, mint: token, legs, wallMs, reads: { rpcs: RPCS, accounts: live.reads.accounts }, blockhash };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read({ base: opt("--base", BASE), token: opt("--token"), noWait: a.includes("--no-wait"), legs: Number(opt("--legs", LEGS)) });
    // `mint`, not `token`, in the record: gitleaks' generic-api-key rule reads a long value after "token" as a key
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = await judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, token ${answer.mint}, ${answer.legs.length} legs)`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
