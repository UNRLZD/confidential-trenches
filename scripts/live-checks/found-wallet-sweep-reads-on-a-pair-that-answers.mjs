#!/usr/bin/env node
// Live check of card found-wallet-sweep-reads-on-a-pair-that-answers: after a restore every fresh Solana trade wallet the
// device finds holding SOL is a found W, and its leftover goes back into the pool only once two providers of different
// companies list its token accounts alike (packages/signpage/src/pool-sell.ts foundTokenAccounts and ownsNoTokens). The
// page's public seat answers no getTokenAccountsByOwner (publicnode -32602, Pocket -32602 and -32010), so the found path
// reads on its own pair (src/pool-testnet.ts pageSolanaTokenRpcs): Solana Vibe Station's keyless endpoint, device-direct,
// and the helper's /v1/rpc/solana. This reads, after every sign deploy:
//   - SIGN_HOST's index.html and the /app.js it pins (its sha384): the served script names the token seat's URL (quoted);
//   - each of the pair's CORS answer to the page's origin: the preflight of a JSON POST (the seat; the helper's own
//     preflight is held by its checks), and the POST's allow-origin;
//   - each one's getTokenAccountsByOwner of OWNER under both token programs, finalized, no data: a list on both, the
//     same accounts on both.
// It passes when the script names the seat, both admit the page, and both list OWNER's accounts alike under each program.
// Every read goes through provider-answer.mjs (rpcAnswer with the page's Origin): a JSON-RPC error (publicnode's -32602
// "Request blocked", Pocket's -32010) or a refusal of the page FAILs; a no-answer (a 429, a 5xx, no answer) is
// INCONCLUSIVE, never a pass.
// After: sign
// Bundle: out the found W's token-account pair's CORS answers to the page's origin and their mainnet lists of one owner
//   node scripts/live-checks/found-wallet-sweep-reads-on-a-pair-that-answers.mjs [--record <file>] [--seat <url>]
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes the run, for the test's replay
// (found-wallet-sweep-reads-on-a-pair-that-answers.answers.json); --seat reads another URL in the seat's place (the
// recorded bad answers: today's public seat). Reads only: no key, no transaction, no wallet of ours.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { EXIT, pageRefuses, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

export const SIGN = "https://confidential.unrealized.trade";
/** The page's token seat (packages/signpage/src/pool-testnet.ts SOLANA_TOKEN_SEAT). */
export const SEAT = "https://public.rpc.solanavibestation.com";
/** The pair's other member: the helper's route (pageSolanaTokenRpcs' second). */
export const HELPER = "https://ct-api.unrealized.trade/v1/rpc/solana";
export const PAIR = [SEAT, HELPER];
/** An owner whose token accounts move rarely: 116 under Token and 18 under Token-2022, the same on both, read
 *  2026-11-13 18:03Z. Public chain data, no wallet of ours. */
export const OWNER = "11111111111111111111111111111112";
export const PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The verdict on a run { index, app: { sha384, names }, providers: { [url]: { preflight?, lists: { [program]: { status,
 *  acao, noAnswer | error | { count, sha256 } } } } } }: { verdict, ok, lines }. */
export function check(a) {
  const lines = [];
  let quiet = false;
  const say = (ok, m) => lines.push(`${ok ? "OK" : "BAD"} ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  say(pin !== undefined && pin === a.app?.sha384, "the served /app.js is the one index.html pins");
  say((a?.app?.names ?? []).includes(SEAT), `the page's script names the token seat ${SEAT}`);
  const read = Object.keys(a?.providers ?? {});
  say(read.length === PAIR.length && PAIR.every((u) => read.includes(u)), `the pair read is the page's: ${read.join(", ") || "none"}`);
  const sets = Object.fromEntries(PROGRAMS.map((p) => [p, []]));
  for (const u of read) {
    const s = a.providers[u];
    if (s.preflight !== undefined) {
      const off = preflightRefuses(u, s.preflight, SIGN);
      if (off !== null) say(false, off);
      else if (s.preflight.noAnswer !== undefined) (quiet = true), lines.push(`NO-ANSWER ${s.preflight.noAnswer}`);
      else say(true, `${u} preflight from ${SIGN}: ${s.preflight.status}, allow-origin ${s.preflight.acao}`);
    }
    for (const p of PROGRAMS) {
      const q = s.lists?.[p];
      const no = pageRefuses(u, q, SIGN);
      if (no === null && q?.noAnswer !== undefined) {
        quiet = true;
        lines.push(`NO-ANSWER ${q.noAnswer}`);
        continue;
      }
      const listed = no === null && q?.error === undefined && Number.isSafeInteger(q?.count) && typeof q?.sha256 === "string";
      say(listed, no ?? `${u} getTokenAccountsByOwner of ${OWNER} under ${p.slice(0, 8)}: ${q?.error !== undefined ? `error ${JSON.stringify(q.error).slice(0, 120)}` : `${q.count} accounts`}`);
      sets[p].push(listed ? q.sha256 : null);
    }
  }
  for (const p of PROGRAMS) {
    if (sets[p].length !== PAIR.length || sets[p].includes(null)) continue;
    const same = sets[p].every((h) => h === sets[p][0]);
    say(same, same ? `both list the same accounts under ${p.slice(0, 8)} (sha256 ${sets[p][0].slice(0, 16)})` : `the two list apart under ${p.slice(0, 8)}`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

/** Reads SIGN_HOST, then the pair as the page does (its origin), `seat` in the seat's place. */
export async function read(fetchFn = fetch, seat = SEAT) {
  const index = await (await fetchFn(`${SIGN}/`, { signal: AbortSignal.timeout(20_000) })).text();
  const js = await (await fetchFn(`${SIGN}/app.js`, { signal: AbortSignal.timeout(20_000) })).text();
  const run = { at: new Date().toISOString(), index, app: { sha384: sha384(js), names: [SEAT].filter((u) => ['"', "'", "`"].some((q) => js.includes(`${q}${u}${q}`))) }, providers: {} };
  for (const u of [seat, HELPER]) {
    const entry = { lists: {} };
    if (u !== HELPER) entry.preflight = await preflight(u, SIGN, { fetchFn });
    for (const p of PROGRAMS) {
      const a = await rpcAnswer(u, "getTokenAccountsByOwner", [OWNER, { programId: p }, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }], { fetchFn, headers: { origin: SIGN }, redirect: "error" });
      const q = { status: a.status ?? null, acao: a.acao ?? null };
      if (a.noAnswer !== undefined) q.noAnswer = a.noAnswer;
      else if (a.error !== undefined) q.error = a.error;
      else {
        const v = Array.isArray(a.result?.value) ? a.result.value : null;
        const keys = v === null ? null : v.map((x) => x?.pubkey).filter((k) => typeof k === "string").sort();
        if (keys === null || keys.length !== v.length) q.error = { message: "no list of accounts" };
        else Object.assign(q, { count: keys.length, sha256: sha256(keys.join(",")) });
      }
      entry.lists[p] = q;
      // the seat's pace (SOLANA_TOKEN_SEAT_LIMIT: one call each 1.25 s)
      await new Promise((ok) => setTimeout(ok, 1_300));
    }
    run.providers[u] = entry;
  }
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const s = process.argv.indexOf("--seat");
    const run = await read(fetch, s > 0 ? process.argv[s + 1] : SEAT);
    const rec = process.argv.indexOf("--record");
    if (rec > 0) writeFileSync(process.argv[rec + 1], JSON.stringify(run, null, 1));
    const v = check(run);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} found-wallet-sweep-reads-on-a-pair-that-answers`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.log(`ERROR found-wallet-sweep-reads-on-a-pair-that-answers: ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
