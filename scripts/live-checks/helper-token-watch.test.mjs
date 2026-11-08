// node --test scripts/live-checks/helper-token-watch.test.mjs: the live check replays recorded runs
// (helper-token-watch.answers.json). good: apps/helper at cdf50e0 on a Mac reading mainnet on FastNEAR and
// dRPC: PASS. bad_hash: the same build whose two providers report another code hash for USDC: FAIL on the pin. Made
// from the good run: a halted answer, a blocked vault, the kit's null rule broken, another token answered, a missing
// read: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, OTHER, read, USDC } from "./helper-token-watch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-token-watch.answers.json"), "utf8"));

const replay = (run) => async (url, init) => {
  const token = new URL(url).searchParams.get("token");
  assert.equal(new URL(url).pathname, "/v1/token-status");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
  const r = run.reads.find((x) => x.asked === token);
  return new Response(r.body, { status: r.status, headers: r.headers });
};
const run = async (rec) => judge(await read("https://ct-api.unrealized.trade", replay(rec)));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withUsdc = (f) => ({ ...A.good, reads: A.good.reads.map((x) => (x.asked === USDC ? { ...x, body: JSON.stringify(f(JSON.parse(x.body))) } : x)) });

test("recorded good run: USDC in the kit's shape, the pinned code hash, not halted; another token not watched: PASS", async () => {
  const r = await run(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  code_hash \"DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q\" is the pin DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q"));
});

test("recorded bad run: a changed code hash: FAIL on the pin", async () => {
  const r = await run(A.bad_hash);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r), ['BAD code_hash "GT71B8i42Z2xegTKpA6TUJQYghRqZfyJUNJG6rKf21DT" is the pin DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q']);
});

test("made from the good run: halted, a blocked vault, the null rule broken, a watched other token, a missing read: each FAIL", async () => {
  const halted = await run(withUsdc((b) => ({ ...b, caught_up: true, halted: true, vault_blocked: false, code_hash_ok: true })));
  assert.ok(bad(halted).includes("BAD not halted: halted true"));
  const blocked = await run(withUsdc((b) => ({ ...b, caught_up: true, halted: false, vault_blocked: true, code_hash_ok: true })));
  assert.equal(blocked.ok, false);
  const rule = await run(withUsdc((b) => ({ ...b, caught_up: false, halted: false })));
  assert.ok(bad(rule).includes("BAD not caught up, so halted, vault_blocked and code_hash_ok are null (the kit's rule)"));
  const wrongOk = await run(withUsdc((b) => ({ ...b, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: false })));
  assert.equal(wrongOk.ok, false);
  const other = await run({ ...A.good, reads: A.good.reads.map((x) => (x.asked === OTHER ? { ...x, status: 200 } : x)) });
  assert.equal(other.ok, false);
  const missing = judge({ reads: A.good.reads.filter((x) => x.asked === USDC) });
  assert.equal(missing.ok, false);
  const clear = await run(withUsdc((b) => ({ ...b, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true })));
  assert.equal(clear.ok, true, "a caught-up, clear answer passes too");
});
