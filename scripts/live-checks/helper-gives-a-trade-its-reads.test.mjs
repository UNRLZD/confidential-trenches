// node --test scripts/live-checks/helper-gives-a-trade-its-reads.test.mjs: the live check replays recorded runs
// (helper-gives-a-trade-its-reads.answers.json). good: this card's helper code on a Mac (the real server and RPC part,
// its keyed providers stubbed), 11 Nov 05:32:38Z: 42 of 42 on Solana, 30 of 30 on Base and on Robinhood: PASS. bad: the
// deployed helper before this card, 11 Nov 05:27:45Z, one run from a Mac: each route served 16 and refused the 17th
// (429 rate_limited, retry-after 5 and 6): FAIL; that run sent each route its whole window, the check now stops at the
// first read not served. Made from the good run: a 429, a 503 with no 429 (INCONCLUSIVE), a short
// run, a marks route skipped while the program is named: each not a PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RPC_PAGE_NEED } from "../../apps/helper/src/rpc/rpc.ts";
import { judge, read, SIGN, SPREAD_MS, WINDOW, WINDOW_MS } from "./helper-gives-a-trade-its-reads.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-gives-a-trade-its-reads.answers.json"), "utf8"));
const BASE = "https://ct-api.unrealized.trade";
const edit = (route, f) => {
  const a = structuredClone(A.good);
  f(a.routes[route]);
  return a;
};

// a fetch that answers each call with the recorded read for its route and place, after checking what the check asked
const replay = (rec, sent) => async (url, init) => {
  const route = url.slice(`${BASE}/v1/rpc/`.length);
  assert.ok(url.startsWith(`${BASE}/v1/rpc/`) && Object.hasOwn(WINDOW, route), url);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, SIGN);
  const body = JSON.parse(init.body);
  const n = sent.filter((s) => s.route === route).length;
  sent.push({ route, body });
  const r = rec.routes[route].reads[n];
  const text = r.status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 1 }) : JSON.stringify({ error: { code: r.code ?? "rate_limited" } });
  return new Response(text, { status: r.status, headers: { "access-control-allow-origin": SIGN, ...(r.retryAfter ? { "retry-after": r.retryAfter } : {}) } });
};

test("the check's window per route is the helper's RPC_PAGE_NEED, so the check draws what the helper promises one page", () => {
  for (const [route, need] of Object.entries(WINDOW)) assert.equal(need, RPC_PAGE_NEED[route], route);
});

test("recorded good run: this card's helper serves each route's window: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(r.lines, ["ok  [solana] 42 of 42 served in one window", "ok  [solana-marks] n/a: no scripts/live-checks/pool-sol-deploy.mainnet.json: no mainnet pool program to scan", "ok  [base] 30 of 30 served in one window", "ok  [robinhood] 30 of 30 served in one window"]);
});

test("recorded bad run: the deployed helper before this card refuses the 17th read on each route: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(
    r.lines.filter((l) => l.startsWith("BAD")),
    ["BAD [solana] 16 of 42 served: read 17 refused 429 (rate_limited, retry-after 5)", "BAD [base] 16 of 30 served: read 17 refused 429 (rate_limited, retry-after 6)", "BAD [robinhood] 16 of 30 served: read 17 refused 429 (rate_limited, retry-after 6)"],
  );
});

test("a run made from the good one: a 429 fails, a 503 with no 429 is inconclusive, a short run fails, a named program with no marks read fails", () => {
  assert.equal(judge(edit("base", (r) => Object.assign(r.reads[29], { status: 429, retryAfter: "3", code: "rate_limited", ok: false }))).verdict, "FAIL");
  assert.equal(judge(edit("solana", (r) => r.reads.splice(6, 36, Object.assign(r.reads[6], { status: 503, ok: false, why: "ct-api.unrealized.trade HTTP 503: a passing fault" })))).verdict, "INCONCLUSIVE");
  assert.equal(judge(edit("solana", (r) => Object.assign(r.reads[5], { status: 503, ok: false }))).verdict, "INCONCLUSIVE", "a not-served read in a full run too");
  assert.equal(judge(edit("robinhood", (r) => r.reads.pop())).verdict, "FAIL");
  assert.equal(judge({ ...A.good, program: "11111111111111111111111111111111" }).verdict, "FAIL");
});

test("the read: each route's window from one address, spread inside one fixed 10 s window, stopping at a route's first read not served (read again once by rpcAnswer); replayed, it judges as recorded", async () => {
  for (const name of ["good", "bad"]) {
    const sent = [];
    let t = 1_800_000_003_456; // inside a window: the draw waits for the next one's first second
    const at = [];
    const fetchFn = replay(A[name], sent);
    const got = await read(BASE, async (u, i) => (at.push({ route: u.slice(u.lastIndexOf("/") + 1), t }), fetchFn(u, i)), { program: null, clock: () => t, wait: async (ms) => void (t += ms) });
    assert.equal(judge(got).verdict, name === "good" ? "PASS" : "FAIL");
    for (const route of Object.keys(WINDOW)) {
      const ts = at.filter((x) => x.route === route).map((x) => x.t);
      if (route === "solana-marks") {
        assert.equal(ts.length, 0, "no mainnet pool program: no marks read");
        continue;
      }
      const w = Math.floor(ts[0] / WINDOW_MS);
      assert.ok(ts.every((x) => Math.floor(x / WINDOW_MS) === w), `${route}: one window`);
      assert.ok(ts[0] % WINDOW_MS >= 1_000 && ts.at(-1) - ts[0] <= SPREAD_MS, `${route}: from a second in, over ${SPREAD_MS} ms`);
      assert.equal(ts.length, name === "good" ? WINDOW[route] : 18, `${route}: ${name === "good" ? "the window" : "the 17th refused, read again once, then nothing"}`);
    }
  }
});
