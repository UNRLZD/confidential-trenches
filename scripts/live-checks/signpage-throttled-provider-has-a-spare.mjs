#!/usr/bin/env node
// Live check of card signpage-throttled-provider-has-a-spare: the mainnet signing page's public Solana seat is a list,
// publicnode first and Pocket's keyless gateway after it (packages/signpage/src/trade.ts SOLANA_PUBLIC_SEAT), and a read
// that provider A throttles goes to the spare at once. A spare is worth only the bytes it answers: a check holds a public
// seat's answer to the helper's, so a spare that drifts from provider A fails a user's check. This reads, after every
// sign deploy:
//   - SIGN_HOST's index.html and the /app.js it pins (its sha384): the served script names both seats' URLs (as quoted
//     strings; the page's restore pair names the same two, so this holds the hosts, the seat's order is the tests');
//   - each seat's CORS answer to the page's own origin: the preflight of a JSON POST, and the POST's allow-origin;
//   - each seat's getMultipleAccounts of STABLE (ten accounts whose bytes do not change: programs, and the pool program
//     the page pins), finalized, base64: the same value on both, every account there.
// It passes when the script names both, each seat allows the page's origin, and the two values are byte for byte one.
// The census that chose the spare (Chrome, 11 Nov) is in PROBE below and in the answers file.
// After: sign
//   node scripts/live-checks/signpage-throttled-provider-has-a-spare.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2. --record writes the run, for the test's replay
// (signpage-throttled-provider-has-a-spare.answers.json). Reads only: no key, no transaction, never the helper.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export const SIGN = "https://confidential.unrealized.trade";
/** The seat, in its order (provider A, then the spare), as the page's source names it. */
export const SEATS = ["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network"];
/** Ten accounts whose bytes never change: native and loader-held programs, and the mainnet pool program the page pins
 *  (packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet). Ten is publicnode's cap for one getMultipleAccounts. */
export const STABLE = [
  "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
];
/** The census of 11 Nov 2026, from Chrome on the build Mac (scripts/browsers.mjs), mainnet, reads only. */
export const PROBE = {
  pocket: "05:26:39-05:26:43Z: CORS open; getSlot, getBlockHeight, getEpochInfo, getLatestBlockhash, getAccountInfo, getMultipleAccounts, getBalance, getTokenAccountsByOwner, getMinimumBalanceForRentExemption, getTransaction, getSignatureStatuses, getSignaturesForAddress, getProgramAccounts and getFeeForMessage answered; the same bytes as publicnode on getAccountInfo, getMultipleAccounts, getMinimumBalanceForRentExemption, getTransaction and getSignatureStatuses; 05:31Z a fresh transaction (3VKFsLRX...) the same on both, getTransaction (6472 chars) and getBlockTime; 05:28:35-05:28:45Z 40 getAccountInfo in 10 s, 40 answered",
  solanavibestation: "05:26:44-05:26:47Z: 429 from its fourth read; 05:28:57-05:29:07Z 40 getAccountInfo in 10 s, 11 answered, the first refusal at +502 ms (an HTML 429, no Retry-After the page can read)",
  publicnode: "05:29:19-05:29:29Z 60 getAccountInfo in 10 s, 60 answered; 05:29:41-05:29:51Z 60 mixed reads (6 methods), 60 answered",
  others: "05:18-05:19Z: api.mainnet-beta and api.mainnet 403 Access forbidden to a page; dRPC 400 (free plan); Ankr a key; OnFinality 429; Alchemy's demo and Solana Tracker no CORS or no answer",
};

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const allows = (o) => o === "*" || o === SIGN;

/** The verdict on a run { index, app: { sha384, names: [url...] }, seats: { [url]: { preflight: { status, allow,
 *  headers }, post: { status, allow, accounts, sha256 } } } }: `accounts` the value's accounts that are there, `sha256`
 *  the value's JSON hashed (the Token program alone is some 130 KB, so the run keeps the hash). */
export function check(a) {
  const lines = [];
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.index ?? "")?.[1];
  say(pin !== undefined && pin === a.app?.sha384, `the served /app.js is the one index.html pins`);
  for (const u of SEATS) say((a.app?.names ?? []).includes(u), `the page's script names the seat ${u}`);
  const hashes = [];
  for (const u of SEATS) {
    const s = a.seats?.[u];
    const p = s?.preflight;
    say(p !== undefined && p.status >= 200 && p.status < 300 && allows(p.allow) && (p.headers === "*" || /(^|,)\s*content-type\s*(,|$)/i.test(p.headers ?? "")), `${u} preflight from ${SIGN}: ${p ? `${p.status}, allow-origin ${p.allow ?? "none"}, allow-headers ${p.headers ?? "none"}` : "not read"}`);
    const q = s?.post;
    const listed = q?.accounts === STABLE.length && typeof q?.sha256 === "string";
    say(q !== undefined && q.status === 200 && allows(q.allow) && listed, `${u} getMultipleAccounts of the ${STABLE.length} stable accounts: ${q ? `${q.status}, allow-origin ${q.allow ?? "none"}, ${q.accounts ?? 0} there${q.error ? `, error ${JSON.stringify(q.error).slice(0, 80)}` : ""}` : "not read"}`);
    hashes.push(listed ? q.sha256 : null);
  }
  const same = hashes.length === SEATS.length && hashes[0] !== null && hashes.every((h) => h === hashes[0]);
  say(same, same ? `both seats answer the same bytes (sha256 ${hashes[0].slice(0, 16)})` : `the seats answer different bytes: ${SEATS.map((u, i) => `${new URL(u).host} ${hashes[i]?.slice(0, 16) ?? "none"}`).join(", ")}`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** Reads SIGN_HOST and both seats as the page does (its origin), once each. */
export async function read() {
  const index = await (await fetch(`${SIGN}/`, { signal: AbortSignal.timeout(20_000) })).text();
  const js = await (await fetch(`${SIGN}/app.js`, { signal: AbortSignal.timeout(20_000) })).text();
  const run = { at: new Date().toISOString(), index, app: { sha384: sha384(js), names: SEATS.filter((u) => ['"', "'", "`"].some((q) => js.includes(`${q}${u}${q}`))) }, seats: {} };
  for (const u of SEATS) {
    const seat = {};
    try {
      const p = await fetch(u, { method: "OPTIONS", headers: { Origin: SIGN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }, signal: AbortSignal.timeout(15_000) });
      seat.preflight = { status: p.status, allow: p.headers.get("access-control-allow-origin"), headers: p.headers.get("access-control-allow-headers") };
    } catch (e) {
      seat.preflight = { status: 0, error: String(e?.message ?? e) };
    }
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", Origin: SIGN }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [STABLE, { encoding: "base64", commitment: "finalized" }] }), signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => null);
      const value = j?.result?.value;
      const accounts = Array.isArray(value) ? value.filter((v) => v !== null && typeof v === "object").length : 0;
      seat.post = { status: r.status, allow: r.headers.get("access-control-allow-origin"), accounts, sha256: Array.isArray(value) ? createHash("sha256").update(JSON.stringify(value)).digest("hex") : null, ...(j?.error ? { error: j.error } : {}) };
    } catch (e) {
      seat.post = { status: 0, error: String(e?.message ?? e), accounts: 0, sha256: null };
    }
    run.seats[u] = seat;
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const run = await read();
    const rec = process.argv.indexOf("--record");
    if (rec > 0) writeFileSync(process.argv[rec + 1], JSON.stringify(run, null, 1));
    const v = check(run);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? "PASS signpage-throttled-provider-has-a-spare" : "FAIL signpage-throttled-provider-has-a-spare");
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.log(`ERROR signpage-throttled-provider-has-a-spare: ${e?.message ?? e}`);
    process.exit(2);
  }
}
