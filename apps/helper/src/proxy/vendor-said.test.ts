// node --test apps/helper/src/proxy/vendor-said.test.ts: every answer of the vendor proxies that is not a 2xx is logged in
// one line (card helper-says-why-a-vendor-refused: live runs 43276439006 and 43289730843 answered 1Click quotes 400 and
// nothing on record said why): the vendor, the allowlisted path, the status, whose refusal it is (ours or the vendor's)
// and the vendor's own message cut to VENDOR_MESSAGE_MAX characters. Never a field of the caller's request, never a key,
// never an address, never a line break the vendor sent.
// What no rule here can know (delta review P3-3, by design): a value the vendor rewrites before echoing it, a prefix of it, an
// amount with separators ("25,000,000"), a deadline in another format. The line is safer, never value-free.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_MAX, createProxy, REQUEST_VALUES_MAX, requestValues, SAID_FOLD_KEYS, SAID_FOLD_MS, safeMessage, VENDOR_MESSAGE_READ } from "./proxy.ts";
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

// Review of card helper-says-why-a-vendor-refused, P2: the echo here holds no key, so the message reaches the line (an
// echo holding our key withholds the whole answer, below), and each piece of it is checked on its own.
test("the vendor's message never carries a request field, an address or a line break, and is cut to 200 characters", async () => {
  const echo = `recipient ${RECIPIENT} and someone-private.near for 10000000 at 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 to 9ddc51SoLAddr2nGeneratedKeyKk5pQwErTy8uiop1 via BuYVGN… and other.near\nproxy forged\u2028line`;
  const { p, said } = proxy(() => json(400, { message: echo }));
  await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  assert.deepEqual(said(), [
    'proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "recipient <request field> and <request field> for <request field> at <address> to <address> via <address> and <address> proxy forged line"',
  ]);
  const long = proxy(() => json(400, { message: "No liquidity available ".repeat(30) }));
  await long.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  const m = /: 400 "(.*)"$/.exec(long.said()[0] ?? "");
  assert.ok(m && m[1]!.length === 200, long.said()[0]);
  const lifi = proxy(() => json(400, { message: `fromAddress 0x${"b".repeat(40)} is not valid` }));
  await lifi.p.handle("lifi", "/v1/quote", `fromAddress=0x${"b".repeat(40)}&fromChain=8453`, "", "203.0.113.7");
  assert.deepEqual(lifi.said(), ['proxy lifi /v1/quote answered 400, the vendor\'s: 400 "fromAddress <request field> is not valid"']);
});

test("a message that holds our key is withheld whole, on a 401 and on any answer", async () => {
  const key = proxy(() => json(401, { message: `Invalid token ${ENV.ONECLICK_JWT}` }));
  assert.equal((await key.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).status, 503);
  assert.deepEqual(key.said(), ['proxy oneclick /v0/quote answered 503, the vendor\'s: 401 (key) "(withheld: it held a key)"']);
  const echo = proxy(() => json(400, { message: `bad ${ENV.ONECLICK_JWT}` }));
  assert.equal((await echo.p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7")).status, 503);
  assert.deepEqual(echo.said(), ["proxy oneclick /v0/quote answered 503, the vendor's: 400 (answer)"]);
});

test("each address word is replaced on its own, whatever the request held (none here)", () => {
  const one = (w: string) => safeMessage(`at ${w} now`, []);
  for (const w of [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // an EVM address
    "0x0aef12", // an EVM prefix, 6 hex digits
    "0b1e0c2d3e4f50617283940a0b0c0d0e0f00112233445566778899aabbccddee", // a 64-hex id with no 0x, holding 0 (not base58)
    "9ddc51SoLAddr2nGeneratedKeyKk5pQwErTy8uiop1", // base58, 43
    "x_9ddc51SoLAddr2nGeneratedKeyKk5pQwErTy8uiop1", // base58 glued by "_"
    "someone-private.near",
    "SOMEONE-PRIVATE.NEAR",
    "alice.sweat",
    "bob.tg",
    "carol.testnet",
    "dave.0b1e0c2d3e4f50617283940a0b0c0d0e0f00112233445566778899aabbccddee",
    "BuYVGN…",
    "0x8335...2913",
    "9ddc51...uiop1",
  ])
    assert.equal(one(w), "at <address> now", w);
  // every control and line-separator character is a space
  assert.equal(safeMessage("a\nb\u2028c\u2029d\u0007e\u0085f", []), "a b c d e f");
  // words that are no address stay as they are
  assert.equal(safeMessage("Amount is too low for bridge, try at least 1000.", []), "Amount is too low for bridge, try at least 1000.");
});

test("a request value is replaced: whole, by its start when long, and where the cut message ends inside it", () => {
  const long = "Q".repeat(40) + " " + "W".repeat(300);
  assert.equal(safeMessage(`refund to ${long} refused`, [long]), "refund to <request field>");
  // a long value with a space early, echoed: the cut keeps its first word, and only the tail check knows it
  const spaced = "Q".repeat(20) + " " + "W".repeat(VENDOR_MESSAGE_READ + 1_000);
  const m = `refund to ${spaced} refused`;
  assert.ok(m.length > VENDOR_MESSAGE_READ);
  assert.equal(safeMessage(m, [spaced]), "refund to <request field>");
  // delta review P2-1: glued to a word before it, the start a cut message ends in is still found
  assert.equal(safeMessage(`refund to x${spaced} refused`, [spaced]), "refund to x<request field>");
});

// Review P1: a long message is cut before any pass over it, so no vendor answer (ANSWER_MAX) and no request
// (PROXY_BODY_MAX) holds the helper's event loop. The bound is counted, never timed (scripts/ci/no-wall-clock-asserts.mjs):
// the longest string any regex or String search ran over while the work ran.
const SEARCHES: readonly [object, PropertyKey, "this" | 0][] = [
  [String.prototype, "replace", "this"], [String.prototype, "replaceAll", "this"], [String.prototype, "split", "this"],
  [String.prototype, "indexOf", "this"], [String.prototype, "match", "this"], [String.prototype, "matchAll", "this"],
  [RegExp.prototype, "exec", 0], [RegExp.prototype, "test", 0], [RegExp.prototype, Symbol.replace, 0], [RegExp.prototype, Symbol.split, 0],
];
async function longestSearched(work: () => unknown): Promise<number> {
  let most = 0;
  const undo = SEARCHES.map(([o, k, arg]) => {
    const r = o as Record<PropertyKey, (...a: unknown[]) => unknown>;
    const orig = r[k]!;
    r[k] = function (this: unknown, ...a: unknown[]) {
      const s = arg === "this" ? this : a[0];
      if (typeof s === "string" && s.length > most) most = s.length;
      return orig.apply(this, a);
    };
    return () => void (r[k] = orig);
  });
  try {
    await work();
  } finally {
    for (const u of undo) u();
  }
  return most;
}

for (const [name, m] of [["64 KB of a.", "a.".repeat(32_000)], ["64 KB of x-", "x-".repeat(32_000)], ["64 KB of abc…", "abc…".repeat(16_000)], ["ANSWER_MAX of a.", "a.".repeat(ANSWER_MAX / 2)], ["ANSWER_MAX of 9", "9".repeat(ANSWER_MAX)]] as const)
  test(`a hostile message (${name}) is searched no further than VENDOR_MESSAGE_READ`, async () => {
    let out = "";
    assert.ok((await longestSearched(() => (out = safeMessage(m, [])))) <= VENDOR_MESSAGE_READ, name);
    // one word past the read, with no whole word inside it: nothing of it is kept
    assert.equal(out, "");
  });

test("a vendor that echoes the caller's dotted property name has handle() search no further than VENDOR_MESSAGE_READ, and the name is not logged (cut at the last whole word)", async () => {
  const key = "a.".repeat(30_000);
  const body = JSON.stringify({ ...JSON.parse(QUOTE), [key]: 1 });
  const lines: string[] = [];
  const p = createProxy(ENV, {
    fetch: async (_u, init) => json(400, { message: Object.keys(JSON.parse(String(init?.body))).filter((k) => k.length > 100).map((k) => `property ${k} should not exist`), error: "Bad Request" }),
    log: (l) => lines.push(l),
    sleep: async () => {},
    foldWait: () => new Promise<void>(() => {}),
  });
  const most = await longestSearched(() => p.handle("oneclick", "/v0/quote", "", body, "203.0.113.7"));
  assert.ok(most <= VENDOR_MESSAGE_READ, `a ${body.length} B request: a search over ${most} characters`);
  assert.deepEqual(lines, ['proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "property "']);
});

test("a request with more values than REQUEST_VALUES_MAX has the vendor's message withheld", async () => {
  const body = JSON.stringify(Object.fromEntries(Array.from({ length: REQUEST_VALUES_MAX + 1 }, (_, i) => [`key${i}`, `value${i}`])));
  const { p, said } = proxy(() => json(400, { message: "Failed to get quote" }));
  await p.handle("oneclick", "/v0/quote", "", body, "203.0.113.7");
  assert.deepEqual(said(), ['proxy oneclick /v0/quote answered 400, the vendor\'s: 400 "(withheld: the request held too many values)"']);
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

// The answer says it too: a refusal's Server-Timing names whose it is, refusal;desc="vendor" or refusal;desc="ours", so our
// live check tells 1Click's 400 from the helper's own without a log (scripts/live-checks/helper-says-why-a-vendor-refused.mjs
// reads it; a browser on SIGN_HOST cannot, the header is not exposed).
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

test("past SAID_FOLD_KEYS distinct lines in one window the rest are counted in one line, not written", async () => {
  let n = 0;
  const { p, said, fold, lines } = proxy(() => json(400, { message: `Failed to get quote ${n++}` }));
  for (let i = 0; i < SAID_FOLD_KEYS + 5; i++) await p.handle("oneclick", "/v0/quote", "", QUOTE, "203.0.113.7");
  assert.equal(said().length, SAID_FOLD_KEYS);
  await fold();
  assert.equal(said().length, SAID_FOLD_KEYS);
  assert.deepEqual(lines.slice(-1), [`proxy: 5 more answers not 2xx in 10 s, past ${SAID_FOLD_KEYS} distinct lines`]);
});

// Re-review P2 of card helper-says-why-a-vendor-refused: the line keeps why. The request is the one the wallet sends for a
// deposit (packages/wallet/src/deposit/quote.ts depositQuoteRequest, written out here: the helper reaches no package past
// the kit's entry), and the refusals are 1Click's own words as quote.ts quotes them (ABOUT_THE_REQUEST's comment).
const WALLET_U = "5d".repeat(32);
const WALLET_QUOTE = JSON.stringify({
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:eth.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // gitleaks:allow (a public account id)
  amount: "25000000",
  refundTo: WALLET_U,
  refundType: "INTENTS",
  recipient: WALLET_U,
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-12T20:20:00.000Z",
});
test("1Click's refusals keep their field names and their numbers; no address, amount or id of the request survives", () => {
  const safe = (m: string) => safeMessage(m, requestValues(WALLET_QUOTE, ""));
  assert.deepEqual(
    [
      "Amount is too low for bridge, try at least 1000000",
      "recipient is not valid",
      "refundTo is not valid",
      "nep141:eth.omft.near is not supported as origin asset",
      "nep141:eth.omft.near supports only ORIGIN_CHAIN refundType",
      "deadline must be at least 60 seconds in the future",
      "slippageTolerance must not be greater than 10000",
      "Temporary swap limits: minimum swap amount is $1",
      `recipient ${WALLET_U} is not valid`,
      "amount 25000000 is above the limit",
      "deadline 2026-11-12T20:20:00.000Z has passed",
    ].map(safe),
    [
      "Amount is too low for bridge, try at least 1000000",
      "recipient is not valid",
      "refundTo is not valid",
      "<request field> is not supported as origin asset",
      "<request field> supports only ORIGIN_CHAIN refundType",
      "deadline must be at least 60 seconds in the future",
      "slippageTolerance must not be greater than 10000",
      "Temporary swap limits: minimum swap amount is $1",
      "recipient <request field> is not valid",
      "amount <request field> is above the limit",
      "deadline <request field> has passed",
    ],
  );
  // a value stands alone or is not the request's: the slippage's 100 inside 1000000, the amount inside a longer number
  assert.equal(safe("try 100 or 1000000, not 1100 or 250000000"), "try <request field> or 1000000, not 1100 or 250000000");
  // every place it stands alone, the first found inside a number or not
  assert.equal(safe("1000000 vs 100, and 25000000 is not 25000000"), "1000000 vs <request field>, and <request field> is not <request field>");
  // a value's next place inside the one replaced is no second place
  assert.equal(safeMessage("id a-a-a done", requestValues(JSON.stringify({ x: "a-a" }), "")), "id <request field>-a done");
  // the keys and the all-caps enums are the request's schema, never the user's: out of the values
  assert.deepEqual(requestValues(WALLET_QUOTE, "")?.filter((v) => /^[A-Z_]+$|^(recipient|refundTo|amount|deadline)$/.test(v)), []);
  // an enum is all capitals and "_", whole: a value with capitals in it stays a value
  assert.deepEqual(requestValues(JSON.stringify({ a: "EXACT_INPUT", b: "myREF123", c: "Ab_CD" }), ""), ["myREF123", "Ab_CD"]);
});

// Re-review P3: marks a vendor's echo may carry inside an id, and an id spelt percent-encoded, hide nothing.
test("zero-width and direction marks are stripped and %XX is decoded before the passes; two dots shorten too", () => {
  const evm = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const sol = "9ddc51SoLAddr2nGeneratedKeyKk5pQwErTy8uiop1";
  for (const [label, m] of [
    ["a zero-width mark every 5 characters", `recipient ${evm.match(/.{1,5}/g)!.join("​")} is not valid`],
    ["a zero-width joiner inside a named account", "refundTo someone‍-private.near is not valid"],
    ["a word joiner and a BOM", `recipient ${evm.slice(0, 20)}⁠${evm.slice(20)}﻿ is not valid`],
    ["a percent-encoded dot", "refundTo someone-private%2Enear is not valid"],
    ["a percent-encoded hyphen and dot", "refundTo someone%2Dprivate%2enear is not valid"],
    ["two dots in a short form", `deposit ${sol.slice(0, 6)}..${sol.slice(-5)} not found`],
  ] as const)
    assert.match(safeMessage(m, []), /^(recipient|refundTo|deposit) <address> (is not valid|not found)$/, label);
  // a direction override never reaches the line, nor any mark of the stripped ranges
  const marks = "​‌‍‎‏‪‫‬‭‮⁠⁦⁧⁨⁩﻿";
  assert.equal(safeMessage(`Failed ‮etouq teg ot‬ ${marks}done`, []), "Failed etouq teg ot done");
  // a %XX past ASCII is left as written (two in a row; three or more are an encoded run, below), and %XX is decoded until
  // unchanged, DECODE_ROUNDS at most
  assert.equal(safeMessage("50%C3%A9 and 200%252E", []), "50%C3%A9 and 200.");
});

// Delta review of card helper-says-why-a-vendor-refused at e08eebd2e: the wallet's own request shapes, ids as derived.
const DU = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // 64 hex, 0s inside, as a real U
const DSOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const DEVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55's own test vector
const walletQuote = (recipient: string, refundTo: string) =>
  JSON.stringify({ dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:eth.omft.near", depositType: "ORIGIN_CHAIN", destinationAsset: "nep141:sol.omft.near", amount: "25000000", refundTo, refundType: "INTENTS", recipient, recipientType: "DESTINATION_CHAIN", deadline: "2026-11-12T20:20:00.000Z" });
/** The 8-character pieces of `value` a line still holds, case and marks aside. */
const pieces = (line: string, value: string): string[] => {
  const l = line.toLowerCase().replace(/[^0-9a-z]/g, "");
  const v = value.toLowerCase().replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i + 8 <= v.length; i += 8) if (l.includes(v.slice(i, i + 8))) out.push(v.slice(i, i + 8));
  return out;
};

test("P2-1: a request value glued to other letters or digits is replaced; a number only where no digit touches it", () => {
  for (const [body, m, v] of [
    [walletQuote(DU, DU), `recipientx${DU} is not valid`, DU],
    [walletQuote(DU, DU), `refund ids ${DU}s are not valid`, DU],
    [walletQuote(DSOL, DU), `walletSol${DSOL} is not valid`, DSOL],
    [walletQuote(DSOL, DU), `recipient ${DSOL}0 is not valid`, DSOL],
    [walletQuote(DEVM, DU), `recipienta${DEVM} is not valid`, DEVM],
    [walletQuote(DEVM, DU), `recipient ${DEVM}is not valid`, DEVM],
  ] as const) {
    const line = safeMessage(m, requestValues(body, ""));
    assert.deepEqual(pieces(line, v), [], line);
    assert.match(line, /<request field>/, m);
  }
  const safe = (m: string) => safeMessage(m, requestValues(walletQuote(DU, DU), ""));
  assert.equal(safe("amount25000000 is above the limit"), "amount<request field> is above the limit");
  assert.equal(safe("amount 25000000wei is above the limit"), "amount <request field>wei is above the limit");
  assert.equal(safe("try at least 1000000, slippage 100"), "try at least 1000000, slippage <request field>");
});

test("P3-1: every default-ignorable mark is stripped, so none splits U, a Solana address or an EVM address", () => {
  const every = (x: string, n: number, mark: string) => x.match(new RegExp(`.{1,${n}}`, "g"))!.join(mark);
  for (const mark of ["\u00ad", "\u034f", "\u061c", "\u180e", "\ufe0f", "\u{e0041}", "\u3164"]) {
    const name = `U+${mark.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    for (const [v, body] of [[DU, walletQuote(DU, DU)], [DSOL, walletQuote(DSOL, DU)], [DEVM, walletQuote(DEVM, DU)]] as const) {
      const line = safeMessage(`recipient ${every(v, 7, mark)} is not valid`, requestValues(body, ""));
      assert.equal(line, "recipient <request field> is not valid", `${name} in ${v.slice(0, 6)}`);
      // with no request to name it, the address rules see it whole
      assert.equal(safeMessage(`recipient ${every(v, 7, mark)} is not valid`, []), "recipient <address> is not valid", `${name} in ${v.slice(0, 6)}, no request`);
    }
  }
});

test("P3-2: %XX is decoded until unchanged, 3 rounds at most, and an encoded run left after them is replaced", () => {
  const pct = (x: string, rounds: number) => [...x].map((c) => "%" + "25".repeat(rounds - 1) + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const values = requestValues(walletQuote(DU, DU), "");
  for (const rounds of [1, 2, 3]) assert.equal(safeMessage(`recipient ${pct(DU, rounds)} is not valid`, values), "recipient <request field> is not valid", `${rounds} rounds`);
  // four rounds: what is left is an encoded run, and no piece of U is in the line
  assert.equal(safeMessage(`recipient ${pct(DU, 4)} is not valid`, values), "recipient <encoded> is not valid");
  assert.equal(safeMessage(`recipient ${pct(DU, 4)} is not valid`, []), "recipient <encoded> is not valid");
  // three %XX in a row are an encoded run, two are not: a UTF-8 character of three bytes, left as written by the decode
  assert.equal(safeMessage("id %E3%81%82 and %C3%A9", []), "id <encoded> and %C3%A9");
});

test("P3-4: replacements never grow the message a later pass searches past VENDOR_MESSAGE_READ", async () => {
  // 512 places of a 3-character value, each standing alone: each "<request field>" is 12 characters longer
  const m = "v00 ".repeat(VENDOR_MESSAGE_READ / 4 - 1) + " " + "z".repeat(10_000);
  const values = requestValues(JSON.stringify({ a: "v00", b: "zzz" }), "");
  let out = "";
  assert.ok((await longestSearched(() => (out = safeMessage(m, values)))) <= VENDOR_MESSAGE_READ);
  assert.ok(!out.includes("v00"), out.slice(0, 80));
  // "request field", "request" and "field" as values too: each grows what the one before it wrote
  const grow = requestValues(JSON.stringify({ a: "request field", b: "request", c: "field" }), "");
  assert.ok((await longestSearched(() => safeMessage(" request field".repeat(140) + " " + "z".repeat(10_000), grow))) <= VENDOR_MESSAGE_READ);
});
