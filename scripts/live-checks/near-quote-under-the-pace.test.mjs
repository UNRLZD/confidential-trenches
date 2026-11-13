// node --test scripts/live-checks/near-quote-under-the-pace.test.mjs: the live check replays recorded runs
// (near-quote-under-the-pace.answers.json). good: this card's code from a Mac, 12 Nov 22:44Z: SIGN_HOST's index.html
// and app.js built from it, the seat its helper (server.ts handler and rpc.ts on 127.0.0.1, FastNEAR's key planted:
// Rhea's metadata forwarded to FastNEAR's keyless URL, view_account answered there), dRPC the real near.drpc.org:
// the seat named, the page's origin admitted, the seat and dRPC one block and one result, 30 of 30 in one window:
// PASS. bad: the hosts as deployed before this card, 12 Nov 22:42Z: the page's script names no seat (it read FastNEAR's
// keyless URL) and the helper refused the 17th read of the window (its near share 16): FAIL. Made from the good run:
// the two seats apart, a 503 in the window with no 429 (INCONCLUSIVE), a short window, a seat that does not admit the
// page: each not a PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RPC_PAGE_NEED } from "../../apps/helper/src/rpc/rpc.ts";
import { DRPC, judge, read, SEAT, SIGN, SPREAD_MS, WINDOW, WINDOW_MS } from "./near-quote-under-the-pace.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "near-quote-under-the-pace.answers.json"), "utf8"));
const edit = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return a;
};

test("the check reads the seat the page names and draws the window the helper promises one page", () => {
  // read as text: a file outside the kit imports only its entry, which does not export the table
  const table = readFileSync(path.join(HERE, "../../packages/kit/src/near/networks.ts"), "utf8");
  const mainnet = table.slice(table.indexOf("  mainnet: {"), table.indexOf("  testnet: {"));
  assert.ok(mainnet.includes(`    seat: "${SEAT}",`), "the page's mainnet seat");
  assert.ok(table.includes(`"${DRPC}"]`), "the page's mainnet dRPC (NEAR_RPC_URLS[2])");
  assert.equal(WINDOW, RPC_PAGE_NEED.near);
});

test("recorded good run: the page names the seat, the seat admits it and agrees with dRPC, one window served: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, 6);
  assert.ok(r.lines.every((l) => l.startsWith("OK ")), r.lines.join("\n"));
  assert.ok(r.lines.includes(`OK the window: ${WINDOW} of ${WINDOW} served in one 10 s window`));
});

test("recorded bad run: the deployed page names no seat and the helper refuses the 17th read: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD the page's script names the seat ${SEAT}`, `BAD the window: read 17 of ${WINDOW} refused 429: the helper does not give one page its busiest 10 s on the seat`]);
});

test("made from the good run: the seats apart, a provider down, a short window, a seat that refuses the page: never a PASS", () => {
  const apart = judge(edit((a) => (a.pair.drpc.sha256 = "0".repeat(64))));
  assert.equal(apart.verdict, "FAIL");
  assert.ok(apart.lines.some((l) => l.startsWith("BAD the seat and dRPC disagree")));
  const fork = judge(edit((a) => (a.pair.drpc.hash = "another")));
  assert.equal(fork.verdict, "FAIL");
  const down = judge(edit((a) => (a.window.reads = [...a.window.reads.slice(0, 9), { i: 9, status: 503, ok: false, why: "HTTP 503" }])));
  assert.equal(down.verdict, "INCONCLUSIVE", down.lines.join("\n"));
  const short = judge(edit((a) => (a.window.reads = a.window.reads.slice(0, 20))));
  assert.equal(short.verdict, "FAIL");
  const shut = judge(edit((a) => (a.preflight.acao = "https://example.org")));
  assert.equal(shut.verdict, "FAIL");
  const closed = judge(edit((a) => (a.final.acao = "https://example.org")));
  assert.equal(closed.verdict, "FAIL");
  const unpinned = judge(edit((a) => (a.app.sha384 = "sha384-other")));
  assert.equal(unpinned.verdict, "FAIL");
  const error = judge(edit((a) => (delete a.pair.seat.sha256, (a.pair.seat.error = { message: "MethodNotFound" }))));
  assert.equal(error.verdict, "FAIL");
});

test("read: the page's origin on every post, the pair under the final, the window in a whole window, nothing sent after a refusal", async () => {
  const sent = [];
  let t = 1_800_000_003_210;
  const fetchFn = async (url, init = {}) => {
    sent.push({ url, method: init.method ?? "GET", at: t, body: init.body ? JSON.parse(init.body) : undefined, origin: init.headers?.origin });
    if (url === `${SIGN}/`) return new Response(A.good.index);
    if (url === `${SIGN}/app.js`) return new Response(`const s = "${SEAT}";`);
    if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": SIGN, "access-control-allow-headers": "content-type" } });
    const p = JSON.parse(init.body).params;
    const window = sent.filter((s) => s.url === SEAT && s.body?.params?.request_type === "view_account").length;
    if (window >= 12) return new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "access-control-allow-origin": SIGN, "retry-after": "3" } });
    const height = p.block_id ?? 224_000_000;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { block_height: height, block_hash: `H${height}`, result: [1, 2], logs: [] } }), { status: 200, headers: { "access-control-allow-origin": SIGN } });
  };
  const run = await read(fetchFn, { wait: async (ms) => void (t += ms), clock: () => t });
  for (const s of sent.filter((x) => x.method === "POST")) assert.equal(s.origin, SIGN, s.url);
  assert.equal(run.final.height, 224_000_000);
  assert.equal(run.pair.seat.height, 224_000_000 - 5);
  assert.deepEqual([run.pair.drpc.height, run.pair.drpc.hash, run.pair.drpc.sha256], [run.pair.seat.height, run.pair.seat.hash, run.pair.seat.sha256]);
  assert.ok(sent.some((s) => s.url === DRPC && s.body.params.block_id === 224_000_000 - 5), "dRPC read at the pair's block");
  const win = sent.filter((s) => s.url === SEAT && s.body?.params?.request_type === "view_account");
  // the 12th read refused (and read again once by rpcAnswer), then nothing more
  assert.equal(win.length, 13);
  assert.equal(run.window.reads.length, 12);
  assert.equal(run.window.reads.at(-1).status, 429);
  const first = win[0].at;
  assert.equal(first % WINDOW_MS, 1_000, "a second into a whole window");
  assert.ok(first > 1_800_000_003_210 + WINDOW_MS - 1_000, "the next whole window, after the pair's reads");
  assert.ok(win[10].at - first <= SPREAD_MS && win.every((s) => s.at - first < WINDOW_MS - 1_000));
  assert.equal(judge(run).verdict, "FAIL");
});
