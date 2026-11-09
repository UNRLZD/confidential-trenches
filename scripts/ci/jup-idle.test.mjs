// node --test scripts/ci/jup-idle.test.mjs: the gate that says the helper's Jupiter budget is idle (scripts/ci/jup-idle.mjs,
// card helper-live-jup-serial) reads it off the helper's own answer to a cold page, polls on the helper's wait, never sleeps a
// fixed time, and says so when the budget never goes idle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as gate from "./jup-idle.mjs";
import { IDLE_MAX_MS, POLL_MS, RETRY_MAX_S, judge, readMs, retryMs, waitIdle } from "./jup-idle.mjs";

const BASE = "https://helper.example";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const POOL = Array.from({ length: 40 }, (_, i) => ({ id: B58[i].repeat(44) }));
const LISTS = { lists: { new: [{ token: POOL[0].id }], trending: [] } };

/** A fake helper and Jupiter: pages answer from `script`, one answer per page read, the last one repeating. */
function world(script) {
  const seen = { pages: [], sleeps: [] };
  let clock = 0;
  let n = 0;
  const fetchFn = async (url) => {
    const u = String(url);
    const json = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
    if (u.includes("/v1/market/lists")) return json(200, LISTS);
    if (u.startsWith("https://lite-api.jup.ag/")) return json(200, POOL);
    if (u.includes("/v1/market/token")) {
      seen.pages.push(u);
      const step = typeof script === "function" ? script(n++, clock) : script[Math.min(n++, script.length - 1)];
      const now = Date.now();
      return json(step.status ?? 200, step.body === undefined ? { risk: { holders: { src: step.src ?? "jupiter", as_of_ms: now } } } : step.body, { ...(step.timing ? { "server-timing": step.timing } : {}), ...(step.retryAfter ? { "retry-after": step.retryAfter } : {}) });
    }
    throw new Error(`unexpected ${u}`);
  };
  const sleep = async (ms) => {
    seen.sleeps.push(ms);
    clock += ms;
  };
  return { fetchFn, sleep, now: () => clock, seen };
}
const GOOD = { timing: "lists;dur=1, read;dur=45, total;dur=46" };

test("a cold page with its Jupiter row inside a second is idle on the first probe, and only the probe's own search is waited out", async () => {
  const w = world([GOOD]);
  const r = await waitIdle({ base: BASE, ...w, rand: () => 0.5 });
  assert.equal(r.idle, true);
  assert.equal(r.probes, 1);
  assert.deepEqual(w.seen.sleeps, [gate.DRAIN_MS]);
});

test("card helper-live-red: an idle probe's own search leaves the helper's Jupiter window before the check runs, so the check's first page has the room the probe read", async () => {
  // live run 42662889061, 17:20:26.89Z: the gate's probe was the window's 6th send of the own reads' 6 (proxy.ts
  // BUILD_ROOM leaves 4 of Free's 10 to builds); the check's page 0.3 s later waited 702 ms for a turn, past
  // JUP_PAGE_WAIT_MS 500, and was named on chain (X-Helper-Source "chain")
  const proxy = readFileSync(new URL("../../apps/helper/src/proxy/proxy.ts", import.meta.url), "utf8");
  const burst = /export const BURST_MS = ([\d_]+);/.exec(proxy)?.[1];
  assert.ok(burst !== undefined, "proxy.ts names BURST_MS");
  assert.equal(gate.DRAIN_MS, Number(burst.replaceAll("_", "")), "the drain is the helper's window, BURST_MS");
  // a fake helper whose own reads take 6 of a 10 s window: the page lands at once only with room left
  const sends = [];
  const w = world((n, clock) => {
    const room = sends.filter((t) => t > clock - 10_000).length < 6;
    sends.push(clock);
    return room ? GOOD : { src: "chain", timing: 'lists;dur=1, jup;desc="late";dur=500, read;dur=600' };
  });
  for (let k = 0; k < 4; k++) sends.push(-1_000 - k); // a member before it spent 4, then the gate
  const r = await waitIdle({ base: BASE, ...w, rand: () => 0.5 });
  assert.equal(r.idle, true);
  sends.push(w.now() - 1); // a background read meanwhile
  const free = sends.filter((t) => t > w.now() - 10_000).length < 6;
  assert.ok(free, "the check's page found the window as full as the gate left it");
});

test("each way the budget shows busy is read off the answer, and the next probe goes when the helper says", async () => {
  const w = world([
    { src: "chain", timing: "lists;dur=1, read;dur=40" }, // fell back to chain: the search never landed
    { timing: 'lists;dur=1, jup;desc="late";dur=900, read;dur=950' }, // the page's wait ran out
    { timing: "lists;dur=1, search-room;desc=\"jupiter turn\", read;dur=10" },
    { status: 503, timing: 'cause;desc="budget"', retryAfter: "7" }, // names its wait: 7 s
    { timing: "lists;dur=1, read;dur=1500" }, // the search landed, a page took 1.5 s
    GOOD,
  ]);
  const r = await waitIdle({ base: BASE, ...w, rand: () => 0.5 });
  assert.equal(r.idle, true);
  assert.equal(r.probes, 6);
  assert.deepEqual(w.seen.sleeps, [POLL_MS, POLL_MS, POLL_MS, 7000, POLL_MS, gate.DRAIN_MS], "the helper's own 7 s where it names one, else the poll; then the idle probe's drain");
  assert.equal(new Set(w.seen.pages).size, 6, "each probe asks another token");
});

test("a budget that never goes idle ends in a not-idle answer with the last reason, inside IDLE_MAX_MS", async () => {
  const w = world([{ src: "chain", timing: "lists;dur=1, read;dur=40" }]);
  const r = await waitIdle({ base: BASE, ...w, rand: () => 0.5 });
  assert.equal(r.idle, false);
  assert.match(r.why, /src chain/);
  assert.ok(r.waitedMs <= IDLE_MAX_MS, `${r.waitedMs}`);
  assert.ok(r.waitedMs > IDLE_MAX_MS - POLL_MS, "it waited out the whole time before it said so");
  assert.ok(w.seen.sleeps.every((ms) => ms === POLL_MS));
});

test("judge: the page's own words, one case each", () => {
  const sent = Date.now();
  const ok = { status: 200, sentAt: sent, jupAt: sent + 5, src: "jupiter", timing: "read;dur=999" };
  assert.equal(judge(ok).idle, true);
  assert.equal(judge({ ...ok, timing: "read;dur=1001" }).idle, false);
  assert.equal(judge({ ...ok, timing: "total;dur=5" }).idle, false, "no read;dur");
  assert.equal(judge({ ...ok, status: 503 }).idle, false);
  assert.equal(judge({ ...ok, src: "chain" }).idle, false);
  assert.equal(judge({ ...ok, jupAt: sent - 5_000 }).idle, false, "a row read before the request is the helper's held one, not a search for it");
  assert.equal(judge({ ...ok, jupAt: sent - 500 }).idle, true, "within the clocks' skew");
  for (const named of ["search-gap", "search-held", "search-429", "search-upstream", 'jup;desc="late"']) assert.equal(judge({ ...ok, timing: `read;dur=5, ${named}` }).idle, false, named);
});

test("hostile input: a Retry-After or a read;dur that is not whole digits is no wait and no time", () => {
  assert.equal(retryMs("7"), 7000);
  assert.equal(retryMs("0"), null);
  assert.equal(retryMs("999"), RETRY_MAX_S * 1000);
  for (const bad of ["-1", "1e3", "7s", "", null, undefined, "1.5", "Wed, 21 Oct 2026 07:28:00 GMT"]) assert.equal(retryMs(bad), null, String(bad));
  assert.equal(readMs("read;dur=45"), 45);
  assert.equal(readMs("a;dur=1, read;dur=45, total;dur=46"), 45);
  for (const bad of ["read;dur=-1", "read;dur=1e3", "xread;dur=4", "read;dur=", "", null]) assert.equal(readMs(bad), null, String(bad));
});

test("a helper whose lists or Jupiter's list do not answer is an error, never an idle", async () => {
  const w = world([GOOD]);
  const noLists = async (u, ...a) => (String(u).includes("/v1/market/lists") ? { status: 503, headers: { get: () => null }, text: async () => "{}" } : w.fetchFn(u, ...a));
  await assert.rejects(waitIdle({ base: BASE, ...w, fetchFn: noLists }), /lists\?chain=solana answered 503/);
  const noPool = async (u, ...a) => (String(u).startsWith("https://lite-api.jup.ag/") ? { status: 500, headers: { get: () => null }, text: async () => "[]" } : w.fetchFn(u, ...a));
  await assert.rejects(waitIdle({ base: BASE, ...w, fetchFn: noPool }), /verified list answered 500/);
});
