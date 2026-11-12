// node --test apps/helper/src/proxy/vendor-said.test.ts: every answer of the vendor proxies that is not a 2xx is logged in
// one line (card helper-says-why-a-vendor-refused: live runs 43276439006 and 43289730843 answered 1Click quotes 400 and
// nothing on record said why): the vendor, the allowlisted path, the status, whose refusal it is (ours or the vendor's)
// and the vendor's own message cut to VENDOR_MESSAGE_MAX characters. Never a field of the caller's request, never a key,
// never an address, never a line break the vendor sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxy, SAID_FOLD_MS } from "./proxy.ts";
import { VENDOR_NAMES, VENDORS } from "./vendors.ts";

const ENV = {
  JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16),
  RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16),
  LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16),
  ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16),
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const RECIPIENT = "a".repeat(64);
const QUOTE = JSON.stringify({ dry: true, originAsset: "nep141:wrap.near", amount: "10000000", recipient: RECIPIENT, refundTo: "someone-private.near", deadline: "2026-11-12T19:55:00.000Z" });

/** A proxy on a fake vendor whose waits end at once; the fold window ends when the test calls `fold`. */
function proxy(answer: () => Response | Promise<Response>, env: Record<string, string> = ENV) {
  const lines: string[] = [];
  const windows: Array<() => void> = [];
  const foldWait = (ms: number) => (assert.equal(ms, SAID_FOLD_MS), new Promise<void>((ok) => windows.push(ok)));
  const p = createProxy(env, { fetch: async () => answer(), log: (l) => lines.push(l), sleep: async () => {}, foldWait });
  const fold = async () => {
    for (const ok of windows.splice(0)) ok();
    await new Promise((ok) => setImmediate(ok));
  };
  return { p, lines, fold, said: () => lines.filter((l) => l.startsWith("proxy ")) };
}

test("1Click's 400 on a quote is logged once with its message, as the vendor's", async () => {
  const { p, said } = proxy(() => json(400, { message: "Failed to get quote" }));
  const a = await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  assert.equal(a.status, 400);
  assert.deepEqual(said(), ['proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "Failed to get quote"']);
});

test("a 2xx is never logged", async () => {
  const { p, said } = proxy(() => json(201, { quote: {} }));
  assert.equal((await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).status, 201);
  assert.deepEqual(said(), []);
});

test("every vendor's non-2xx on every allowlisted path is logged, with the vendor's status and message", async () => {
  for (const v of VENDOR_NAMES) {
    for (const path of Object.keys(VENDORS[v].paths)) {
      const { p, said } = proxy(() => json(422, { error: { message: "Bad pair" } }));
      const a = await p.handle(v, path, "", VENDORS[v].paths[path]!.method === "POST" ? "{}" : "", "203.0.113.7");
      assert.equal(a.status, 422, `${v} ${path}`);
      assert.deepEqual(said(), [`proxy ${v} ${path} answered 422, the vendor's: 422 "Bad pair"`], `${v} ${path}`);
    }
  }
});

test("a 503 for the vendor's own failure names the cause and the vendor's status, as the vendor's", async () => {
  const fail = proxy(() => json(502, { message: "Bad gateway" }));
  assert.equal((await fail.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).status, 503);
  assert.deepEqual(fail.said(), ["proxy oneclick /v0/quote answered 503, the vendor's: 502 (5xx)"]);
  const key = proxy(() => json(401, { message: "Apikey not found" }));
  assert.equal((await key.p.handle("relay", "/quote/v2", "", "{}", "203.0.113.7")).status, 503);
  assert.deepEqual(key.said(), ['proxy relay /quote/v2 answered 503, the vendor\'s: 401 (key) "Apikey not found"']);
  const down = proxy(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
  assert.equal((await down.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).status, 503);
  assert.deepEqual(down.said(), ["proxy oneclick /v0/quote answered 503, the vendor's: timeout"]);
});

test("our own refusals are logged as ours, the caller's path never", async () => {
  const { p, said } = proxy(() => json(200, {}));
  assert.equal((await p.handle("oneclick", "/v0/quote?x=1/../../secret", "", "{}", "203.0.113.7")).status, 400);
  assert.equal((await p.handle("nobody", "/anything-of-the-callers", "", "{}", "203.0.113.7")).status, 404);
  assert.equal((await p.handle("oneclick", "/v0/quote", "", "x".repeat(70_000), "203.0.113.7")).status, 413);
  assert.deepEqual(said(), [
    "proxy oneclick (a path not on the list) answered 400, ours: path_not_allowed",
    "proxy (a vendor not on the list) answered 404, ours: not_found",
    "proxy oneclick /v0/quote answered 413, ours: too_large",
  ]);
  for (const l of said()) assert.ok(!l.includes("secret") && !l.includes("anything-of-the-callers") && !l.includes("nobody"), l);
});

test("the caller's share answers 429 and is logged as ours", async () => {
  const { p, said } = proxy(() => json(200, {}), { ...ENV, PROXY_BUDGET_RELAY: "50,1" });
  const answers = [];
  for (let i = 0; i < 60; i++) answers.push((await p.handle("relay", "/intents/status/v3", `id=${i}`, "", "203.0.113.7")).status);
  assert.ok(answers.includes(429), String(answers));
  const refused = said().filter((l) => l.includes("answered 429"));
  assert.ok(refused.length > 0);
  for (const l of refused) assert.match(l, /^proxy relay \/intents\/status\/v3 answered 429, ours: relay share$/);
  // folded: the same refusal is one line however many callers it answered
  assert.equal(refused.length, 1, refused.join("\n"));
});

test("the vendor's message never carries a request field, an address, a key or a line break, and is cut to 200 characters", async () => {
  const echo = `recipient ${RECIPIENT} and someone-private.near for 10000000 at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 to 9ddc51SoLAddr2nGeneratedKeyKk5pQwErTy8uiop1 via BuYVGN… with ${ENV.ONECLICK_JWT}\nproxy forged line`;
  const { p, said } = proxy(() => json(400, { message: echo }));
  await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  const [line, ...rest] = said();
  assert.equal(rest.length, 0);
  assert.ok(line, "one line");
  for (const bad of [RECIPIENT, "someone-private", "10000000", "0x833589", "9ddc51SoLAddr", "BuYVGN", "fake.oneclick", "\n"]) assert.ok(!line!.includes(bad), `${bad} in ${line}`);
  const long = proxy(() => json(400, { message: "No liquidity available ".repeat(30) }));
  await long.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  const m = /: 400 "(.*)"$/.exec(long.said()[0] ?? "");
  assert.ok(m && m[1]!.length <= 200, long.said()[0]);
  const lifi = proxy(() => json(400, { message: `fromAddress 0x${"b".repeat(40)} is not valid` }));
  await lifi.p.handle("lifi", "/v1/quote", `fromAddress=0x${"b".repeat(40)}&fromChain=8453`, "", "203.0.113.7");
  assert.deepEqual(lifi.said(), ['proxy lifi /v1/quote answered 400, the vendor\'s: 400 "fromAddress <request field> is not valid"']);
});

test("a message in another shape: an array of messages, an error string, none", async () => {
  const arr = proxy(() => json(400, { message: ["deadline must be a date", "amount must be a string"], error: "Bad Request" }));
  await arr.p.handle("oneclick", "/v0/quote", "", "{}", "203.0.113.7");
  assert.deepEqual(arr.said(), ['proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "deadline must be a date; amount must be a string"']);
  const err = proxy(() => json(404, { error: "Not found" }));
  await err.p.handle("oneclick", "/v0/status", "depositAddress=abc", "", "203.0.113.7");
  assert.deepEqual(err.said(), ['proxy oneclick /v0/status answered 404, the vendor\'s: 404 "Not found"']);
  const none = proxy(() => json(400, { nothing: 1 }));
  await none.p.handle("oneclick", "/v0/quote", "", "{}", "203.0.113.7");
  assert.deepEqual(none.said(), ["proxy oneclick /v0/quote answered 400, the vendor's: 400 (no message)"]);
});

test("the same line in one window is written once at once, then once with its count when the window ends", async () => {
  const { p, said, fold } = proxy(() => json(400, { message: "Failed to get quote" }));
  await Promise.all(Array.from({ length: 70 }, () => p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")));
  assert.deepEqual(said(), ['proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "Failed to get quote"']);
  await fold();
  assert.deepEqual(said(), [
    'proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "Failed to get quote"',
    'proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "Failed to get quote" (and 69 more in 10 s)',
  ]);
  await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  assert.equal(said().length, 3, "a new window writes the line again at once");
});

// The answer says it too: a refusal's Server-Timing names whose it is, refusal;desc="vendor" or refusal;desc="ours", so a
// device and a live check tell 1Click's 400 from the helper's own without a log (the live check of this card reads it).
test("every answer that is not 2xx names whose refusal it is in its Server-Timing; a 2xx names none", async () => {
  const theirs = proxy(() => json(400, { message: "Failed to get quote" }));
  const a = await theirs.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  assert.ok(a.timing?.includes('refusal;desc="vendor"'), String(a.timing));
  const down = proxy(() => json(502, {}));
  assert.ok((await down.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).timing?.includes('refusal;desc="vendor"'));
  const ours = proxy(() => json(200, {}));
  for (const [v, path, body] of [["oneclick", "/v0/nope", "{}"], ["nobody", "/x", "{}"], ["oneclick", "/v0/quote", "x".repeat(70_000)]] as const) {
    const r = await ours.p.handle(v, path, "", body, "203.0.113.7");
    assert.deepEqual(r.timing, ['refusal;desc="ours"'], `${v} ${path}`);
  }
  const ok = proxy(() => json(201, {}));
  assert.ok(!(await ok.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).timing?.some((t) => t.startsWith("refusal;")));
});
