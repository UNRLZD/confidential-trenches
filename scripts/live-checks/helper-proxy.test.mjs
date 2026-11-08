// node --test scripts/live-checks/helper-proxy.test.mjs: the live check replays recorded answers
// (helper-proxy.answers.json; the keys in it were planted for that run, never real ones). good: apps/helper at ccab198
// in its image behind deploy/Caddyfile, run by deploy/compose.yaml on a Mac (HELPER_HOST has no server yet): PASS.
// bad_echo: a real answer from a wrong build of the same source that echoes the 1Click key in a header: FAIL. Made
// from the good answer: the key in the body in base64, an answer that is not a token list, a missing source header,
// and no key to look for: each FAIL. The keys come from the environment only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ENV_KEYS, envKeys, judge, read } from "./helper-proxy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-proxy.answers.json"), "utf8"));

// a fetch that answers with the recorded answer, after checking the check asked the right thing
const replay = (a) => async (url, init) => {
  assert.match(url, /\/v1\/proxy\/oneclick\/v0\/tokens$/);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  return new Response(a.body, { status: a.status, headers: a.headers });
};
const run = async (a, keys = a.keys) => {
  const r = await read("https://ct-api.unrealized.trade", replay(a));
  r.readAt = a.readAt; // the recorded read's own time, for the X-Fetched-At window
  return judge(r, keys);
};

test("recorded good answer: 200, a token list, the source and fetch time, the CORS echo, no key anywhere: PASS", async () => {
  assert.equal(A.good.keys.length, 4);
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes('ok  X-Helper-Source: "oneclick"'));
  assert.ok(r.lines.includes("ok  key 4 (42 chars) appears nowhere"));
});

test("recorded bad answer: a build that echoes the 1Click key in a header: FAIL", async () => {
  const r = await run(A.bad_echo);
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), ["BAD key 4 (42 chars) appears nowhere: found in header x-debug-upstream-auth"]);
});

test("the good answer with a key in the body, in base64: FAIL", async () => {
  const key = A.good.keys[1];
  const rows = JSON.parse(A.good.body);
  rows[0].symbol = Buffer.from(key).toString("base64");
  const r = await run({ ...A.good, body: JSON.stringify(rows) });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD key 2 (39 chars) appears nowhere: found in body"), r.lines.join("\n"));
});

test("an answer that is not a token list, or has no X-Helper-Source: FAIL", async () => {
  const notList = await run({ ...A.good, body: JSON.stringify({ error: { code: "upstream" } }), status: 503 });
  assert.equal(notList.ok, false);
  assert.ok(notList.lines.includes("BAD POST /v1/proxy/oneclick/v0/tokens answers 503"));
  assert.ok(notList.lines.includes("BAD body is a non-empty array of token rows: not an array"));
  const rows = JSON.parse(A.good.body);
  rows[3] = { ...rows[3], decimals: "18" };
  const badRow = await run({ ...A.good, body: JSON.stringify(rows) });
  assert.equal(badRow.ok, false);
  const { "x-helper-source": _, ...noSource } = A.good.headers;
  const r = await run({ ...A.good, headers: noSource });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD X-Helper-Source: none"));
});

test("no key to look for is never a pass", async () => {
  const r = await run(A.good, []);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD 0 vendor key(s) to look for"));
});

test("the keys to look for come from the four env variables only; a blank one is not looked for", () => {
  assert.deepEqual(ENV_KEYS, ["JUPITER_API_KEY", "RELAY_API_KEY", "LIFI_API_KEY", "ONECLICK_JWT"]);
  assert.deepEqual(envKeys({ JUPITER_API_KEY: "j1", RELAY_API_KEY: " ", ONECLICK_JWT: "o1\n", OTHER_KEY: "x" }), ["j1", "o1"]);
  assert.deepEqual(envKeys({}), []);
});

test("run with none of them set, the check is an error naming the variables, and reads nothing", () => {
  const stub = "globalThis.fetch=async(u)=>{throw new Error('called '+u)}";
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !ENV_KEYS.includes(k)));
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, path.join(HERE, "helper-proxy.mjs")], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr.trim(), "live-check helper-proxy: ERROR: no vendor key to look for: set at least one of JUPITER_API_KEY, RELAY_API_KEY, LIFI_API_KEY, ONECLICK_JWT");
});
