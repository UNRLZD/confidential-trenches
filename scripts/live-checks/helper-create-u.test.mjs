// node --test scripts/live-checks/helper-create-u.test.mjs: the live check replays recorded runs
// (helper-create-u.answers.json). good: the deployed helper carried the recorded USDC delivery and nothing reached its
// recipient: PASS. bad: card vault-testnet-t02-deployed's Transfer to U before any delivery (tx 7HgkB1J2…): the
// recipient created and the gas account's nonce moved: FAIL. Made from the good run: a Transfer to the recipient, a
// nonce that moved, a recipient holding MIN_DEPOSIT, a proxy that did not carry the answer, one operator, reads taken
// too soon: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, MIN_DEPOSIT, WAIT_MS } from "./helper-create-u.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-create-u.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => structuredClone(x);
const both = (run, side, f) => {
  const r = clone(run);
  r[side].reads = r[side].reads.map(f);
  return r;
};

test("recorded good run: the deployed proxy carried the delivery, the recipient unchanged on two operators: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.some((l) => l.startsWith("-- the gas account's nonces")), "no mainnet gas account yet: shown, not counted");
});

test("recorded bad run: T02's Transfer before delivery (7HgkB1J2…): the recipient created, the nonce moved: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.ok, false);
  const b = bad(r).join("\n");
  assert.match(b, /BAD the recipient as before: \{"absent":true,"error":"UNKNOWN_ACCOUNT"\} -> \{"amount":"10000000000000000000000"\}/);
  assert.match(b, /BAD bf-vt-20261102t071444\.testnet: every key nonce as before: .*275866334000015.* -> .*275866334000016/);
});

test("made from the good run: a Transfer to the recipient, a moved nonce, MIN_DEPOSIT held, an answer not carried, one operator, a hash that differs, too soon: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(both(g, "after", (s) => ({ ...s, recipient: { amount: "1820000000000000000000" } }))).ok, false, "created");
  const pinned = clone(g);
  pinned.relayer = "bind.example.near";
  for (const side of ["before", "after"]) pinned[side].reads = pinned[side].reads.map((s) => ({ ...s, nonces: { "ed25519:k": side === "before" ? "5" : "6" } }));
  assert.match(bad(judge(pinned)).join("\n"), /every key nonce as before/);
  const still = clone(pinned);
  still.after.reads = still.after.reads.map((s) => ({ ...s, nonces: { "ed25519:k": "5" } }));
  assert.equal(judge(still).ok, true, judge(still).lines.join("\n"));
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
