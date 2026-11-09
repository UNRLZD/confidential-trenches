// The shared provider-answer rule (provider-answer.mjs): every no-answer kind planted, every judged kind planted, the
// re-read once, and the kit's words held equal to these (read from the files the kit's entry loads, never a deep path).
//   node --test scripts/live-checks/provider-answer.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { classify, NOT_YET, RATE_LIMIT, RETRY, rpcAnswer, STATELESS } from "./provider-answer.mjs";
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
