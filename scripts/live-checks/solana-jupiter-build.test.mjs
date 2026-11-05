// node --test scripts/live-checks/solana-jupiter-build.test.mjs: the live check replays recorded runs
// (solana-jupiter-build.answers.json), each a real read of HELPER_HOST and two public Solana RPCs, through the kit's own
// fetchSolanaJupiterBuildThatFits, the cap search a device's trade builds with (card solana-uncapped-fits, fold 2).
// Every run is a fresh read of 2026-11-05 04:20-04:27Z, the listed token 9cRCn9rG…pump (Token-2022) each time:
// - good (04:26Z), the no-route token 7qhBEdrM…pump (no route at 40, a route at 64 when probed): its buy and sell
//   asked 40 (no route) then 48, which fit; the listed token's at 40: PASS.
// - good_shared (04:20Z), the no-route token HAHxvDK2…Bxp4: the listed token's buy and sell answered as
//   shared_accounts_route_v2 with the Token-2022 side through Jupiter's authority's ATA, the no-route buy at 48 1,219
//   bytes: PASS.
// - good_3 (04:22Z), the no-route token 7oHgyiaT…V7gi: PASS.
// - bad_no_route (04:23Z), the token 6toJJ4p1…U8S, which Jupiter routes at no cap (40, 48, 60 in the run; 40, 64 and
//   uncapped read after): its shapes end no_route: FAIL. The check's probe now passes such a token over (it asks 64).
// Made from them, each FAIL: the no-route token's buy answered at 40 (not the retry path); its 48 route and the 44 one
// the search asks next each over 1,232 bytes (too_large); a shape the helper answered 503; a call it never answered;
// a record whose first call was asked without maxAccounts=40; the listed buy's destination not the wallet's account
// (S6); the listed sell's outAmount raised 12 % (S7); the listed token's mint read as transfer_fee_mint, the real
// TransferFeeConfig mint HuAXPy…CUa7 read on both public RPCs at 00:37Z (S6, both listed shapes).
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
const NAMES = ["S-1 buy, a listed token", "S-1 buy, a token with no route at 40", "S-2 sell, a listed token", "S-2 sell, a token with no route at 40"];
const capOf = (url) => new URL(url).searchParams.get("maxAccounts");

for (const key of ["good", "good_shared", "good_3"]) {
  test(`recorded ${key} run: the four shapes build as a device's trade does and assemble within 1,232 bytes: PASS`, async () => {
    const r = await judge(A[key]);
    assert.equal(r.ok, true, r.lines.join("\n"));
    for (const name of NAMES) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && / \d{3,4} bytes \(limit 1232\)/.test(l)), name);
    // the no-route token's shapes are the device's retry path: 40 had no route, 48 fit
    for (const name of [NAMES[1], NAMES[3]]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 no route, 48 fits, ")), name);
    for (const name of [NAMES[0], NAMES[2]]) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${name}: `) && l.includes(", caps 40 fits, ")), name);
  });
}

test("every recorded call asked maxAccounts, and the no-route token was probed at 40 and 64 before it was used", () => {
  for (const key of ["good", "good_shared", "good_3", "bad_no_route"]) for (const s of A[key].shapes) for (const c of s.calls) assert.match(String(capOf(c.url)), /^\d+$/, `${key} ${s.name}`);
  assert.deepEqual(A.good.probes.at(-1), { mint: A.good.mints.noRoute, at40: "no route", at64: "route" });
});

test("recorded run whose no-route token Jupiter routes at no cap: its two shapes end no_route: FAIL", async () => {
  const r = await judge(A.bad_no_route);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), [
    'BAD S-1 buy, a token with no route at 40: no_route: no route (40 no_route, 48 no_route, 60 no_route) (HTTP 400 {"error":"No routes found"})',
    'BAD S-2 sell, a token with no route at 40: no_route: no route (40 no_route, 48 no_route, 60 no_route) (HTTP 400 {"error":"No routes found"})',
  ]);
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
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD S-1 buy, a token with no route at 40: too_large: no build within 1232 bytes \(40 no_route, 48 too_large \d{4}, 44 too_large \d{4}\)/);
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

test("recorded shared-route run: the listed token's buy and sell are shared_accounts_route_v2 and pass S1, S6, S7 and S10 with the frame: PASS", async () => {
  const r = await judge(A.good_shared);
  assert.equal(r.ok, true, r.lines.join("\n"));
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
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], new RegExp(`^BAD S-1 buy, a listed token: .* by shared_accounts_route_v2, .*; refused: S6 destination ${planted} is not the wallet's account `));
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
  assert.equal(bad(r).length, 1);
  const minOut = (raised * 9_000n) / 10_000n;
  assert.match(bad(r)[0], new RegExp(`^BAD S-2 sell, a listed token: .* by shared_accounts_route_v2, .*; refused: S7 floor \\d+ \\(quoted \\d+ at 1000 bps\\) vs minOut ${minOut}$`));
});

test("made from the shared-route run: the listed token's mint charges a transfer fee: both its shapes FAIL on S6", async () => {
  const g = copy(A.good_shared);
  g.reads.accounts[g.mints.listed] = A.transfer_fee_mint.read;
  const r = await judge(g);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r).map((l) => l.split(":")[0]), [`BAD ${NAMES[0]}`, `BAD ${NAMES[2]}`]);
  for (const [i, l] of bad(r).entries()) assert.match(l, new RegExp(`; refused: S6 program ${i === 0 ? "destination" : "source"} account \\w+ is Jupiter's authority's account of the Token-2022 mint ${g.mints.listed}: the mint charges a transfer fee \\(TransferFeeConfig\\)$`));
});
