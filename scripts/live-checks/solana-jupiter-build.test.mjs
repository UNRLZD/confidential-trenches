// node --test scripts/live-checks/solana-jupiter-build.test.mjs: the live check replays recorded runs
// (solana-jupiter-build.answers.json), each a real read of HELPER_HOST at 7001a7e and two public Solana RPCs on
// 2026-11-02, through the kit's own fetchSolanaJupiterBuild. good (05:06Z): an SPL Token pump.fun token, the four
// shapes at 739 to 769 bytes: PASS. good_token2022 (05:56Z): the Token-2022 pump.fun token ExxzYBTt…pump, 819 to 923
// bytes, a two-table sell route: PASS. bad_oversize (05:05Z): a token whose uncapped sell route (GoonFi V2 + Kipseli +
// Raydium CLMM + Whirlpool) assembles to 1,244 bytes, refused too_large: FAIL. good and bad_oversize were recorded
// before the check called the kit (one call per shape, {query, status, body}); each is kept as that one call, under
// the URL the kit asks. Made from the good run: the capped buy answered "No routes found" first, retried uncapped:
// PASS; a shape the helper answered 503; a record whose URL is not the kit's query: each FAIL. good_shared (06:34Z): the
// Token-2022 token DEW9dSN6…WDP, whose two sells /build answered as shared_accounts_route_v2 (1,067 and 1,225 bytes), every
// shape judged on S1, S6, S7 and S10 too: PASS. Made from it: the capped sell's destination changed to an account that
// is not the wallet's: FAIL; the capped sell's outAmount raised 12 % in the answer, so the floor in the signed bytes is
// below the floor this check asked for: FAIL on S7.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { base58, judge } from "./solana-jupiter-build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "solana-jupiter-build.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const NAMES = ["S-1 buy, maxAccounts=40", "S-1 buy, uncapped", "S-2 sell, maxAccounts=40", "S-2 sell, uncapped"];

for (const key of ["good", "good_token2022", "good_shared"]) {
  test(`recorded ${key} run: the four shapes build through the helper and assemble within 1,232 bytes: PASS`, async () => {
    const r = await judge(A[key]);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const name of NAMES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && / \d{3,4} bytes \(limit 1232\)/.test(l)), name);
  });
}

test("the Token-2022 run reads a Token-2022 mint and a two-table route", async () => {
  const r = await judge(A.good_token2022);
  assert.ok(r.lines.includes("ok  mint ExxzYBTt3jwU5MUxuw2F4toYbTLdFwThSjyaCn6Xpump read equal on both providers, owner TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  assert.ok(r.lines.some((l) => l.startsWith("ok  S-2 sell, maxAccounts=40: 819 bytes") && l.includes("2 table(s)")));
});

test("recorded oversize build: the uncapped sell assembles to 1,244 bytes and is refused: FAIL", async () => {
  const r = await judge(A.bad_oversize);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD S-2 sell, uncapped: refused: too_large: 1244 bytes > 1232 (route GoonFi V2 + Kipseli + Raydium CLMM + Whirlpool)"]);
});

test("made from the good run: no route at maxAccounts=40, then the kit's one uncapped retry: PASS", async () => {
  const g = copy(A.good);
  const capped = g.shapes[0].calls[0];
  const uncappedUrl = g.shapes[1].calls[0].url;
  g.shapes[0].calls = [{ ...capped, status: 400, body: '{"error":"No routes found"}' }, { ...g.shapes[1].calls[0], url: uncappedUrl }];
  const r = await judge(g);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("ok  S-1 buy, maxAccounts=40: ") && l.includes("(no route at 40, retried uncapped)")));
});

test("made from the good run: a shape the helper answered 503 upstream: FAIL", async () => {
  const g = copy(A.good);
  g.shapes[2].calls[0] = { ...g.shapes[2].calls[0], status: 503, body: '{"error":{"code":"upstream"}}' };
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ['BAD S-2 sell, maxAccounts=40: upstream: HTTP 503 (HTTP 503 {"error":{"code":"upstream"}})']);
});

test("made from the good run: a record whose capped call was asked without maxAccounts=40: FAIL", async () => {
  const g = copy(A.good);
  g.shapes[0].calls[0] = { ...g.shapes[0].calls[0], url: g.shapes[0].calls[0].url.replace("&maxAccounts=40", "") };
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  // the replay refuses the kit's call, which the kit reports as a helper that did not answer
  assert.match(bad(r)[0], /^BAD S-1 buy, maxAccounts=40: upstream: the helper did not answer: the kit asked https:\/\/api\.confidential\.unrealized\.trade\/v1\/proxy\/jupiter\/swap\/v2\/build\?/);
});

test("recorded shared-route run: both sells are shared_accounts_route_v2 and pass S1, S6, S7 and S10 with the frame: PASS", async () => {
  const r = await judge(A.good_shared);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const name of NAMES.slice(2)) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(" by shared_accounts_route_v2, ") && l.endsWith("; S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S13 pass")), name);
  }
});

test("made from the shared-route run: the capped sell's destination is not the wallet's account: FAIL", async () => {
  const g = copy(A.good_shared);
  const call = g.shapes[2].calls.at(-1);
  const body = JSON.parse(call.body);
  const planted = base58(new Uint8Array(32).fill(7));
  body.swapInstruction.accounts[5].pubkey = planted;
  call.body = JSON.stringify(body);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], new RegExp(`^BAD S-2 sell, maxAccounts=40: .* by shared_accounts_route_v2, .*; refused: S6 destination ${planted} is not the wallet's account `));
});

test("made from the shared-route run: the capped sell's answered outAmount raised 12 %, above the signed floor: FAIL on S7", async () => {
  const g = copy(A.good_shared);
  const call = g.shapes[2].calls.at(-1);
  const body = JSON.parse(call.body);
  const raised = (BigInt(body.outAmount) * 112n) / 100n;
  body.outAmount = raised.toString();
  call.body = JSON.stringify(body);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  const minOut = (raised * 9_000n) / 10_000n;
  assert.match(bad(r)[0], new RegExp(`^BAD S-2 sell, maxAccounts=40: .* by shared_accounts_route_v2, .*; refused: S7 floor \\d+ \\(quoted \\d+ at 1000 bps\\) vs minOut ${minOut}$`));
});

// good_shared_2022 (card solana-shared-2022-side; 2026-11-05 00:35Z through HELPER_HOST at 30ead05): the Token-2022
// token BZFYNPeQ…B96W, whose four shapes /build answered as shared_accounts_route_v2 with the Token-2022 side through
// Jupiter's authority's ATA (the buys' program destination, the sells' program source), its mint without a transfer fee
// or hook: PASS (the kit at 30ead05 refused all four on S6). transfer_fee_mint: the real reads of the TransferFeeConfig
// mint HuAXPy…CUa7 on both public RPCs at 00:37Z. Made from them: the run with that mint's bytes as the token's mint, so
// both buys' second move out of the authority's ATA could charge a fee: FAIL on S6, the sells still pass.
test("recorded Token-2022 shared run: all four shapes through Jupiter's authority's ATA on the Token-2022 side: PASS", async () => {
  const r = await judge(A.good_shared_2022);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const name of NAMES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(" by shared_accounts_route_v2, ") && l.endsWith("; S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S13 pass")), name);
});

test("made from the Token-2022 shared run: the token's mint charges a transfer fee: both buys FAIL on S6", async () => {
  const g = copy(A.good_shared_2022);
  g.reads.accounts[g.mint] = A.transfer_fee_mint.read;
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.slice(0, 28)), ["BAD S-1 buy, maxAccounts=40:", "BAD S-1 buy, uncapped: 1028 "]);
  for (const l of bad(r)) assert.match(l, new RegExp(`; refused: S6 program destination account \\w+ is Jupiter's authority's account of the Token-2022 mint ${g.mint}: the mint charges a transfer fee \\(TransferFeeConfig\\)$`));
});
