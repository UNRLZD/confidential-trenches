// node --test scripts/live-checks/helper-launchpad-origin.test.mjs: the live check replays recorded answers
// (helper-launchpad-origin.answers.json). good: apps/helper on card/helper-launchpad-origin run on a Mac against the real
// Jupiter and a public Solana RPC, with every account and Jupiter answer the re-read got: PASS. bad_deployed: the
// deployed helper before this card (Jupiter's tags as is: "revshare", which the app cannot draw, and "metadao", which
// no launch on chain backs; no `unsettled`): FAIL. Made from the good answer: a tagged row's pad swapped for another
// app pad, an untagged settled row given a tag, a tag the app does not draw, `unsettled` missing or naming a tagged
// token: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP, BASE, JUP, RPC, judge, read, reread, sample } from "./helper-launchpad-origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-launchpad-origin.answers.json"), "utf8"));
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// a fetch answering the helper's recorded answer, Jupiter's recorded search and each account from the recording; a
// request the recording does not hold fails the test
const replay = (a, body = a.answer.body) => async (url, init) => {
  if (url.startsWith(BASE)) {
    assert.equal(url, `${BASE}/v1/market/lists?chain=solana`);
    assert.equal(init.headers.origin, APP);
    return new Response(body, { status: a.answer.status });
  }
  if (url.startsWith(JUP)) return json(a.jupiter);
  assert.equal(url, RPC);
  const keys = JSON.parse(init.body).params[0];
  for (const k of keys) assert.ok(Object.hasOwn(a.accounts, k), `unrecorded account ${k}`);
  return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: keys.map((k) => a.accounts[k]) } });
};
const run = async (a, edit) => {
  const s = JSON.parse(a.answer.body);
  if (edit) edit(s);
  const body = JSON.stringify(s);
  const r = await read(BASE, replay(a, body));
  const origins = await reread(sample(s.lists ?? {}, s.unsettled), replay(a, body));
  return judge(r, origins);
};
const rows = (s) => ["new", "trending_5m", "trending_1h"].flatMap((k) => s.lists[k]);
const everywhere = (s, token, f) => {
  for (const k of Object.keys(s.lists)) for (const r of s.lists[k]) if (r.token === token) f(r);
};

test("good: the helper on this card, its sampled tags re-read on chain: PASS", async () => {
  const r = await run(A.good);
  assert.ok(r.ok, r.lines.filter((l) => !l.startsWith("ok")).join("\n"));
  assert.ok(r.lines.some((l) => /tagged rows re-read on chain: [1-9]/.test(l)));
});

test("bad_deployed: the deployed helper before this card (Jupiter's tags as is, no unsettled): FAIL", async () => {
  const r = await run(A.bad_deployed);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && l.includes('"metadao"')), "an unbacked tag named");
});

test("made from good: a tag swapped, a tag on an untagged row, a tag the app does not draw, unsettled wrong: each FAIL", async () => {
  const s0 = JSON.parse(A.good.answer.body);
  const tagged = sample(s0.lists, s0.unsettled).find((r) => r.launchpad === "pump.fun");
  const untagged = sample(s0.lists, s0.unsettled).find((r) => r.launchpad === null);
  for (const [name, edit] of [
    ["swapped", (s) => everywhere(s, tagged.token, (r) => (r.launchpad = "letsbonk.fun"))],
    ["untagged row tagged", (s) => everywhere(s, untagged.token, (r) => (r.launchpad = "pump.fun"))],
    ["a pad the app does not draw", (s) => (rows(s).find((r) => r.launchpad === null).launchpad = "moonshot")],
    ["unsettled missing", (s) => delete s.unsettled],
    ["unsettled names a tagged token", (s) => s.unsettled.push(tagged.token)],
  ]) {
    const r = await run(A.good, edit);
    assert.equal(r.ok, false, name);
  }
});
