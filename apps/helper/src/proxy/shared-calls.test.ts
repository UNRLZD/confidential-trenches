// node --test apps/helper/src/proxy/shared-calls.test.ts (card helper-deploy-reads-fast): while a deploy's two helpers
// overlap on one Jupiter key, each counts the other's calls (shared-calls.ts), so together they never take Jupiter past
// its minute. At e89cfae0 each counted only its own: live run 42125976095 attempt 1, helper-token-page-cold "31 of 32 page
// reads answered 200; 1 did not: 503 Server-Timing search-held;desc=\"jupiter held\"".
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProxy } from "./proxy.ts";
import * as shared from "./shared-calls.ts";

const ENV = {
  JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16),
  RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16),
  LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16),
  ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16),
};
const PATH = "/tokens/v2/search";
const OLD = "0b1d0000-0000-4000-8000-000000000001";
const NEW = "0e300000-0000-4000-8000-000000000002";

/** Jupiter Free on one key, shared by both helpers: 60 calls a sliding minute, a 429 past it. */
function jupiterFree() {
  let t = 1_800_000_000_000;
  const calls: number[] = [];
  let throttled = 0;
  const fetch = async () => {
    while (calls.length > 0 && t - calls[0]! >= 60_000) calls.shift();
    if (calls.length >= 60) return (throttled++, new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
    calls.push(t);
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), add: (ms: number) => void (t += ms) };
  return { fetch, clock, throttled: () => throttled };
}
type P = ReturnType<typeof createProxy> & Record<string, any>;
/** A helper as server.ts starts it: its proxy with its calls file under the shared store (none at e89cfae0). */
const proxyOn = (j: ReturnType<typeof jupiterFree>, dir?: string, id?: string): P => {
  const files = (shared as Record<string, any>).callsFiles as ((d: string, i: string, n: () => number) => unknown) | undefined;
  return createProxy(ENV, { fetch: j.fetch as never, now: j.clock.now, sleep: j.clock.sleep, ...(dir && files ? { peers: files(dir, id!, j.clock.now) } : {}) } as never) as P;
};
/** One call: the helper's own reads (reserved) on even turns, a device's on odd ones. */
const call = (p: P, tag: string, i: number) => p.handle("jupiter", PATH, `query=${tag}${i}`, "", i % 2 === 0 ? undefined : `198.51.100.${i % 250}`, i % 2 === 0).then((a) => a.status);

test("card helper-deploy-reads-fast: two helpers on one Jupiter key through a deploy's overlap, each asked a call a second, count each other's calls: Jupiter never answers 429, so neither holds; at e89cfae0 together they drew 2 a second against its 60 a minute", async () => {
  assert.equal(typeof (shared as Record<string, unknown>).callsFiles, "function", "proxy/shared-calls.ts callsFiles: the helpers count each other's calls");
  const j = jupiterFree();
  const dir = mkdtempSync(join(tmpdir(), "ct-shared-calls-"));
  const old = proxyOn(j, dir, OLD);
  const next = proxyOn(j, dir, NEW);
  // the overlap: the old helper's own reads and its callers, the new one's warm-up, both live, for two minutes
  for (let i = 0; i < 120; i++) {
    j.clock.add(1_000);
    await Promise.all([call(old, "old", i), call(next, "new", i)]);
  }
  assert.equal(j.throttled(), 0, "Jupiter answered 429: the two helpers drew past its minute on their one key");
  // the old helper stops: its file still counts its calls until they leave Jupiter's window, as they do at Jupiter
  for (let i = 0; i < 30; i++) (j.clock.add(1_000), await call(next, "after", i));
  assert.equal(j.throttled(), 0, "Jupiter answered 429 after the old helper's stop");
  // a minute on, the new helper draws alone: a call a second all answered
  j.clock.add(61_000);
  const alone: number[] = [];
  for (let i = 0; i < 30; i++) (j.clock.add(1_000), alone.push(await call(next, "alone", i)));
  assert.deepEqual(alone, Array(30).fill(200));
  assert.equal(j.throttled(), 0);
  // past CALLS_STALE_MS the stopped helper's file is removed at the next draw
  j.clock.add(shared.CALLS_STALE_MS);
  await call(next, "late", 0);
  assert.deepEqual(readdirSync(join(dir, shared.CALLS_DIR)).sort(), [`${NEW}.json`]);
});

test("card helper-deploy-reads-fast: another helper's calls file is hostile input: a stranger's name, a file past CALLS_FILE_MAX, bad JSON, a malformed time, a __proto__ key, and the seed's bounds (whole ms, no later than a second on, VENDOR_SEED_MAX a vendor)", () => {
  const j = jupiterFree();
  const dir = mkdtempSync(join(tmpdir(), "ct-shared-calls-"));
  const d = join(dir, shared.CALLS_DIR);
  mkdirSync(d, { recursive: true });
  const t = j.clock.now();
  const at = (v: unknown) => `{"at":${t},"vendors":${v}}`;
  writeFileSync(join(dir, "aaaaaaaa-0000-4000-8000-00000000000a.json"), at(`{"jupiter":[${t}]}`)); // outside the directory
  writeFileSync(join(d, "Evil Name.json"), at(`{"jupiter":[${t}]}`));
  writeFileSync(join(d, "aaaaaaaa-0000-4000-8000-000000000003.json"), "{not json");
  writeFileSync(join(d, "bbbbbbbb-0000-4000-8000-000000000004.json"), at(`{"jupiter":[${t + 120_000},1.5,"2",null,${t}],"__proto__":[${t}],"evil":[${t}]}`));
  writeFileSync(join(d, "cccccccc-0000-4000-8000-000000000005.json"), at(`{"jupiter":[${Array(20_000).fill(t).join(",")}]}`));
  writeFileSync(join(d, "dddddddd-0000-4000-8000-000000000006.json"), `{"at":"now","vendors":{"jupiter":[${t}]}}`);
  writeFileSync(join(d, `${NEW}.json`), at(`{"jupiter":[${t},${t}]}`)); // our own file: never counted as another's
  const files = shared.callsFiles(dir, NEW, j.clock.now)!;
  const read = files.read() as Record<string, unknown[]>;
  assert.equal(Object.getPrototypeOf(read), null);
  assert.deepEqual({ ...read }, JSON.parse(`{"jupiter":[${t + 120_000},1.5,"2",null,${t}],"__proto__":[${t}],"evil":[${t}]}`), "only the one well-named, bounded, parsed, timed file read");
  assert.equal(({} as Record<string, unknown>).push, undefined, "a __proto__ key reached no prototype");
  // the seed counts only whole ms times no later than a second on, and at most VENDOR_SEED_MAX a vendor
  const p = proxyOn(j);
  p.seed(read);
  assert.deepEqual(p.calls().jupiter, [], "the seeded calls are the others', never this helper's own");
  const q = proxyOn(j, dir, NEW);
  // 59 seeded at t: one call left in Jupiter's 60 at t, so a second device call at t is refused before Jupiter
  writeFileSync(join(d, "bbbbbbbb-0000-4000-8000-000000000004.json"), at(`{"jupiter":[${Array(59).fill(t).join(",")},${t + 120_000},1.5]}`));
  return Promise.all([call(q, "x", 0), call(q, "y", 2)]).then((got) => {
    assert.deepEqual(got.sort(), [200, 503], "the 59 well-formed calls counted, the future and fractional ones not");
    assert.equal(j.throttled(), 0);
  });
});
