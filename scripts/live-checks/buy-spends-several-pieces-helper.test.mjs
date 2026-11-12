// node --test scripts/live-checks/buy-spends-several-pieces-helper.test.mjs: the live check replays recorded runs
// (buy-spends-several-pieces-helper.answers.json). good: this card's helper (b72cb2c33) run on a Mac with no provider
// key (the public mainnet endpoint, SOLANA_DEVNET_RPC_URL the public devnet one), 13 Nov: both routes answer the header
// read 200 with a block height and refuse the full read 400: PASS. bad_before: the deployed HELPER_HOST at 7635cb52
// (main before this card), 13 Nov: both routes refuse the header read 400 method_not_allowed: FAIL. bad_full_forwarded,
// made from the good run: the mainnet route forwards the full read and answers a block with its transactions: FAIL.
// Made from the good run too: a header answer with rewards, another id, a * origin, a slot not a whole number, a
// missing read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELPER_SOLANA_BLOCK_HEADER } from "../../packages/kit/src/index.ts";
import { ROUTES, SIGN, cut, judge, read } from "./buy-spends-several-pieces-helper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "buy-spends-several-pieces-helper.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";

// a fetch that answers each call with the recorded read for its route and id, after checking the check asked it right
const replay = (rec, sent = []) => async (url, init) => {
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  const route = url.slice(`${BASE}/v1/rpc/`.length);
  assert.equal(url, `${BASE}/v1/rpc/${route}`);
  const body = JSON.parse(init.body);
  sent.push({ route, ...body });
  const r = rec.reads.find((x) => x.route === route && x.id === body.id);
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const run = async (rec) => judge(await read(BASE, replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.slice(0, l.indexOf(" ", l.indexOf("]") + 2)));
const edit = (route, k, f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.route === route && x.read === k ? f(structuredClone(x)) : x)) });

test("recorded good run: this card's helper answers the header read and refuses the full read on both routes: PASS", async () => {
  const sent = [];
  const r = judge(await read(BASE, replay(A.good, sent)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.length, ROUTES.length * 5);
  // the header read is the page's own params: [the slot read, the kit's object], the full read differs only in transactionDetails
  for (const route of ROUTES) {
    const [s, h, f] = sent.filter((x) => x.route === route);
    assert.deepEqual([s.method, s.params], ["getSlot", [{ commitment: "finalized" }]]);
    const slot = JSON.parse(A.good.reads.find((x) => x.route === route && x.read === "slot").body).result;
    assert.deepEqual([h.method, h.params], ["getBlock", [slot, { ...HELPER_SOLANA_BLOCK_HEADER }]]);
    assert.deepEqual([f.method, f.params], ["getBlock", [slot, { ...HELPER_SOLANA_BLOCK_HEADER, transactionDetails: "full" }]]);
  }
});

test("recorded bad run: the deployed helper before this card refuses the header read on both routes: FAIL", async () => {
  const r = await run(A.bad_before);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ["BAD [solana] header", "BAD [solana-devnet] header"]);
  assert.ok(r.lines.includes('BAD [solana] header read answered: 400 {"error":{"code":"method_not_allowed"}}'));
});

test("recorded bad run: a helper that forwards the full read: FAIL", async () => {
  const r = await run(A.bad_full_forwarded);
  assert.deepEqual(bad(r), ["BAD [solana] full"]);
});

test("made from the good run: rewards in the header answer, another id, a * origin, a slot not whole, a missing read: each FAIL", async () => {
  const rewards = edit("solana-devnet", "header", (x) => ((x.body = JSON.stringify({ ...JSON.parse(x.body), result: { keys: ["blockHeight", "rewards"], blockHeight: 1 } })), x));
  assert.deepEqual(bad(await run(rewards)), ["BAD [solana-devnet] header"]);
  const id = edit("solana", "header", (x) => ((x.body = JSON.stringify({ ...JSON.parse(x.body), id: 99 })), x));
  assert.deepEqual(bad(await run(id)), ["BAD [solana] header"]);
  const star = edit("solana", "header", (x) => ((x.headers["access-control-allow-origin"] = "*"), x));
  assert.deepEqual(bad(await run(star)), ["BAD [solana] allow-origin:"]);
  const half = edit("solana-devnet", "slot", (x) => ((x.body = JSON.stringify({ ...JSON.parse(x.body), result: 1.5 })), x));
  assert.deepEqual(bad(await run(half)), ["BAD [solana-devnet] finalized"]);
  assert.deepEqual(bad(judge({ reads: A.good.reads.filter((x) => !(x.route === "solana" && x.read === "full")) })), ["BAD [solana] full"]);
  assert.equal(judge({ reads: [] }).ok, false);
});

test("a body as recorded cuts to itself, and a block's transactions are kept by name only", () => {
  for (const x of A.good.reads) assert.equal(cut(x.body), x.body);
  const block = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { blockHeight: 7, blockhash: "h", transactions: [{ big: "x".repeat(1000) }] } });
  assert.equal(cut(block), '{"jsonrpc":"2.0","id":3,"result":{"keys":["blockHeight","blockhash","transactions"],"blockHeight":7}}');
});
