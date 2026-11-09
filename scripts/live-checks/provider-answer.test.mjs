// The shared provider-answer rule (provider-answer.mjs): every no-answer kind planted, every judged kind planted, the
// re-read once, and the kit's words held equal to these (read from the files the kit's entry loads, never a deep path).
//   node --test scripts/live-checks/provider-answer.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { classify, LIMIT_CODES, NOT_YET, pageRefuses, preflight, preflightRefuses, RATE_LIMIT, RETRY, rpcAnswer, STATELESS } from "./provider-answer.mjs";
import { NO_ANSWERS } from "./provider-answer.plants.mjs";

// a no-answer is read again at once here, not after provider-answer.mjs's pause
RETRY.ms = 0;

const rpcErr = (code, message) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });
const ok = (result) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

test("each no-answer is named with its host and status, never an answer", () => {
  for (const [name, status, body] of NO_ANSWERS) {
    const a = classify("p.example", status, body);
    assert.equal(typeof a.noAnswer, "string", name);
    assert.match(a.noAnswer, new RegExp(`^p\\.example HTTP ${status}: `), name);
    assert.equal("result" in a || "error" in a, false, name);
  }
});

test("an answer is judged: a result, a revert (whatever its words), any other JSON-RPC error, on a 403 too", () => {
  assert.deepEqual(classify("p", 200, ok("0x2a")), { result: "0x2a" });
  assert.deepEqual(classify("p", 200, ok(null)), { result: null });
  // a revert's string is the called contract's: "header not found" or "rate limit" inside one is judged
  for (const m of ["execution reverted: header not found", "execution reverted: rate limit"]) assert.deepEqual(classify("p", 200, rpcErr(-32000, m)), { error: { code: -32000, message: m } }, m);
  assert.deepEqual(classify("p", 200, rpcErr(3, "request limit reached")), { error: { code: 3, message: "request limit reached" } });
  // a provider that stops applying a code override answers an error: judged, and a check fails it
  assert.deepEqual(classify("p", 200, rpcErr(-32602, "invalid argument 2: state override not supported")), { error: { code: -32602, message: "invalid argument 2: state override not supported" } });
  // a 403 that carries a real JSON-RPC error is judged (review P3-2)
  assert.deepEqual(classify("p", 403, rpcErr(-32601, "method not allowed")), { error: { code: -32601, message: "method not allowed" } });
});

test("nullNoAnswer: a null result is a provider not holding the block yet, only when asked", () => {
  assert.equal(typeof classify("p", 200, ok(null), { nullNoAnswer: true }).noAnswer, "string");
  assert.deepEqual(classify("p", 200, ok("0x0"), { nullNoAnswer: true }), { result: "0x0" });
});

test("judgeStateMiss: a block or state the provider does not hold is judged; every other no-answer stays one", () => {
  const state = NO_ANSWERS.filter(([name]) => /state|not found|unknown block/i.test(name) && !/rate limit/.test(name));
  assert.equal(state.length, 6);
  for (const [name, status, body] of state) {
    const a = classify("p", status, body, { judgeStateMiss: true });
    assert.equal(a.noAnswer, undefined, name);
    assert.equal(typeof a.error?.message, "string", name);
  }
  for (const [name, status, body] of NO_ANSWERS.filter((x) => !state.includes(x))) assert.equal(typeof classify("p", status, body, { judgeStateMiss: true }).noAnswer, "string", name);
});

// review of 6cfd2778, P3-4: a state miss whose words also name a limit is judged when the check judges state misses
test("judgeStateMiss: the state words are read before the limit words", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "historical state 0xabc is not available: request limit reached" } });
  assert.deepEqual(classify("p", 200, body, { judgeStateMiss: true }), { error: { code: -32000, message: "historical state 0xabc is not available: request limit reached" } });
  assert.equal(typeof classify("p", 200, body).noAnswer, "string");
  // a null block is marked, for a check that tells a block no provider holds from a provider that lags
  assert.equal(classify("p", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { nullNoAnswer: true }).nullResult, true);
});

test("rpcAnswer pauses RETRY.ms before it reads again", async () => {
  RETRY.ms = 300;
  try {
    const t = Date.now();
    await rpcAnswer("https://p.example/rpc", "eth_chainId", [], { fetchFn: async () => new Response("", { status: 200 }) });
    assert.ok(Date.now() - t >= 290);
  } finally {
    RETRY.ms = 0;
  }
});

test("rpcAnswer reads a no-answer again once, and no more", async () => {
  for (const [name, status, body] of NO_ANSWERS) {
    let n = 0;
    const second = await rpcAnswer("https://p.example/rpc", "eth_chainId", [], { fetchFn: async () => (n++ === 0 ? new Response(body, { status }) : new Response(ok("0x1"), { status: 200 })) });
    assert.deepEqual(second, { result: "0x1" }, name);
    assert.equal(n, 2, name);
    n = 0;
    const never = await rpcAnswer("https://p.example/rpc", "eth_chainId", [], { fetchFn: async () => (n++, new Response(body, { status })) });
    assert.equal(typeof never.noAnswer, "string", name);
    assert.equal(n, 2, name);
  }
  let n = 0;
  const thrown = await rpcAnswer("https://p.example/rpc", "eth_chainId", [], {
    fetchFn: async () => {
      n++;
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    },
  });
  assert.deepEqual([thrown, n], [{ noAnswer: "p.example: no answer (ECONNREFUSED)" }, 2]);
  // an answer is never read again
  n = 0;
  const once = await rpcAnswer("https://p.example/rpc", "eth_call", [], { fetchFn: async () => (n++, new Response(rpcErr(-32000, "out of gas"), { status: 200 })) });
  assert.deepEqual([once, n], [{ error: { code: -32000, message: "out of gas" } }, 1]);
});

test("the request is one JSON-RPC 2.0 POST of the method and its params", async () => {
  let seen;
  await rpcAnswer("https://p.example/rpc", "eth_getBlockByNumber", ["latest", false], { fetchFn: async (url, init) => ((seen = [url, init.method, JSON.parse(init.body)]), new Response(ok({}), { status: 200 })) });
  assert.deepEqual(seen, ["https://p.example/rpc", "POST", { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }]);
});

// card wallet-restore-reads-ux: a read asked from a page's origin (wallet-restore-reads-ux.mjs reads the restore's
// providers as SIGN_HOST's page does)
test("a read with its own headers sends them and the redirect rule, and gets the answer's status and CORS answer back; a read without is as before", async () => {
  let seen;
  const a = await rpcAnswer("https://p.example/rpc", "getBalance", ["u"], {
    headers: { origin: "https://page.example" },
    redirect: "error",
    fetchFn: async (url, init) => ((seen = init), new Response(ok({ value: 7 }), { status: 200, headers: { "access-control-allow-origin": "*" } })),
  });
  assert.deepEqual([seen.headers, seen.redirect], [{ "content-type": "application/json", origin: "https://page.example" }, "error"]);
  assert.deepEqual(a, { result: { value: 7 }, status: 200, acao: "*" });
  // a refusal read again once: the last answer's status and CORS answer
  let n = 0;
  const r = await rpcAnswer("https://p.example/rpc", "getBalance", ["u"], { headers: { origin: "https://page.example" }, fetchFn: async () => (n++, new Response("Forbidden", { status: 403 })) });
  assert.deepEqual([r.status, r.acao, typeof r.noAnswer, n], [403, null, "string", 2]);
  // no answer at all: no status
  const t = await rpcAnswer("https://p.example/rpc", "getBalance", ["u"], { headers: { origin: "https://page.example" }, fetchFn: async () => { throw new DOMException("timed out", "TimeoutError"); } });
  assert.deepEqual(t, { noAnswer: "p.example: no answer (TimeoutError)" });
  // a read without headers: the same answer as before this card, no status beside it
  const plain = await rpcAnswer("https://p.example/rpc", "getBalance", ["u"], { fetchFn: async (url, init) => ((seen = init), new Response(ok(1), { status: 200, headers: { "access-control-allow-origin": "*" } })) });
  assert.deepEqual([plain, seen.headers, "redirect" in seen], [{ result: 1 }, { "content-type": "application/json" }, false]);
});

test("pageRefuses: an answer the page's origin may not read is the page's real answer, never a no-answer", () => {
  const O = "https://page.example";
  const u = "https://p.example/rpc";
  // api.mainnet-beta.solana.com's answer to a request with an Origin header: a non-JSON 403 with no CORS answer
  assert.match(pageRefuses(u, { noAnswer: "p.example HTTP 403: not JSON (Forbidden)", status: 403, acao: null }, O), /^p\.example HTTP 403: https:\/\/page\.example may not read its answer \(Access-Control-Allow-Origin null\)$/);
  // a JSON answer without the origin: the page reads nothing either
  assert.equal(typeof pageRefuses(u, { result: 1, status: 200, acao: "https://other.example" }, O), "string");
  assert.equal(typeof pageRefuses(u, { result: 1, status: 200, acao: null }, O), "string");
  // the origin or * admitted: not a refusal, whatever the answer
  assert.equal(pageRefuses(u, { result: 1, status: 200, acao: "*" }, O), null);
  assert.equal(pageRefuses(u, { noAnswer: "x", status: 200, acao: O }, O), null);
  // no HTTP answer (a fetch that failed or timed out), or a 429 (a rate limit, read as one whatever its headers): a no-answer
  assert.equal(pageRefuses(u, { noAnswer: "p.example: no answer (TimeoutError)" }, O), null);
  assert.equal(pageRefuses(u, { noAnswer: "p.example HTTP 429: 429 Too Many Requests", status: 429, acao: null }, O), null);
  // an answer read without the page's headers carries no status (null in a record): refused, never taken as admitted
  assert.equal(typeof pageRefuses(u, { result: 1, status: null }, O), "string");
  assert.equal(pageRefuses(u, { noAnswer: "p.example: no answer (TimeoutError)", status: null, acao: null }, O), null);
  assert.equal(typeof pageRefuses(u, { result: 1 }, O), "string");
});

// review of 7921e919..9f6473ac (card wallet-restore-reads-ux)
test("P2-1: a 5xx with no CORS answer is a provider's passing fault, a no-answer, as a 429 is", () => {
  const O = "https://page.example";
  for (const status of [500, 502, 503, 504]) assert.equal(pageRefuses("https://p.example/rpc", { noAnswer: `p.example HTTP ${status}: not JSON (Bad gateway)`, status, acao: null }, O), null, String(status));
  // a 4xx other than 429 with no CORS answer stays the page's refusal
  for (const status of [401, 403, 404, 405]) assert.equal(typeof pageRefuses("https://p.example/rpc", { noAnswer: "x", status, acao: null }, O), "string", String(status));
});

test("P3-3: the page's Solana throttle codes are a rate limit whatever their words, as the page reads them", () => {
  for (const code of [-32029, -32429, -429, 15, 429, -32005]) {
    const a = classify("p", 200, rpcErr(code, "Too many"));
    assert.match(a.noAnswer ?? "", /^p HTTP 200: rate limit /, String(code));
  }
  // a revert under one of them is still the contract's
  assert.deepEqual(classify("p", 200, rpcErr(3, "x")), { error: { code: 3, message: "x" } });
});

test("P3-3: the throttle codes are the kit's own (RPC_THROTTLE_CODES in the files the kit's entry loads)", () => {
  const entry = fileURLToPath(new URL("../../packages/kit/src/index.ts", import.meta.url));
  const program = ts.createProgram([entry], { noEmit: true, noLib: true, types: [], allowImportingTsExtensions: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext });
  const sets = [];
  for (const f of program.getSourceFiles()) for (const m of f.text.matchAll(/\nconst RPC_THROTTLE_CODES\b[^=]*= new Set\(\[([^\]]*)\]\)/g)) sets.push(m[1].split(",").map((x) => Number(x.trim())));
  assert.equal(sets.length, 1);
  for (const c of sets[0]) assert.ok(LIMIT_CODES.has(c), String(c));
});

test("P3-2: a redirect is named as one, never as a provider that said nothing", async () => {
  const a = await rpcAnswer("https://p.example/rpc", "getBalance", [], {
    headers: { origin: "https://page.example" },
    redirect: "error",
    fetchFn: async () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    },
  });
  assert.equal(a.noAnswer, "p.example: no answer (it redirects, and a redirect is not followed: unexpected redirect)");
});

test("P3-1: the CORS preflight is sent as a page's browser sends it, and read", async () => {
  const O = "https://page.example";
  let seen;
  const p = await preflight("https://p.example/rpc", O, {
    fetchFn: async (url, init) => ((seen = [url, init.method, init.headers, init.redirect, "body" in init]), new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type, X-A" } })),
  });
  assert.deepEqual(seen, ["https://p.example/rpc", "OPTIONS", { origin: O, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }, "error", false]);
  assert.deepEqual(p, { status: 204, acao: "*", allowHeaders: "Content-Type, X-A" });
  assert.equal(preflightRefuses("https://p.example/rpc", p, O), null);
  assert.equal(preflightRefuses("https://p.example/rpc", { status: 200, acao: O, allowHeaders: "*" }, O), null);
  // refused: not 2xx (405 with POST admitted), no CORS answer, another origin, content-type not allowed, none read
  assert.match(preflightRefuses("https://p.example/rpc", { status: 405, acao: "*", allowHeaders: "content-type" }, O), /^p\.example HTTP 405: /);
  assert.equal(typeof preflightRefuses("https://p.example/rpc", { status: 204, acao: null, allowHeaders: "content-type" }, O), "string");
  assert.equal(typeof preflightRefuses("https://p.example/rpc", { status: 204, acao: "https://x.example", allowHeaders: "content-type" }, O), "string");
  assert.equal(typeof preflightRefuses("https://p.example/rpc", { status: 204, acao: "*", allowHeaders: "x-a" }, O), "string");
  assert.equal(typeof preflightRefuses("https://p.example/rpc", { status: 204, acao: "*", allowHeaders: null }, O), "string");
  assert.equal(typeof preflightRefuses("https://p.example/rpc", undefined, O), "string");
  // a passing fault (no answer, 429, 5xx) is read again once, then a no-answer, never a refusal
  for (const f of [async () => new Response("", { status: 503 }), async () => new Response("", { status: 429 }), async () => { throw new DOMException("t", "TimeoutError"); }]) {
    let n = 0;
    const q = await preflight("https://p.example/rpc", O, { fetchFn: async () => (n++, f()) });
    assert.equal(typeof q.noAnswer, "string");
    assert.equal(n, 2);
    assert.equal(preflightRefuses("https://p.example/rpc", q, O), null);
  }
});

// The kit's words (its EVM quote's module-private limited, notYet and stateless), read from the
// files the kit's entry loads: TypeScript follows packages/kit/src/index.ts's own imports, so this test names no file
// past the entry. A change on either side fails here until both say the same.
test("the rate-limit, not-yet and stateless words are the kit's own", () => {
  const entry = fileURLToPath(new URL("../../packages/kit/src/index.ts", import.meta.url));
  const program = ts.createProgram([entry], { noEmit: true, noLib: true, types: [], allowImportingTsExtensions: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext });
  const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes("/node_modules/"));
  assert.ok(files.length > 10, "the entry's files were read");
  // each top-level `const <name> = ...;` in the entry's files (to the first `;` that ends a line followed by an
  // unindented or empty one), to the regex literals its body tests with
  const words = (name) => {
    const out = [];
    for (const f of files)
      for (const m of f.text.matchAll(new RegExp(`\\nconst ${name} = ([\\s\\S]*?);\\n(?=\\S|\\n)`, "g")))
        out.push(...[...m[1].matchAll(/\/((?:\\\/|[^/\n])+)\/([a-z]*)\.test\(/g)].map((x) => `/${x[1]}/${x[2]}`));
    return out;
  };
  // the EVM quote's limited (the pool index's copy is not among the entry's files)
  assert.deepEqual(words("limited"), [String(RATE_LIMIT)]);
  assert.deepEqual(words("notYet"), [String(NOT_YET)]);
  assert.deepEqual(words("stateless"), [String(STATELESS)]);
});
