// node --test scripts/live-checks/helper-create-u.test.mjs: the live check replays recorded runs
// (helper-create-u.answers.json). preflight_today: the deployed helper has no hook and carries no mainnet deposits, so
// the check refuses to count (exit 2) for all three reasons. good: the recipient unchanged on two operators: PASS. bad:
// the good run with a planted creation (the account appears, the nonce moves): FAIL for exactly those two reasons. Made
// from the good run: a recipient holding MIN_DEPOSIT, a proxy that did not carry the answer, one operator, a fork,
// reads too soon, another recipient: each FAIL. The bind probe decodes as the helper decodes a delegate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeSignedDelegate } from "../../apps/helper/src/bind/checks.ts";
import { bindProbe, commitHasCode, judge, MIN_DEPOSIT, preflight, refusal, USDC, WAIT_MS } from "./helper-create-u.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-create-u.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => structuredClone(x);
const both = (run, side, f) => {
  const r = clone(run);
  r[side].reads = r[side].reads.map(f);
  return r;
};

test("preflight today: no hook in the deployed commit, mainnet not carried, no gas account pinned: refused, all three named", () => {
  const why = refusal(A.preflight_today);
  assert.match(why, /does not hold this card's code/);
  assert.match(why, /not carried \(POST \/v1\/bind: 400 token_not_accepted\)/);
  assert.match(why, /BIND_RELAYER_MAINNET/);
  const ready = { ...A.preflight_today, has_code: true, bind: { status: 400, code: "bad_shape" }, relayer: "bind.example.near" };
  assert.equal(refusal(ready), null);
  for (const b of [{ status: 503, code: "upstream" }, { status: 400, code: "token_not_accepted" }, { status: 500, code: null }]) assert.notEqual(refusal({ ...ready, bind: b }), null, JSON.stringify(b));
  assert.match(refusal({ ...ready, has_code: false }), /does not hold/);
  assert.match(refusal({ ...ready, relayer: null }), /BIND_RELAYER_MAINNET/);
});

test("the code check reads the commit's own files: this card's commit holds the hook, 7c3b9b9a (no hook) and a bad sha do not", () => {
  assert.equal(commitHasCode("7c3b9b9a83f489a6e58ed9b895675804dca5593f"), false);
  assert.equal(commitHasCode("not-a-sha"), false);
  assert.equal(commitHasCode("HEAD"), false, "a full sha only");
  assert.equal(commitHasCode(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()), true, "the checked-out commit, which holds this card");
});

test("the bind probe decodes as a delegate on mainnet USDC with no action, and preflight reads it", async () => {
  const d = decodeSignedDelegate(new Uint8Array(Buffer.from(JSON.parse(bindProbe()).signed_delegate, "base64")));
  assert.deepEqual([d.receiver_id, d.actions.length], [USDC, 0]);
  const asked = [];
  const fetchFn = async (url, init) => {
    asked.push([init?.method ?? "GET", new URL(url).pathname]);
    return new Response(url.endsWith("/v1/health") ? JSON.stringify({ commit: "7c3b9b9a83f489a6e58ed9b895675804dca5593f" }) : JSON.stringify({ error: { code: "token_not_accepted" } }), { status: url.endsWith("/v1/health") ? 200 : 400 });
  };
  const p = await preflight("https://h.example", fetchFn, () => false);
  assert.deepEqual(asked, [["GET", "/v1/health"], ["POST", "/v1/bind"]]);
  assert.deepEqual([p.commit, p.has_code, p.bind], ["7c3b9b9a83f489a6e58ed9b895675804dca5593f", false, { status: 400, code: "token_not_accepted" }]);
});

test("recorded good run: the proxy carried the delivery, the recipient unchanged on two operators: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
});

test("planted bad run: the recipient created and the gas account's nonce moved: FAIL for those two reasons only", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.equal(b.length, 2, b.join("\n"));
  assert.match(b[0], /^BAD the recipient as before: \{"absent":true,"error":"UNKNOWN_ACCOUNT"\} -> \{"amount":"1820000000000000000000"\}/);
  assert.match(b[1], /^BAD bind\.example\.near: every key nonce as before: .*275866334000015.* -> .*275866334000016/);
  // each reason alone fails it
  const onlyNonce = clone(A.bad);
  onlyNonce.after.reads = onlyNonce.after.reads.map((s, i) => ({ ...s, recipient: A.bad.before.reads[i].recipient }));
  assert.equal(bad(judge(onlyNonce)).length, 1);
  const still = clone(A.bad);
  still.after.reads = still.after.reads.map((s, i) => ({ ...s, nonces: A.bad.before.reads[i].nonces, recipient: A.bad.before.reads[i].recipient }));
  assert.equal(judge(still).ok, true, judge(still).lines.join("\n"));
});

test("made from the good run: MIN_DEPOSIT held, an answer not carried, one operator, a fork, too soon, another recipient: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(both(g, "before", (s) => ({ ...s, usdc: MIN_DEPOSIT.toString() }))).ok, false, "a recipient that holds MIN_DEPOSIT: the run could pay");
  for (const proxy of [null, { ...g.proxy, status: 503 }, { ...g.proxy, body: g.proxy.body.replace('"SUCCESS"', '"PROCESSING"') }, { ...g.proxy, body: "{" }, { ...g.proxy, commit: null }]) assert.equal(judge({ ...g, proxy }).ok, false, JSON.stringify(proxy)?.slice(0, 60));
  const one = clone(g);
  one.after.reads[1].url = "https://archival-rpc.mainnet.fastnear.com";
  assert.match(bad(judge(one)).join("\n"), /after: two operators/);
  assert.equal(judge(both(g, "after", (s, i) => (i === 1 ? { ...s, hash: "x" } : s))).ok, false, "two blocks");
  const soon = clone(g);
  soon.after.readAt = new Date(Date.parse(g.proxy.readAt) + WAIT_MS - 1).toISOString();
  assert.match(bad(judge(soon)).join("\n"), /after: read/);
  assert.equal(judge({ ...g, recipient: "ab".repeat(32) }).ok, false, "another recipient");
});
