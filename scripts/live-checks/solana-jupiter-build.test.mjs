// node --test scripts/live-checks/solana-jupiter-build.test.mjs: the live check replays recorded runs
// (solana-jupiter-build.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's own
// fetchSolanaJupiterBuildThatFits, the cap search a device's trade builds with (card solana-uncapped-fits).
// - good_found (2026-11-06 00:52Z, card jupiter-check-token-shape): the no-route token 8sjupmtp…sZxu found at run time
//   after four candidates passed over (three route at 40, Jupiter refuses one), its buy and sell asked once each, 40
//   no route then 48, which fit: PASS.
// - fixed_mint (00:53Z): 1znxCqDU…qyNd, the token the check met on 2026-11-06, named: its sell routes at 40: FAIL.
// - no_shape: good_found's real answers with its token of the shape left out: NO-SHAPE, never a PASS.
// read() itself runs on markets made of the good run's answers: one that answers a second ask differently, one with no
// token of the shape, one whose first candidate Jupiter refuses.
// - good (2026-11-05 05:37Z, the pace and the probe of folds 3 and 4): the listed token CniPCE4b…pump at 40; the
//   no-route token 3cn1tDL4…WhcV probed on both sides (no route at 40, fits at 48 on the device's assembly; the sell of
//   what the buy quoted out), its buy and sell asked 40 (no route) then 48, which fit; 14 Jupiter calls, at most 8 in a
//   counted minute: PASS.
// - bad_too_large (05:02Z, the probe before it judged fit): the no-route token 3JHceq2R…NfT8 routes at 60 only, 1,284
//   and 1,249 bytes, so the 3 builds end too_large: FAIL. The probe now passes such a token over.
// - good_shared (04:20Z, before send times were kept): the listed token 9cRCn9rG…pump's buy and sell answered as
//   shared_accounts_route_v2 with the Token-2022 side through Jupiter's authority's ATA: every shape PASSes, the pace
//   line FAILs (no send times).
// - bad_no_route (04:23Z), the token 6toJJ4p1…U8S, which Jupiter routes at no cap: its shapes end no_route: FAIL.
// Made from them, each FAIL: calls sent 3 s apart (more than 8 a counted minute); a call with no send time; the
// no-route token's buy answered at 40 (not the retry path); its 48 route and the 44 one the search asks next each over
// 1,232 bytes (too_large); a shape the helper answered 503; a call it never answered; a record whose first call was
// asked without maxAccounts=40; the listed buy's destination not the wallet's account (S6); the listed sell's
// outAmount raised 12 % (S7); the listed token's mint read as transfer_fee_mint, the real TransferFeeConfig mint
// HuAXPy…CUa7 read on both public RPCs at 00:37Z (S6, both listed shapes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JUPITER_PER_MINUTE, PACE_MS, base58, judge, mostIn, read } from "./solana-jupiter-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-jupiter-build.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
// a shape's own lines: the runs recorded before fold 3 have no send times, so their pace line is BAD (asserted below)
const shapeBad = (r) => bad(r).filter((l) => l.startsWith("BAD S-"));
const PACE_BAD = /^BAD the run's \d+ Jupiter calls, at most \d+ in a counted minute \(the helper lends 8 on the total alone\), some with no send time$/;
const copy = (x) => JSON.parse(JSON.stringify(x));
const NAMES = ["S-1 buy, a listed token", "S-1 buy, a token with no route at 40", "S-2 sell, a listed token", "S-2 sell, a token with no route at 40"];
const capOf = (url) => new URL(url).searchParams.get("maxAccounts");

for (const key of ["good"]) {
  test(`recorded ${key} run: the four shapes build as a device's trade does and assemble within 1,232 bytes: PASS`, async () => {
    const r = await judge(A[key]);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const name of NAMES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && / \d{3,4} bytes \(limit 1232\)/.test(l)), name);
    // the no-route token's shapes are the device's retry path: 40 had no route, 48 fit
    for (const name of [NAMES[1], NAMES[3]]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 no route, 48 fits, ")), name);
    for (const name of [NAMES[0], NAMES[2]]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 fits, ")), name);
  });
}

test("every recorded call asked maxAccounts, and the no-route token was probed on both sides at 40 and within the search's reach", () => {
  for (const key of ["good", "good_shared", "bad_no_route", "bad_too_large"]) for (const s of A[key].shapes) for (const c of s.calls) assert.match(String(capOf(c.url)), /^\d+$/, `${key} ${s.name}`);
  const p = A.good.probes.at(-1);
  assert.equal(p.mint, A.good.mints.noRoute);
  assert.equal(p.buy.at40, "no route");
  assert.equal(p.sell.at40, "no route");
  // the sell probe sells what the buy probe quoted out, the size the sell shape sells
  assert.match(p.sell.amount, /^[1-9]\d*$/);
  // (in this record the probe's buy and the buy shape quoted the same out amount, 265817113977)
  assert.equal(p.sell.amount, A.good.amounts.noRoute.sell);
  assert.match(p.buy.reach, /^fits at (48|60)$/);
  assert.match(p.sell.reach, /^fits at (48|60)$/);
});

// Card solana-uncapped-fits, fold 3: the helper lends a client 8 Jupiter draws a counted minute on the total alone
// (apps/helper/src/limits/limits.ts LEND_FREE_SHARES 2 x the share 4); past them a run gets 429 whenever another
// device is active, so the check keeps every run, probes counted, at 8 a minute or fewer.
test("the pace: one Jupiter call every 8 s is at most 8 in any counted minute (61 s), and 9 is counted", () => {
  assert.equal(JUPITER_PER_MINUTE, 8);
  assert.equal(PACE_MS, 8_000);
  const paced = Array.from({ length: 30 }, (_, i) => i * PACE_MS);
  assert.equal(mostIn(paced), 8);
  assert.equal(mostIn([0, 8_000, 16_000, 24_000, 32_000, 40_000, 48_000, 56_000, 60_000]), 9);
  assert.equal(mostIn(Array.from({ length: 30 }, (_, i) => i * 3_000)), 21); // fold 2's 3 s pace
});

test("recorded good run: every Jupiter call, probes counted, has its send time, at most 8 in a counted minute", async () => {
  const sent = [...A.good.probes.flatMap((p) => p.sentAt), ...A.good.shapes.flatMap((s) => s.calls.map((c) => c.sentAt))];
  assert.ok(sent.length >= 7 && sent.every(Number.isFinite), String(sent));
  assert.ok(mostIn(sent) <= JUPITER_PER_MINUTE, String(mostIn(sent)));
  const r = await judge(A.good);
  assert.ok(r.lines.includes(`ok  the run's ${sent.length} Jupiter calls, at most ${mostIn(sent)} in a counted minute (the helper lends 8 on the total alone)`), r.lines.join("\n"));
});

test("made from the good run: its calls sent 3 s apart, more than 8 in a counted minute: FAIL", async () => {
  const g = copy(A.good);
  let t = 0;
  for (const p of g.probes) p.sentAt = p.sentAt.map(() => (t += 3_000));
  for (const s of g.shapes) for (const c of s.calls) c.sentAt = t += 3_000;
  const n = g.probes.reduce((k, p) => k + p.sentAt.length, 0) + g.shapes.reduce((k, s) => k + s.calls.length, 0);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [`BAD the run's ${n} Jupiter calls, at most ${Math.min(n, 21)} in a counted minute (the helper lends 8 on the total alone)`]);
});

test("made from the good run: a call with no send time: FAIL", async () => {
  const g = copy(A.good);
  delete g.shapes[0].calls[0].sentAt;
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD the run's \d+ Jupiter calls, at most \d+ in a counted minute \(the helper lends 8 on the total alone\), some with no send time$/);
});

test("recorded run whose no-route token Jupiter routes at no cap: its two shapes end no_route: FAIL", async () => {
  const r = await judge(A.bad_no_route);
  assert.equal(r.ok, false);
  assert.deepEqual(shapeBad(r), [
    'BAD S-1 buy, a token with no route at 40: no_route: no route (40 no_route, 48 no_route, 60 no_route) (HTTP 400 {"error":"No routes found"})',
    'BAD S-2 sell, a token with no route at 40: no_route: no route (40 no_route, 48 no_route, 60 no_route) (HTTP 400 {"error":"No routes found"})',
  ]);
});

test("recorded run whose no-route token routes only at 60, over 1,232 bytes: its two shapes end too_large after 3 builds: FAIL", async () => {
  const r = await judge(A.bad_too_large);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.replace(/ \(HTTP 200 .*$/, "")), [
    "BAD S-1 buy, a token with no route at 40: too_large: no build within 1232 bytes (40 no_route, 48 no_route, 60 too_large 1284)",
    "BAD S-2 sell, a token with no route at 40: too_large: no build within 1232 bytes (40 no_route, 48 no_route, 60 too_large 1249)",
  ]);
  assert.ok(r.lines.includes("ok  the run's 30 Jupiter calls, at most 8 in a counted minute (the helper lends 8 on the total alone)"));
});

test("made from the good run: the no-route token's buy answered at 40, so it is not the retry path: FAIL", async () => {
  const g = copy(A.good);
  const [first, second] = g.shapes[1].calls;
  g.shapes[1].calls = [{ ...second, url: first.url }];
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.replace(/\(.*\)/, "(…)")), ["BAD S-1 buy, a token with no route at 40: the token routes at 40 (…), so this is not the retry path"]);
});

test("made from the good run: the no-route buy's 48 route and the 44 one the search asks next are over 1,232 bytes: FAIL too_large", async () => {
  const g = copy(A.good);
  const s = g.shapes[1];
  const body = JSON.parse(s.calls[1].body);
  // 40 more accounts no lookup table holds, as a route through fresh pools has
  body.swapInstruction.accounts.push(...Array.from({ length: 40 }, (_, i) => ({ pubkey: base58(new Uint8Array(32).fill(100 + i)), isSigner: false, isWritable: false })));
  s.calls[1].body = JSON.stringify(body);
  s.calls.push({ ...s.calls[1], url: s.calls[1].url.replace("maxAccounts=48", "maxAccounts=44") });
  const r = await judge(g);
  assert.equal(r.ok, false);
  // the planted ninth call also makes the run 9 in a counted minute; this test is the shape's
  assert.equal(shapeBad(r).length, 1);
  assert.match(shapeBad(r)[0], /^BAD S-1 buy, a token with no route at 40: too_large: no build within 1232 bytes \(40 no_route, 48 too_large \d{4}, 44 too_large \d{4}\)/);
});

test("made from the good run: a shape the helper answered 503 upstream: FAIL", async () => {
  const g = copy(A.good);
  g.shapes[2].calls[0] = { ...g.shapes[2].calls[0], status: 503, body: '{"error":{"code":"upstream"}}' };
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ['BAD S-2 sell, a listed token: upstream: HTTP 503 (HTTP 503 {"error":{"code":"upstream"}})']);
});

test("made from the good run: a call the helper never answered (kept as status 0): FAIL", async () => {
  const g = copy(A.good);
  g.shapes[3].calls[1] = { ...g.shapes[3].calls[1], status: 0, body: "", ms: 0, error: "The operation was aborted due to timeout" };
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD S-2 sell, a token with no route at 40: upstream: the helper did not answer: The operation was aborted due to timeout/);
});

test("made from the good run: a record whose first call was asked without maxAccounts=40: FAIL", async () => {
  const g = copy(A.good);
  g.shapes[0].calls[0] = { ...g.shapes[0].calls[0], url: g.shapes[0].calls[0].url.replace("&maxAccounts=40", "") };
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  // the replay refuses the kit's call, which the kit reports as a helper that did not answer
  assert.match(bad(r)[0], /^BAD S-1 buy, a listed token: upstream: the helper did not answer: the kit asked https:\/\/api\.confidential\.unrealized\.trade\/v1\/proxy\/jupiter\/swap\/v2\/build\?/);
});

test("recorded shared-route run (before send times were kept): the listed token's buy and sell are shared_accounts_route_v2 and pass S1, S6, S7 and S10 with the frame; its pace line alone FAILs", async () => {
  const r = await judge(A.good_shared);
  assert.deepEqual(shapeBad(r), [], r.lines.join("\n"));
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], PACE_BAD);
  assert.ok(r.lines.includes("ok  listed mint 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump read equal on both providers, owner TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  for (const name of [NAMES[0], NAMES[2]]) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(" by shared_accounts_route_v2, ") && l.endsWith("; S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S13 pass")), name);
  }
});

test("made from the shared-route run: the listed buy's destination is not the wallet's account: FAIL on S6", async () => {
  const g = copy(A.good_shared);
  const call = g.shapes[0].calls.at(-1);
  const body = JSON.parse(call.body);
  const planted = base58(new Uint8Array(32).fill(7));
  body.swapInstruction.accounts[5].pubkey = planted;
  call.body = JSON.stringify(body);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(shapeBad(r).length, 1);
  assert.match(shapeBad(r)[0], new RegExp(`^BAD S-1 buy, a listed token: .* by shared_accounts_route_v2, .*; refused: S6 destination ${planted} is not the wallet's account `));
});

test("made from the shared-route run: the listed sell's answered outAmount raised 12 %, above the signed floor: FAIL on S7", async () => {
  const g = copy(A.good_shared);
  const call = g.shapes[2].calls.at(-1);
  const body = JSON.parse(call.body);
  const raised = (BigInt(body.outAmount) * 112n) / 100n;
  body.outAmount = raised.toString();
  call.body = JSON.stringify(body);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(shapeBad(r).length, 1);
  const minOut = (raised * 9_000n) / 10_000n;
  assert.match(shapeBad(r)[0], new RegExp(`^BAD S-2 sell, a listed token: .* by shared_accounts_route_v2, .*; refused: S7 floor \\d+ \\(quoted \\d+ at 1000 bps\\) vs minOut ${minOut}$`));
});

test("made from the shared-route run: the listed token's mint charges a transfer fee: both its shapes FAIL on S6", async () => {
  const g = copy(A.good_shared);
  g.reads.accounts[g.mints.listed] = A.transfer_fee_mint.read;
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(shapeBad(r).map((l) => l.split(":")[0]), [`BAD ${NAMES[0]}`, `BAD ${NAMES[2]}`]);
  for (const [i, l] of shapeBad(r).entries()) assert.match(l, new RegExp(`; refused: S6 program ${i === 0 ? "destination" : "source"} account \\w+ is Jupiter's authority's account of the Token-2022 mint ${g.mints.listed}: the mint charges a transfer fee \\(TransferFeeConfig\\)$`));
});

// Card jupiter-check-token-shape: the no-route token is found at run time and its asks are its shapes.
// A market for read() made of the good run's real answers, served by mint pair and cap in the order asked; a pair and
// cap the market does not hold answers "No routes found". `twice` answers a second ask differently, as Jupiter did on
// 2026-11-06 (live run 42135737951: the probe's buy fit, the same buy a minute later had no route at 40, 48 or 60).
const NO_ROUTE = JSON.stringify({ error: "No routes found" });
const unB58 = (s) => {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(ch));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
};
const pairOf = (url) => { const q = new URL(url).searchParams; return `${q.get("inputMint")}|${q.get("outputMint")}|${q.get("maxAccounts")}`; };
function market(t, { lists, answers, accounts = {} }) {
  const g = A.good;
  const reads = { ...g.reads.accounts, ...accounts };
  const asked = new Map();
  // the run's taker is the good run's (its answers name it); every other random read stays random
  const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let taken = false;
  t.mock.method(globalThis.crypto, "getRandomValues", (a) => { if (taken || a.length !== 32) return random(a); taken = true; a.set(unB58(g.wallet)); return a; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/market/lists?chain=solana")) return new Response(JSON.stringify({ lists }), { status: 200 });
    const rpc = g.reads.rpcs.findIndex((x) => u.startsWith(x));
    if (rpc >= 0) {
      const { id, method, params } = JSON.parse(init.body);
      const ctx = { slot: g.blockhash.slot ?? 1 };
      const result = method === "getLatestBlockhash"
        ? { context: ctx, value: { blockhash: g.blockhash.blockhash, lastValidBlockHeight: g.blockhash.lastValidBlockHeight } }
        : { context: ctx, value: params[0].map((k) => { const a = reads[k]?.[rpc]; return a ? { owner: a.owner, data: [a.data, "base64"], lamports: 1, executable: false, rentEpoch: 0 } : null; }) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    }
    const k = pairOf(u);
    const n = asked.get(k) ?? 0;
    asked.set(k, n + 1);
    const list = answers[k];
    const c = list?.[Math.min(n, list.length - 1)];
    return c ? new Response(c.body, { status: c.status, headers: { "content-type": "application/json" } }) : new Response(NO_ROUTE, { status: 400 });
  });
  return asked;
}
// the good run's answers by mint pair and cap
const SOL = "So11111111111111111111111111111111111111112";
const recorded = () => {
  const m = {};
  for (const s of A.good.shapes) for (const c of s.calls) (m[pairOf(c.url)] ??= []).push(c);
  return m;
};
const clock = () => { let t = Date.parse("2026-11-06T01:00:00Z"); return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const LISTED = { token: A.good.mints.listed, launchpad: "pump.fun", liq_usd: 1e6 };
const SHAPED = { token: A.good.mints.noRoute };

test("read() on a market whose no-route token answers a second ask differently: the shapes are the candidate's own asks, never asked again: PASS", async (t) => {
  const answers = recorded();
  const buy40 = `${SOL}|${A.good.mints.noRoute}|40`;
  const buy48 = `${SOL}|${A.good.mints.noRoute}|48`;
  // asked again, the buy at 40 routes (the 48 answer, at 40): a run that asks the shape again is not on the retry path
  answers[buy40] = [answers[buy40][0], { ...answers[buy48][0] }];
  const asked = market(t, { lists: { trending_1h: [LISTED], new: [SHAPED] }, answers });
  const r = await read({ ...clock() });
  const v = await judge(r);
  assert.equal(asked.get(buy40), 1, "the no-route buy at 40 asked once");
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(r.mints.noRoute, A.good.mints.noRoute);
  assert.deepEqual(r.probes, [{ mint: A.good.mints.noRoute, chosen: true }]);
  for (const name of [NAMES[1], NAMES[3]]) assert.ok(v.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 no route, 48 fits, ")), name);
});

test("read() on a market where the first candidate routes at 40 and the second has no route anywhere: NO-SHAPE, never a PASS, each candidate held to its answers", async (t) => {
  const answers = recorded();
  // the listed token's answers again for another mint: a candidate that routes at 40
  const other = "DABCynB9Ft9gg9oewK3nyjfag467CsALsXtMm9f1tgcf";
  answers[`${SOL}|${other}|40`] = answers[`${SOL}|${A.good.mints.listed}|40`];
  for (const cap of [40, 48]) { delete answers[`${SOL}|${A.good.mints.noRoute}|${cap}`]; delete answers[`${A.good.mints.noRoute}|${SOL}|${cap}`]; }
  // its mint read as the listed token's (the assembly needs the mint's program)
  market(t, { lists: { trending_1h: [LISTED], new: [{ token: other }, SHAPED] }, answers, accounts: { [other]: A.good.reads.accounts[A.good.mints.listed] } });
  const r = await read({ ...clock() });
  const v = await judge(r);
  assert.equal(v.verdict, "NO-SHAPE", v.lines.join("\n"));
  assert.equal(v.ok, false);
  assert.equal(r.mints.noRoute, null);
  assert.ok(v.lines.includes("NONE no token with no route at 40 and a fitting one within the search's reach, buy and sell, among 2 candidates"), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith(`ok  candidate ${other}: buy 40 fits: routes at 40, passed over`)), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith(`ok  candidate ${A.good.mints.noRoute}: buy no_route: no route (40 no_route, 48 no_route, 60 no_route): no fitting route within the search's reach, passed over`)), v.lines.join("\n"));
  // the no-shape record with a passed-over candidate's answers made into the shape's: FAIL, a token of the shape passed over
  const g = copy(r);
  const shaped = recorded();
  const p = g.probes[1];
  p.buy.calls = [...shaped[`${SOL}|${A.good.mints.noRoute}|40`], ...shaped[`${SOL}|${A.good.mints.noRoute}|48`]];
  p.sell = { amount: A.good.amounts.noRoute.sell, calls: [...shaped[`${A.good.mints.noRoute}|${SOL}|40`], ...shaped[`${A.good.mints.noRoute}|${SOL}|48`]], market: [] };
  g.reads.accounts = { ...A.good.reads.accounts, ...g.reads.accounts };
  const w = await judge(g);
  assert.equal(w.verdict, "FAIL");
  assert.ok(bad(w).some((l) => l.startsWith(`BAD candidate ${A.good.mints.noRoute}: buy 40 no route, 48 fits; sell 40 no route, 48 fits: the token has the shape, yet it was passed over`)), w.lines.join("\n"));
});

test("made from the good run: the search stops at 40 with no route where the check's own ask at 48 fits: FAIL, the retry path is broken", async () => {
  const g = copy(A.good);
  const s = g.shapes[1];
  s.market = [s.calls[1]];
  s.calls = [s.calls[0]];
  const r = await judge(g);
  assert.equal(r.verdict, "FAIL");
  assert.equal(shapeBad(r).length, 1);
  assert.match(shapeBad(r)[0], /^BAD S-1 buy, a token with no route at 40: .*; maxAccounts=48 answers a route that fits in \d{3,4} bytes: the retry path is broken$/);
});

test("read() on a market whose first candidate Jupiter refuses (its own 400, not \"No routes found\"): passed over, the next candidate's asks are the shapes: PASS", async (t) => {
  const answers = recorded();
  const fresh = "5Lh3doWDujeqfNPbGNPKboGeDJLaS9h8xbGPs91xpump";
  // the answer read 2026-11-06 00:51Z for a mint minutes old
  answers[`${SOL}|${fresh}|40`] = [{ status: 400, body: JSON.stringify({ error: `500: {"error":"Missing token program for ${fresh}"}` }) }];
  market(t, { lists: { trending_1h: [LISTED], new: [{ token: fresh }, SHAPED] }, answers, accounts: { [fresh]: A.good.reads.accounts[A.good.mints.noRoute] } });
  const r = await read({ ...clock() });
  const v = await judge(r);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(r.mints.noRoute, A.good.mints.noRoute);
  assert.ok(v.lines.some((l) => l.startsWith(`ok  candidate ${fresh}: buy upstream: HTTP 400 500: `) && l.endsWith(": Jupiter refuses the token, passed over")), v.lines.join("\n"));
  // the helper's own 503 on a candidate is no refusal: that candidate's shapes FAIL
  const busy = recorded();
  busy[`${SOL}|${fresh}|40`] = [{ status: 503, body: '{"error":{"code":"upstream"}}' }];
  t.mock.restoreAll();
  market(t, { lists: { trending_1h: [LISTED], new: [{ token: fresh }, SHAPED] }, answers: busy, accounts: { [fresh]: A.good.reads.accounts[A.good.mints.noRoute] } });
  const w = await judge(await read({ ...clock() }));
  assert.equal(w.verdict, "FAIL");
  assert.ok(bad(w).some((l) => l.startsWith("BAD S-1 buy, a token with no route at 40: upstream: HTTP 503")), w.lines.join("\n"));
});

test("recorded good_found run (2026-11-06 00:52Z): the no-route token found at run time, its asks its shapes, never asked again: PASS", async () => {
  const g = A.good_found;
  const r = await judge(g);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(g.mints.noRoute, "8sjupmtpnfWCwSBDpnQAiUAfgWDaUurqtpbvwQmxsZxu");
  assert.deepEqual(g.probes.at(-1), { mint: g.mints.noRoute, chosen: true });
  // four candidates passed over, each held to its own answers: three route at 40, Jupiter refuses one
  assert.equal(r.lines.filter((l) => /^ok {2}candidate \w+: buy 40 fits: routes at 40, passed over$/.test(l)).length, 3);
  assert.equal(r.lines.filter((l) => l.startsWith("ok  candidate ") && l.endsWith(": Jupiter refuses the token, passed over")).length, 1);
  for (const name of [NAMES[1], NAMES[3]]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 no route, 48 fits, ")), name);
  // each no-route ask once: no Jupiter call of the token's twice
  const urls = g.shapes.flatMap((s) => s.calls.map((c) => c.url));
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(r.lines.includes("ok  the run's 10 Jupiter calls, at most 8 in a counted minute (the helper lends 8 on the total alone)"), r.lines.join("\n"));
});

test("recorded fixed_mint run (00:53Z, --no-route-token 1znxCqDU…qyNd, the mint the check met on 2026-11-06): its sell routes at 40, so not the retry path: FAIL", async () => {
  const r = await judge(A.fixed_mint);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r).map((l) => l.replace(/\(.*\)/, "(…)")), ["BAD S-2 sell, a token with no route at 40: the token routes at 40 (…), so this is not the retry path"]);
});

test("recorded no_shape run (good_found's real answers with its token of the shape left out): NO-SHAPE, never a PASS", async () => {
  const r = await judge(A.no_shape);
  assert.equal(r.verdict, "NO-SHAPE", r.lines.join("\n"));
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), []);
  assert.ok(r.lines.includes("NONE no token with no route at 40 and a fitting one within the search's reach, buy and sell, among 4 candidates"));
  // a candidate's answers dropped: the no-shape verdict has nothing to stand on: FAIL
  const g = copy(A.no_shape);
  delete g.probes[0].buy;
  const w = await judge(g);
  assert.equal(w.verdict, "FAIL");
  assert.deepEqual(bad(w), [`BAD candidate ${g.probes[0].mint}: no recorded answers`]);
});
