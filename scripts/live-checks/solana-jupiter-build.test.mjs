// node --test scripts/live-checks/solana-jupiter-build.test.mjs: the live check replays recorded runs
// (solana-jupiter-build.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's own
// fetchSolanaJupiterBuild. Since card solana-uncapped-fits the retry shapes ask maxAccounts=48, the kit's retry cap, so
// every good run is a fresh read of 2026-11-05 03:43-03:45Z: good, the listed pump.fun token Eg2ymQ2a…2agu (SPL Token),
// four shapes at 707 to 962 bytes: PASS. good_shared, the Token-2022 token DEW9dSN6…WDP, both buys and the capped sell
// shared_accounts_route_v2, 1,000 to 1,065 bytes, a three-table retry sell: PASS. good_shared_2022, the Token-2022 token
// BZFYNPeQ…B96W, whose two sells /build answered as shared_accounts_route_v2 with the Token-2022 side through Jupiter's
// authority's ATA (the sells' program source), its mint without a transfer fee or hook: PASS. bad_retry_too_large, the
// Token-2022 token ExxzYBTt…pump, whose buy at maxAccounts=48 Jupiter answered with a 4-hop route the device assembles to
// 1,276 bytes, refused too_large: FAIL (a cap is Jupiter's estimate of accounts, not bytes; the device's S9 still
// refuses). bad_oversize, the 2026-11-02 05:05Z record from before the card, whose retry shapes were asked without
// maxAccounts: FAIL, on its shape names and on both retry calls, which the kit no longer makes. Made from the good run:
// the capped buy answered "No routes found" first, retried at 48: PASS; a shape the helper answered 503; a record whose
// URL is not the kit's query: each FAIL. Made from good_shared: the capped buy's destination changed to an account that
// is not the wallet's: FAIL; its outAmount raised 12 % in the answer, so the floor in the signed bytes is below the floor
// this check asked for: FAIL on S7. transfer_fee_mint: the real reads of the TransferFeeConfig mint HuAXPy…CUa7 on both
// public RPCs at 2026-11-05 00:37Z; made from good_shared_2022 with those bytes as the token's mint: FAIL on S6, both
// sells (their extra move into the authority's ATA could charge a fee).
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
const NAMES = ["S-1 buy, maxAccounts=40", "S-1 buy, retry at maxAccounts=48", "S-2 sell, maxAccounts=40", "S-2 sell, retry at maxAccounts=48"];

for (const key of ["good", "good_shared", "good_shared_2022"]) {
  test(`recorded ${key} run: the four shapes build through the helper and assemble within 1,232 bytes: PASS`, async () => {
    const r = await judge(A[key]);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const name of NAMES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && / \d{3,4} bytes \(limit 1232\)/.test(l)), name);
  });
}

test("every good run's retry shapes asked maxAccounts=48, never without it", () => {
  for (const key of ["good", "good_shared", "good_shared_2022"]) {
    for (const i of [1, 3]) {
      const calls = A[key].shapes[i].calls;
      assert.equal(calls.length, 1, `${key} ${i}`);
      assert.equal(new URL(calls[0].url).searchParams.get("maxAccounts"), "48", `${key} ${i}`);
    }
  }
});

test("the Token-2022 run reads a Token-2022 mint and a three-table retry sell", async () => {
  const r = await judge(A.good_shared);
  assert.ok(r.lines.includes("ok  mint DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP read equal on both providers, owner TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
  assert.ok(r.lines.some((l) => l.startsWith("ok  S-2 sell, retry at maxAccounts=48: 1034 bytes") && l.includes("3 table(s)")));
});

test("recorded too-large retry build: the buy at maxAccounts=48 assembles to 1,276 bytes and is refused: FAIL", async () => {
  const r = await judge(A.bad_retry_too_large);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD S-1 buy, retry at maxAccounts=48: refused: too_large: 1276 bytes > 1232 (route Whirlpool + TesseraV + Pump.fun Amm + Whirlpool)"]);
});

test("recorded run from before the card, its retry shapes asked without maxAccounts: FAIL", async () => {
  const r = await judge(A.bad_oversize);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 3, b.join("\n"));
  assert.equal(b[0], "BAD the four shapes: S-1 buy, maxAccounts=40; S-1 buy, uncapped; S-2 sell, maxAccounts=40; S-2 sell, uncapped");
  // the kit asks its retry at maxAccounts=48; the record holds the old calls without maxAccounts, so the replay refuses
  for (const [i, shape, side] of [[1, 1, "S-1 buy"], [2, 3, "S-2 sell"]]) {
    assert.equal(new URL(A.bad_oversize.shapes[shape].calls[0].url).searchParams.has("maxAccounts"), false);
    assert.ok(b[i].startsWith(`BAD ${side}, uncapped: upstream: the helper did not answer: the kit asked https://api.confidential.unrealized.trade/v1/proxy/jupiter/swap/v2/build?`), b[i]);
  }
});

test("made from the good run: no route at maxAccounts=40, then the kit's one retry at 48: PASS", async () => {
  const g = copy(A.good);
  const capped = g.shapes[0].calls[0];
  g.shapes[0].calls = [{ ...capped, status: 400, body: '{"error":"No routes found"}' }, { ...g.shapes[1].calls[0] }];
  const r = await judge(g);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("ok  S-1 buy, maxAccounts=40: ") && l.includes("(no route at 40, retried at 48)")));
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

test("recorded shared-route run: both buys and the capped sell are shared_accounts_route_v2 and pass S1, S6, S7 and S10 with the frame: PASS", async () => {
  const r = await judge(A.good_shared);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const name of NAMES.slice(0, 3)) {
    assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(" by shared_accounts_route_v2, ") && l.endsWith("; S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S13 pass")), name);
  }
});

test("made from the shared-route run: the capped buy's destination is not the wallet's account: FAIL", async () => {
  const g = copy(A.good_shared);
  const call = g.shapes[0].calls.at(-1);
  const body = JSON.parse(call.body);
  const planted = base58(new Uint8Array(32).fill(7));
  body.swapInstruction.accounts[5].pubkey = planted;
  call.body = JSON.stringify(body);
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], new RegExp(`^BAD S-1 buy, maxAccounts=40: .* by shared_accounts_route_v2, .*; refused: S6 destination ${planted} is not the wallet's account `));
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

test("recorded Token-2022 shared run: both sells through Jupiter's authority's ATA on the Token-2022 side: PASS", async () => {
  const r = await judge(A.good_shared_2022);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const name of NAMES.slice(2)) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(" by shared_accounts_route_v2, ") && l.endsWith("; S1,S2,S3,S4,S5,S6,S7,S8,S9,S10,S13 pass")), name);
});

test("made from the Token-2022 shared run: the token's mint charges a transfer fee: both sells FAIL on S6", async () => {
  const g = copy(A.good_shared_2022);
  g.reads.accounts[g.mint] = A.transfer_fee_mint.read;
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), NAMES.slice(2).map((n) => `BAD ${n}`));
  for (const l of bad(r)) assert.match(l, new RegExp(`; refused: S6 program source account \\w+ is Jupiter's authority's account of the Token-2022 mint ${g.mint}: the mint charges a transfer fee \\(TransferFeeConfig\\)$`));
});
