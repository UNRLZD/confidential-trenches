// node --test scripts/live-checks/buy-spends-several-pieces-helper.test.mjs: the live check replays recorded runs
// (buy-spends-several-pieces-helper.answers.json). good: this card's helper (dab79323) run on a Mac with no provider
// key (the public mainnet endpoint, SOLANA_DEVNET_RPC_URL the public devnet one), 13 Nov: both routes answer the header
// read 200 with a block height and refuse the full read 400: PASS. bad_before: the deployed HELPER_HOST at 4f673c93
// (main before this card), 13 Nov: both routes refuse the header read 400 method_not_allowed: FAIL. bad_full_forwarded,
// made from the good run: the mainnet route forwards the full read and answers a block with its transactions: FAIL.
// Made from the good run too: a header answer with rewards, an error, a * origin, a slot not a whole number, a missing
// read: each FAIL; a 429 or a 502 twice: INCONCLUSIVE, never PASS or FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_SOLANA_BLOCK_HEADER } from "../../packages/kit/src/index.ts";
import { RETRY } from "./provider-answer.mjs";
import { ROUTES, SIGN, judge, read } from "./buy-spends-several-pieces-helper.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "buy-spends-several-pieces-helper.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

/** The HTTP answer a recorded read stands for: a block from its keys (each key a placeholder but blockHeight). */
const bodyOf = (a) => {
  if (a.error !== undefined) return JSON.stringify({ error: a.error.message === "" ? { code: a.error.code } : a.error });
  const r = a.result;
  const result = r !== null && typeof r === "object" ? Object.fromEntries(r.keys.map((k) => [k, k === "blockHeight" ? r.blockHeight : "x"])) : r;
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
};
// a fetch that answers each call with the recorded read for its route and read, after checking the check asked it right
const replay = (rec, sent = [], over = () => undefined) => async (url, init) => {
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  assert.equal(init.redirect, "manual");
  const route = url.slice(`${BASE}/v1/rpc/`.length);
  assert.equal(url, `${BASE}/v1/rpc/${route}`);
  const body = JSON.parse(init.body);
  sent.push({ route, ...body });
  const k = body.method === "getSlot" ? "slot" : body.params[1].transactionDetails === "full" ? "full" : "header";
  const o = over(route, k);
  if (o) return o;
  const r = rec.reads.find((x) => x.route === route && x.read === k);
  const headers = { ...(r.commit ? { "x-helper-commit": r.commit } : {}), ...(r.acao ? { "access-control-allow-origin": r.acao } : {}) };
  return new Response(bodyOf(r.answer), { status: r.status, headers });
};
const run = async (rec, over) => judge(await read(BASE, replay(rec, [], over)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.slice(0, l.indexOf(" ", l.indexOf("]") + 2)));
const edit = (route, k, f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.route === route && x.read === k ? f(structuredClone(x)) : x)) });

test("recorded good run: this card's helper answers the header read and refuses the full read on both routes: PASS", async () => {
  const sent = [];
  const r = judge(await read(BASE, replay(A.good, sent)));
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, ROUTES.length * 5);
  // the header read is the page's own params: [the slot read, the kit's object], the full read differs only in transactionDetails
  for (const route of ROUTES) {
    const [s, h, f] = sent.filter((x) => x.route === route);
    assert.deepEqual([s.method, s.params], ["getSlot", [{ commitment: "finalized" }]]);
    const slot = A.good.reads.find((x) => x.route === route && x.read === "slot").answer.result;
    assert.deepEqual([h.method, h.params], ["getBlock", [slot, { ...HELPER_SOLANA_BLOCK_HEADER }]]);
    assert.deepEqual([f.method, f.params], ["getBlock", [slot, { ...HELPER_SOLANA_BLOCK_HEADER, transactionDetails: "full" }]]);
  }
  // a replayed run reads as the recorded one
  assert.deepEqual((await read(BASE, replay(A.good))).reads.map(({ ms, ...x }) => x), A.good.reads.map(({ ms, ...x }) => x));
});

test("recorded bad run: the deployed helper before this card refuses the header read on both routes: FAIL", async () => {
  const r = await run(A.bad_before);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), ["BAD [solana] header", "BAD [solana-devnet] header"]);
});

test("recorded bad run: a helper that forwards the full read: FAIL", async () => {
  const r = await run(A.bad_full_forwarded);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(bad(r), ["BAD [solana] full"]);
});

test("made from the good run: rewards in the header answer, an error, a * origin, a slot not whole, a missing read: each FAIL", async () => {
  const rewards = edit("solana-devnet", "header", (x) => ((x.answer.result = { keys: ["blockHeight", "rewards"], blockHeight: 1 }), x));
  assert.deepEqual(bad(await run(rewards)), ["BAD [solana-devnet] header"]);
  const err = edit("solana", "header", (x) => ((x.status = 200), (x.answer = { error: { code: -32009, message: "Slot 1 was skipped" } }), x));
  assert.deepEqual(bad(await run(err)), ["BAD [solana] header"]);
  const star = edit("solana", "header", (x) => ((x.acao = "*"), x));
  assert.deepEqual(bad(await run(star)), ["BAD [solana] allow-origin:"]);
  const half = edit("solana-devnet", "slot", (x) => ((x.answer.result = 1.5), x));
  assert.deepEqual(bad(await run(half)), ["BAD [solana-devnet] finalized"]);
  assert.deepEqual(bad(judge({ reads: A.good.reads.filter((x) => !(x.route === "solana" && x.read === "full")) })), ["BAD [solana] full"]);
  assert.equal(judge({ reads: [] }).verdict, "FAIL");
});

test("a 429 or a 502 on a read, twice: INCONCLUSIVE, never PASS or FAIL; once: read again and judged", async () => {
  const twice = (status) => {
    const seen = new Map();
    return (route, k) => (route === "solana-devnet" && k === "header" && (seen.set(k, (seen.get(k) ?? 0) + 1), true) ? new Response("busy", { status }) : undefined);
  };
  for (const status of [429, 502]) {
    const r = await run(A.good, twice(status));
    assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("--  [solana-devnet] header read: no answer")));
  }
  let n = 0;
  const once = (route, k) => (route === "solana" && k === "full" && n++ === 0 ? new Response("busy", { status: 429 }) : undefined);
  assert.equal((await run(A.good, once)).verdict, "PASS");
  // a no-answer never hides a wrong answer elsewhere
  assert.equal((await run(A.bad_before, twice(429))).verdict, "FAIL");
});
