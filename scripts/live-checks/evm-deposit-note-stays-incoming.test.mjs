// node --test scripts/live-checks/evm-deposit-note-stays-incoming.test.mjs: card evm-deposit-note-stays-incoming's
// live check, replayed. evm-deposit-note-stays-incoming.answers.json holds a real run of the EVM deposit path's state
// reads on the page's Base and Robinhood mainnet pool pairs (good: every read answered on both seats, with the facts of
// this card's build of the bundle: no state read at an old tag) and the bad run: SIGN_HOST's bundle before this card's
// deploy (two eth_getTransactionCount reads at "finalized") and a real run of that read on the same pairs (Robinhood's
// own node refuses it with -32000 "historical state ... is not available"). Good passes, both bad answers fail, and
// planted refusals of the new reads fail too. The bundle half alone (the part scripts/ci/bundle-checks.mjs runs on a
// build) passes a pinned bundle and fails an old state read, a seat missing and another pin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bundleFacts, check, judgeBundleOnly, pagePairs, readBundle, replayer } from "./evm-deposit-note-stays-incoming.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-note-stays-incoming.answers.json", import.meta.url), "utf8"));
const run = (r, o = {}) => check(replayer(r.log), { pairs: r.pairs, bundle: r.bundle, sleep: async () => {}, ...o });
const REFUSED = { code: -32000, message: "historical state bac0f84b9ba5e79e767198a3fb6d8dacc874bc06b584baf3a3e35c8ebda3f78d is not available" };

test("the check reads the page's own pool pairs, and the good run is a run on them", () => {
  assert.deepEqual(A.good.pairs, pagePairs());
});

test("the recorded good run passes: every state read of the path answered on both seats of Base and Robinhood", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.match(r.lines[0], /^the bundle file:app\.js \([0-9a-f]{16}, \d+ bytes\): no state read at an old block's tag; it names every seat \(4\)$/);
  assert.match(r.lines[1], /^base \(base-rpc\.publicnode\.com, base\.api\.pocket\.network\): newest agreed block \d+; .* all answered$/);
  assert.match(r.lines[2], /^robinhood \(rpc\.mainnet\.chain\.robinhood\.com, robinhood\.api\.pocket\.network\): newest agreed block \d+; .* all answered$/);
});

test("the recorded bad run: SIGN_HOST's bundle before this card holds U's nonce read at finalized, and fails", async () => {
  const r = await run(A.before);
  assert.equal(r.verdict, "FAIL");
  assert.equal(A.before.bundle.url, "https://confidential.unrealized.trade/app.js");
  assert.match(r.lines.at(-1), /holds 2 state read\(s\) at an old block's tag: `eth_getTransactionCount`,\[i\.address,`finalized`\] \| `eth_getTransactionCount`,\[t\.u,`finalized`\]$/);
});

test("the recorded bad run, the read the path made before (U's nonce at finalized), fails on Robinhood's refusal", async () => {
  const r = await run(A.before, { before: true, bundle: { ...A.before.bundle, oldStateReads: [] } });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.at(-1), /^rpc\.mainnet\.chain\.robinhood\.com: U's nonce at finalized: RPC error -32000: historical state [0-9a-f]+ is not available$/);
});

test("planted: a seat that refuses U's nonce at the newest block's hash, or at its number, fails", async () => {
  for (const pick of [(e) => typeof e.params[1] === "object", (e) => typeof e.params[1] === "string" && e.params[1] !== "latest"]) {
    const log = A.good.log.map((e) => (e.url === A.good.pairs[1].seats[0] && e.method === "eth_getTransactionCount" && pick(e) ? { url: e.url, method: e.method, params: e.params, error: REFUSED } : e));
    const r = await run({ ...A.good, log });
    assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
    assert.match(r.lines.at(-1), /^rpc\.mainnet\.chain\.robinhood\.com: U's nonce at the newest .*RPC error -32000: historical state/);
  }
});

test("planted: a seat whose finalized header is refused, or two seats on different final blocks, fail", async () => {
  const noFin = A.good.log.map((e) => (e.url === A.good.pairs[0].seats[1] && e.method === "eth_getBlockByNumber" && e.params[0] === "finalized" ? { url: e.url, method: e.method, params: e.params, error: { code: -32000, message: "finalized block not supported" } } : e));
  assert.equal((await run({ ...A.good, log: noFin })).verdict, "FAIL");
  const lowOf = (seat) => A.good.log.filter((e) => e.url === seat && e.method === "eth_getBlockByNumber" && /^0x/.test(e.params[0])).at(-1);
  const last = lowOf(A.good.pairs[0].seats[1]);
  const fork = A.good.log.map((e) => (e === last ? { ...e, result: { ...e.result, hash: `0x${"22".repeat(32)}` } } : e));
  const r = await run({ ...A.good, log: fork });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.at(-1), /^base: the seats hold different final blocks at \d+ on 5 reads$/);
});

test("planted: a moment's fork (two seats on different blocks at one number, then one block) is read again and passes, as the page's lag retry reads it; so is a seat that refuses U's state at the newest block once", async () => {
  const seat = A.good.pairs[0].seats[1];
  for (const final of [false, true]) {
    const at = A.good.log.filter((e) => e.url === seat && e.method === "eth_getBlockByNumber" && /^0x/.test(e.params[0]))[final ? 1 : 0];
    const log = A.good.log.flatMap((e) => (e === at ? [{ ...e, result: { ...e.result, hash: `0x${"22".repeat(32)}` } }, e] : [e]));
    const waits = [];
    const r = await run({ ...A.good, log }, { sleep: async (ms) => void waits.push(ms) });
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    assert.deepEqual(waits, [2_000], final ? "the final blocks" : "the newest block");
  }
  const once = A.good.log.flatMap((e) => (e.url === A.good.pairs[1].seats[0] && e.method === "eth_getBalance" ? [{ url: e.url, method: e.method, params: e.params, error: REFUSED }, e] : [e]));
  const waits = [];
  const r = await run({ ...A.good, log: once }, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(waits, [2_000], "refused once: read again from the newest block, once");
  // refused on every read: a failure, named, after the last read
  const always = A.good.log.map((e) => (e.url === A.good.pairs[1].seats[0] && e.method === "eth_getBalance" ? { url: e.url, method: e.method, params: e.params, error: REFUSED } : e));
  const waited = [];
  const bad = await run({ ...A.good, log: always }, { sleep: async (ms) => void waited.push(ms) });
  assert.equal(bad.verdict, "FAIL");
  assert.equal(waited.length, 4);
  assert.match(bad.lines.at(-1), /U's balance at the newest block \d+: RPC error -32000: historical state [0-9a-f]+ is not available \(on 5 reads\)$/);
});

test("bundleFacts: a state read at a finalized or safe tag is found in any quote style; reads at the newest block or a hash are not; a seat it lacks is named", () => {
  const pairs = [{ chain: "base", seats: ["https://a.example", "https://b.example"] }];
  const old = bundleFacts("x(`eth_getTransactionCount`,[u,`finalized`]);y(\"eth_getBalance\",[u,\"safe\"]);z('eth_call',[{to:p},'finalized'])", pairs);
  assert.equal(old.oldStateReads.length, 3);
  const fresh = bundleFacts("x(`eth_getTransactionCount`,[u,{blockHash:c.hash}]);y(`eth_getBalance`,[u,t]);h(`eth_getBlockByNumber`,[`finalized`,!1]);https://a.example", pairs);
  assert.deepEqual(fresh.oldStateReads, []);
  assert.deepEqual(fresh.seats, { "https://a.example": true, "https://b.example": false });
});

test("planted: a bundle that does not name a seat of the pairs fails; no bundle read fails", async () => {
  const r = await run({ ...A.good, bundle: { ...A.good.bundle, seats: { ...A.good.bundle.seats, [A.good.pairs[1].seats[1]]: false } } });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.at(-1), /names no https:\/\/robinhood\.api\.pocket\.network: not the page's pairs$/);
  assert.equal((await run(A.good, { bundle: undefined })).verdict, "FAIL");
});

test("planted: a seat that answers nothing on every try is INCONCLUSIVE, never a pass; a pair of one seat fails", async () => {
  const quiet = A.good.log.map((e) => (e.url === A.good.pairs[1].seats[1] && e.method === "eth_getBalance" ? { url: e.url, method: e.method, params: e.params, noAnswer: "robinhood.api.pocket.network HTTP 429" } : e));
  assert.equal((await run({ ...A.good, log: quiet })).verdict, "INCONCLUSIVE");
  const one = await run({ ...A.good, pairs: [{ ...A.good.pairs[0], seats: [A.good.pairs[0].seats[0]] }] });
  assert.equal(one.verdict, "FAIL");
  assert.equal(one.lines.at(-1), "base: the pool list seats 1 providers, not two");
});

// the bundle half alone, as scripts/ci/bundle-checks.mjs runs it on a build: SIGN_HOST's index and the script it pins
const served = (js, pin) => async (u) => {
  const p = new URL(String(u)).pathname;
  if (p === "/") return new Response(`<script type="module" src="/app.js" integrity="${pin ?? `sha384-${createHash("sha384").update(js).digest("base64")}`}"></script>`, { status: 200 });
  if (p === "/app.js") return new Response(js, { status: 200 });
  return new Response("", { status: 404 });
};
const seated = (more = "") => `${pagePairs().flatMap((p) => p.seats).map((u) => `"${u}"`).join(",")};${more}`;
test("the bundle half alone: a pinned bundle naming every seat and no old state read PASSes; an old state read, a seat missing or another pin FAILs", async () => {
  assert.equal(judgeBundleOnly(await readBundle(served(seated()))).ok, true);
  const old = judgeBundleOnly(await readBundle(served(seated("e(`eth_getTransactionCount`,[t.u,`finalized`])"))));
  assert.equal(old.ok, false);
  assert.match(old.lines[0], /^BAD the bundle .* holds 1 state read\(s\) at an old block's tag/);
  const seats = pagePairs().flatMap((p) => p.seats);
  assert.equal(judgeBundleOnly(await readBundle(served(seated().replace(`"${seats[0]}"`, "")))).ok, false);
  assert.deepEqual(judgeBundleOnly(await readBundle(served(seated(), "sha384-other"))).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
});
