// node --test scripts/live-checks/found-wallet-sweep-reads-on-a-pair-that-answers.test.mjs: the live check replays its
// recorded runs (found-wallet-sweep-reads-on-a-pair-that-answers.answers.json), all read 2026-11-13 18:04-18:05Z from this
// Mac with SIGN_HOST's Origin.
// - good: the pair (Solana Vibe Station's endpoint, the helper's /v1/rpc/solana) as read live, each listing the owner's
//   116 Token and 18 Token-2022 accounts alike, with index.html and /app.js from build-app.mjs --out of this branch (no
//   served answer of it until the next sign deploy): PASS.
// - beforeDeploy: the same live reads with the page SIGN_HOST served then, whose script names no token seat: FAIL.
// - publicnode, pocket: the found path's pair as it was, today's public seat in the seat's place: publicnode's -32602
//   "Request blocked" and "Indexed requests require a personal token", Pocket's -32602 "requires a mint filter" and
//   -32010 "excluded from account secondary indexes": FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, HELPER, read, SEAT } from "./found-wallet-sweep-reads-on-a-pair-that-answers.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./found-wallet-sweep-reads-on-a-pair-that-answers.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the page names the token seat, and both of the pair list the owner's accounts alike: PASS", () => {
  const r = check(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("OK both list the same accounts under Tokenkeg")));
  assert.ok(r.lines.some((l) => l.startsWith("OK both list the same accounts under TokenzQd")));
});

test("recorded bad answers: today's public seat in the seat's place (-32602, -32010): FAIL on its refusals", () => {
  for (const [k, want] of [["publicnode", /-32602,"message":"Request blocked"/], ["pocket", /-32010/]]) {
    const r = check(ANSWERS[k]);
    assert.equal(r.verdict, "FAIL", k);
    assert.ok(r.lines.some((l) => l.startsWith("BAD") && want.test(l)), `${k}: ${r.lines.join("\n")}`);
  }
});

test("recorded bad answer: the page served before this card names no token seat: FAIL on that line alone", () => {
  const r = check(ANSWERS.beforeDeploy);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD the page's script names the token seat ${SEAT}`]);
});

test("planted: lists apart, a refused page, a seat's no-answer", () => {
  const g = ANSWERS.good;
  const apart = structuredClone(g);
  apart.providers[HELPER].lists.TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.sha256 = "0".repeat(64);
  assert.equal(check(apart).verdict, "FAIL");
  const refused = structuredClone(g);
  refused.providers[SEAT].lists.TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.acao = "https://example.com";
  assert.equal(check(refused).verdict, "FAIL");
  const quiet = structuredClone(g);
  quiet.providers[SEAT].lists.TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA = { status: 429, acao: "*", noAnswer: "public.rpc.solanavibestation.com HTTP 429: 429 Too Many Requests" };
  assert.equal(check(quiet).verdict, "INCONCLUSIVE");
  const one = structuredClone(g);
  delete one.providers[HELPER];
  assert.equal(check(one).verdict, "FAIL");
});

test("read: the pair asked with the page's Origin, the seat's preflight, one owner under both programs, finalized", async () => {
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    asked.push({ url, method: init.method ?? "GET", origin: init.headers?.origin, body: init.body });
    if (url.endsWith("/") || url.endsWith("/app.js")) return new Response("x", { status: 200 });
    if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [] } }), { status: 200, headers: { "access-control-allow-origin": "*" } });
  };
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f) => real(f, 0);
  try {
    await read(fetchFn);
  } finally {
    globalThis.setTimeout = real;
  }
  const posts = asked.filter((a) => a.method === "POST");
  assert.deepEqual([...new Set(posts.map((p) => p.url))], [SEAT, HELPER]);
  assert.ok(posts.every((p) => p.origin === "https://confidential.unrealized.trade"));
  for (const p of posts) {
    const b = JSON.parse(p.body);
    assert.equal(b.method, "getTokenAccountsByOwner");
    assert.equal(b.params[2].commitment, "finalized");
  }
  assert.deepEqual(asked.filter((a) => a.method === "OPTIONS").map((a) => a.url), [SEAT]);
});
