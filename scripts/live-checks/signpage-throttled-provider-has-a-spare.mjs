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
// Every read goes through provider-answer.mjs (rpcAnswer with the page's Origin, preflight as the page's browser sends
// it): a seat that refuses the page, a JSON-RPC error or a wrong count FAILs; a seat's no-answer (a 429, a 5xx, no
// answer) is INCONCLUSIVE, never a pass.
// The census that chose the spare (Chrome, 11 Nov) is in PROBE below and in the answers file.
// After: sign
// Bundle: out both public Solana seats' CORS answers to the page's origin and their mainnet reads of the stable accounts
//   node scripts/live-checks/signpage-throttled-provider-has-a-spare.mjs [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the run, for the test's replay
// (signpage-throttled-provider-has-a-spare.answers.json). Reads only: no key, no transaction, never the helper.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { EXIT, pageRefuses, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const SIGN = "https://confidential.unrealized.trade";
/** The seat, in its order (provider A, then its spares), as the page's source names it: the second spare since card
 *  move-sends-or-says-why (solanavibestation, the one where a page walks when provider A and Pocket both fail). */
export const SEATS = ["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network", "https://public.rpc.solanavibestation.com"];
/** The pause between a seat's reads of one stable account each (see read()). */
export const READ_GAP_MS = 1_200;
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

/** The verdict on a run { index, app: { sha384, names: [url...] }, seats: { [url]: { preflight: preflight()'s answer,
 *  post: rpcAnswer()'s status, acao and noAnswer or error, and of a result `accounts` (the value's accounts that are
 *  there) and `sha256` (the value's JSON hashed: the Token program alone is some 130 KB, so the run keeps the hash) } } }:
 *  { verdict: PASS | FAIL | INCONCLUSIVE, ok, lines }. */
export function check(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  say(pin !== undefined && pin === a.app?.sha384, `the served /app.js is the one index.html pins`);
  for (const u of SEATS) say((a?.app?.names ?? []).includes(u), `the page's script names the seat ${u}`);
  const hashes = [];
  for (const u of SEATS) {
    const s = a?.seats?.[u];
    // a refusal of the page is judged before a no-answer (a non-JSON 403 is both): the page gets nothing there
    const p = s?.preflight;
    const off = preflightRefuses(u, p, SIGN);
    if (off !== null) say(false, off);
    else if (p?.noAnswer !== undefined) (quiet = true), lines.push(`NO-ANSWER ${p.noAnswer}`);
    else say(true, `${u} preflight from ${SIGN}: ${p.status}, allow-origin ${p.acao}`);
    const q = s?.post;
    const no = pageRefuses(u, q, SIGN);
    if (no === null && q?.noAnswer !== undefined) {
      quiet = true;
      lines.push(`NO-ANSWER ${q.noAnswer}`);
      hashes.push(undefined);
      continue;
    }
    const listed = no === null && q?.noAnswer === undefined && q?.error === undefined && q?.accounts === STABLE.length && typeof q?.sha256 === "string";
    say(listed, no ?? `${u} getMultipleAccounts of the ${STABLE.length} stable accounts: ${q?.error !== undefined ? `error ${JSON.stringify(q.error).slice(0, 80)}` : `${q?.accounts ?? 0} there`}`);
    hashes.push(listed ? q.sha256 : null);
  }
  const read = hashes.filter((h) => h !== undefined);
  if (read.length === SEATS.length) {
    const same = read[0] !== null && read.every((h) => h === read[0]);
    say(same, same ? `every seat answers the same bytes (sha256 ${read[0].slice(0, 16)})` : `the seats answer different bytes: ${SEATS.map((u, i) => `${new URL(u).host} ${hashes[i]?.slice(0, 16) ?? "none"}`).join(", ")}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

/** Reads SIGN_HOST and both seats as the page does (its origin), each through provider-answer.mjs. */
export async function read(fetchFn = fetch) {
  const index = await (await fetchFn(`${SIGN}/`, { signal: AbortSignal.timeout(20_000) })).text();
  const js = await (await fetchFn(`${SIGN}/app.js`, { signal: AbortSignal.timeout(20_000) })).text();
  const run = { at: new Date().toISOString(), index, app: { sha384: sha384(js), names: SEATS.filter((u) => ['"', "'", "`"].some((q) => js.includes(`${q}${u}${q}`))) }, seats: {} };
  for (const u of SEATS) {
    const pre = await preflight(u, SIGN, { fetchFn });
    // one stable account a read, READ_GAP_MS apart, the values joined in STABLE's order: the same JSON as one read of all
    // ten. solanavibestation answers 429 to all ten in one read, and to single reads close behind the ~240 KB of
    // program bytes (read 14 Nov 14:05Z: each alone 200 at 1.2 s apart; back to back 200 200 200 200 429 429 200 429 429 429)
    let a = null;
    const value = [];
    for (const k of STABLE) {
      if (value.length > 0) await new Promise((r) => setTimeout(r, READ_GAP_MS));
      a = await rpcAnswer(u, "getMultipleAccounts", [[k], { encoding: "base64", commitment: "finalized" }], { fetchFn, headers: { origin: SIGN }, redirect: "error" });
      if (a.noAnswer !== undefined || a.error !== undefined || !Array.isArray(a.result?.value)) break;
      value.push(...a.result.value);
    }
    if (a.noAnswer === undefined && a.error === undefined && Array.isArray(a.result?.value)) a = { ...a, result: { value } };
    else if (a.noAnswer === undefined && a.error === undefined) a = { ...a, result: { value: null } };
    const post = { status: a.status ?? null, acao: a.acao ?? null };
    if (a.noAnswer !== undefined) post.noAnswer = a.noAnswer;
    else if (a.error !== undefined) post.error = a.error;
    else {
      const got = a.result?.value;
      post.accounts = Array.isArray(got) ? got.filter((v) => v !== null && typeof v === "object").length : 0;
      post.sha256 = Array.isArray(got) ? createHash("sha256").update(JSON.stringify(got)).digest("hex") : null;
    }
    run.seats[u] = { preflight: pre, post };
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
    console.log(`${v.verdict} signpage-throttled-provider-has-a-spare`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.log(`ERROR signpage-throttled-provider-has-a-spare: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
