// node --test scripts/live-checks/robinhood-warm-tap-inside-2s.test.mjs: the live check replays recorded runs
// (robinhood-warm-tap-inside-2s.answers.json). good: this card's code from a Mac, 26 Nov 16:24Z: SIGN_HOST's index.html
// and app.js built from it, the seat its helper (server.ts handler and rpc.ts on 127.0.0.1 with the Robinhood Alchemy
// key), publicnode the real one: the seat named, the page's origin admitted, the head from ROBINHOOD_RPC_URL under a
// share of 300, the seat and publicnode one block, 294 calls in 98 posts in one window: PASS. bad: the hosts as deployed
// before this card, 16:24Z: the page's script names no seat and the helper refuses ?keyed=alchemy (HTTP 400): FAIL.
// Made from the good run: a 429 in the burst, a share under the burst, another key's answer, the two apart, a short
// burst: each FAIL; a 503 in the burst with no 429: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RPC_UPSTREAMS, SEAT_SHARE } from "../../apps/helper/src/rpc/rpc.ts";
import { judge, PER_POST, read, SEAT, SEAT_NAME, SIGN, SPREAD_MS, TAP_BURST, WINDOW_MS } from "./robinhood-warm-tap-inside-2s.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "robinhood-warm-tap-inside-2s.answers.json"), "utf8"));
const edit = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return a;
};

test("the check reads the seat the page names, from the key the helper names, and its burst fits the helper's share", () => {
  // read as text: a file outside the kit imports only its entry, which does not export the venues
  const venues = readFileSync(path.join(HERE, "../../packages/kit/src/trade/evm/buy-unpinned.ts"), "utf8");
  const pace = readFileSync(path.join(HERE, "../../packages/kit/src/checks/evm/pace.ts"), "utf8");
  assert.ok(venues.includes("providers: Object.freeze([`${EVM_HELPER_ORIGIN}/v1/rpc/robinhood?keyed=alchemy`, "), "the seat first in Robinhood's quote list");
  assert.equal(`${/export const EVM_HELPER_ORIGIN = "([^"]+)";/.exec(pace)?.[1]}/v1/rpc/robinhood?keyed=alchemy`, SEAT);
  assert.equal(RPC_UPSTREAMS.robinhood.env, SEAT_NAME, "the route's own name, the Alchemy key's");
  assert.ok(TAP_BURST <= SEAT_SHARE, `${TAP_BURST} calls against the seat's share ${SEAT_SHARE}`);
});

test("recorded good run: the page names the seat, the seat admits it, answers from the Alchemy key under a tap's share, agrees with publicnode, serves the burst: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad run: the page names no seat and the helper refuses ?keyed=alchemy: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD the page's script names the seat")));
  assert.ok(r.lines.some((l) => /^BAD the burst: post 1 refused/.test(l)), r.lines.join("\n"));
});

test("made from the good run: a 429 in the burst, a share under the burst, another key's answer, the pair apart, a short burst: each FAIL", () => {
  const cases = {
    "a 429": (a) => (a.burst.posts = [...a.burst.posts.slice(0, 40), { i: 40, status: 429, ok: false, why: "HTTP 429" }]),
    "a share of 30": (a) => (a.head.policy = '"chain";q=144;w=10, "client";q=30;w=10'),
    "no policy": (a) => (a.head.policy = null),
    "QuickNode's answer": (a) => (a.head.timing = 'rpc-wait;dur=0, rpc;dur=120;desc="ROBINHOOD_RPC_URL_QUICKNODE"'),
    "the pair apart": (a) => (a.pair.keyless.hash = `0x${"0".repeat(64)}`),
    "a short burst": (a) => (a.burst.posts = a.burst.posts.slice(0, 50)),
    "the script names no seat": (a) => (a.app.names = []),
  };
  for (const [what, f] of Object.entries(cases)) {
    const r = judge(edit(f));
    assert.equal(r.verdict, "FAIL", `${what}: ${r.lines.join("\n")}`);
  }
});

test("made from the good run: a 503 in the burst with no 429: INCONCLUSIVE, never a pass", () => {
  const r = judge(edit((a) => (a.burst.posts = [...a.burst.posts.slice(0, 10), { i: 10, status: 503, ok: false, why: "HTTP 503" }])));
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
});

test("read() sends the burst in the kit's batches inside one 10 s window, and stops at the first refusal", async () => {
  const c = { t: 1_800_000_003_210 };
  const seen = [];
  const at = [];
  let refuseAt = Infinity;
  const fetchFn = async (url, init) => {
    if (url === `${SIGN}/` || url === `${SIGN}/app.js`) return new Response(url.endsWith("app.js") ? "x" : "<html>", { status: 200 });
    if (init?.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": SIGN, "access-control-allow-headers": "content-type" } });
    const body = JSON.parse(String(init.body));
    if (Array.isArray(body)) {
      seen.push(body.length);
      at.push(c.t);
      if (seen.length >= refuseAt) return new Response('{"error":{"code":"rate_limited"}}', { status: 429 });
      return new Response(JSON.stringify(body.map((x) => ({ jsonrpc: "2.0", id: x.id, result: "0x10" }))), { status: 200 });
    }
    const result = body.method === "eth_blockNumber" ? "0x100" : { hash: "0xab" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "server-timing": `rpc;dur=1;desc="${SEAT_NAME}"`, "ratelimit-policy": '"chain";q=750;w=10, "client";q=300;w=10' } });
  };
  const run = await read(fetchFn, { wait: async (ms) => void (c.t += ms), clock: () => c.t });
  assert.equal(seen.reduce((n, x) => n + x, 0), TAP_BURST);
  assert.ok(seen.every((n) => n <= PER_POST));
  assert.equal(Math.floor(at[0] / WINDOW_MS), Math.floor(at.at(-1) / WINDOW_MS), "every post in one fixed window");
  assert.ok(at.at(-1) - at[0] <= SPREAD_MS);
  assert.equal(judge(run).lines.at(-1), `OK the burst: ${TAP_BURST} calls in ${Math.ceil(TAP_BURST / PER_POST)} posts served in one 10 s window`);
  seen.length = 0;
  refuseAt = 5;
  const r2 = await read(fetchFn, { wait: async (ms) => void (c.t += ms), clock: () => c.t });
  assert.equal(seen.length, 5, "nothing sent past the refusal");
  assert.equal(judge(r2).verdict, "FAIL");
});
