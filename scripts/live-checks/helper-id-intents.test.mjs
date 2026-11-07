// node --test scripts/live-checks/helper-id-intents.test.mjs: the live check replays recorded runs
// (helper-id-intents.answers.json). good: apps/helper at this card's branch, mainnet bind set and one signer seen:
// PASS. bad_deployed: the deployed helper before this card, POST /v1/intents 404: FAIL. Made from the good run: a 404,
// a gate that answers after the vault refusal, a vault refusal missing, the intents part down, a sent intent, another
// origin, a short commit, a missing read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asks, judge } from "./helper-id-intents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-id-intents.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, name, f) => ({ ...run, reads: run.reads.map((x) => (x.asked === name ? f(x) : x)) });
const answer = (status, code) => (x) => ({ ...x, status, body: JSON.stringify({ error: { code } }) });

test("recorded good run: the probe bad_shape, an unseen signer id_not_ours (to the vault too), a seen signer to the vault receiver_is_vault: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.includes("ok  a seen signer, to the vault: 403 receiver_is_vault (want 403 receiver_is_vault)"), g.lines.join("\n"));
  assert.ok(g.lines.includes("ok  a signer never seen: 403 id_not_ours (want 403 id_not_ours)"), g.lines.join("\n"));
});

test("recorded bad run: the deployed helper before this card answers 404 and its intents part is down: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.ok(bad(d).includes('BAD a signer never seen: 404 {"error":"not_found"} (want 403 id_not_ours)'), bad(d).join("\n"));
  assert.ok(bad(d).includes("BAD health: 200, parts.intents down (want 200, up)"), bad(d).join("\n"));
});

test("made from the good run: each break FAILs", () => {
  const g = A.good;
  const cases = {
    "404 on the unseen signer": edit(g, "a signer never seen", answer(404, "not_found")),
    "the vault refusal before the gate": edit(g, "a signer never seen, to the vault", answer(403, "receiver_is_vault")),
    "no vault refusal for a seen signer": edit(g, "a seen signer, to the vault", answer(400, "bad_shape")),
    "the probe not bad_shape": edit(g, "the probe", answer(404, "not_found")),
    "the intents part down": edit(g, "health", (x) => ({ ...x, body: JSON.stringify({ ...JSON.parse(x.body), parts: { ...JSON.parse(x.body).parts, intents: "down" } }) })),
    "a sent intent": edit(g, "a signer never seen", (x) => ({ ...x, status: 200, body: JSON.stringify({ tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL" }) })),
    "another origin": edit(g, "the probe", (x) => ({ ...x, headers: { ...x.headers, "access-control-allow-origin": "*" } })),
    "a short commit": edit(g, "health", (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": "main" } })),
    "a missing read": { ...g, reads: g.reads.filter((x) => x.asked !== "a seen signer, to the vault") },
    "the seen signer as the stranger": { ...g, stranger: g.seen },
  };
  for (const [name, run] of Object.entries(cases)) assert.equal(judge(run).ok, false, name);
});

test("without --seen the vault refusal is not judged and says so; the asks post no intent that could be carried", () => {
  const g = A.good;
  const run = { ...g, seen: null, reads: g.reads.filter((x) => x.asked !== "a seen signer, to the vault") };
  const r = judge(run);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("n/a a seen signer")));
  for (const a of asks(g.vault, g.stranger, g.seen, g.now)) {
    if (a.body === undefined || a.body === "{}") continue;
    const si = JSON.parse(a.body).signed_intent;
    assert.equal(si.signature, `ed25519:${"1".repeat(64)}`, "a zero signature: intents.near refuses it");
    assert.equal(JSON.parse(si.payload).intents[0].amount, "1");
  }
});
