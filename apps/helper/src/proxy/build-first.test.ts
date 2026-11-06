// Card jupiter-build-budget-503: a buy always gets its route built. Jupiter Free's 10 sends in any 10 s (proxy.ts
// PACED) are every build's and every page's, search's and fill's, so the helper's own reads leave BUILD_ROOM of the
// window to the devices' builds, and a build waiting goes before every own read (proxy.ts laneOf). Live run 42178532918
// attempt 1 (job 127762604763): solana-jupiter-build's S-1 build answered 503 cause "budget", its turn 5 s off, the
// window spent by the suite's token pages; job 127708963663: drawn, then 2643 ms in the queue and refused.
// Self-contained (its own clock and Jupiter), so the same file runs on the code before the card: the red run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxy, QUEUE_WAIT_MS } from "./proxy.ts";

const ENV = { JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16), RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16), LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16), ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16) };
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const causeIn = (a: { timing?: string[] }): string | undefined => a.timing?.find((e) => e.startsWith("cause;"))?.match(/desc="([^"]+)"/)?.[1];

/** Virtual time (as proxy.test.ts): sleep parks until the clock reaches it; run() moves the clock to the next timer
 *  whenever every task is parked. */
function virtualTime(t0 = 1_800_000_000_000) {
  let t = t0;
  const timers: { at: number; go: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((go) => void timers.push({ at: t + Math.max(ms, 0), go }));
  const idle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  async function run<T>(done: Promise<T>): Promise<T> {
    let settled = false;
    done.then(() => (settled = true), () => (settled = true));
    for (;;) {
      await idle();
      if (settled) return done;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error("stuck: no timer and not done");
      t = Math.max(t, next.at);
      next.go();
    }
  }
  return { now: () => t, sleep, run };
}
/** A fake Jupiter with its limiter: at most `cap` calls in any `ms`, a 429 past it; each call's time, path and query. */
function windowJupiter(c: { now: () => number }, cap = 10, ms = 10_000) {
  const sent: { at: number; path: string; q: string }[] = [];
  let refused = 0;
  const fetch = async (url: string) => {
    const u = new URL(url);
    const inside = sent.filter((x) => x.at > c.now() - ms);
    if (inside.length >= cap) return (refused++, json({ e: "slow" }, 429, { "x-ratelimit-reset": String(Math.ceil((inside[0]!.at + ms) / 1000)) }));
    sent.push({ at: c.now(), path: u.pathname, q: u.search });
    return json([]);
  };
  return { fetch, sent, refused: () => refused };
}
type P = ReturnType<typeof createProxy>;
/** A cold page's search (a caller waits for it), token.ts's call. */
const page = (p: P, q: string) => p.handle("jupiter", "/tokens/v2/search", `query=${q}`, "", undefined, true, 10_000, true);
/** A held page's refresh, the app's 5 s fill reads (token.ts: a background read). */
const fill = (p: P, q: string) => p.handle("jupiter", "/tokens/v2/search", `query=${q}`, "", undefined, true, 10_000, false);
/** Discover's lists (lists.ts). */
const list = (p: P, path: string) => p.handle("jupiter", path, "limit=100", "", undefined, true);
/** A device's build, the kit's POST with the device route's own wait (QUEUE_WAIT_MS). */
const build = (p: P, q: string, client: string) => p.handle("jupiter", "/swap/v2/build", q, "", client);
const LISTS = ["/tokens/v2/recent", "/tokens/v2/toptrending/5m", "/tokens/v2/toptrending/1h"];

test("card jupiter-build-budget-503: pages, searches, fills and lists asked at once fill what they may of Jupiter's window; a build that arrives after them is served at once, ahead of every read still queued", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const t0 = c.now();
  const reads = [...Array.from({ length: 8 }, (_, i) => page(p, `page${i}`)), ...Array.from({ length: 4 }, (_, i) => fill(p, `fill${i}`)), ...LISTS.map((l) => list(p, l))];
  let asked = 0;
  const buy = c.sleep(500).then(() => ((asked = c.now()), build(p, "buy=S-1", "198.51.100.7")));
  const [b, ...rest] = await c.run(Promise.all([buy, ...reads]));
  assert.equal(j.refused(), 0, "Jupiter never answered 429");
  assert.equal(b!.status, 200, `the build: ${b!.status} ${causeIn(b!) ?? ""} ${b!.timing?.join(", ") ?? ""} Retry-After ${b!.headers["Retry-After"] ?? "-"}`);
  const sentAt = j.sent.find((s) => s.q === "?buy=S-1")!.at;
  assert.equal(sentAt - asked, 0, "the build goes at once: the reads left it its room");
  assert.ok(sentAt - asked <= QUEUE_WAIT_MS);
  // every read is answered: at once, as the window frees, or past its own wait not ready with its cause and the seconds
  // until its turn (token.ts keeps the mint for the next search; the page is named on chain meanwhile)
  assert.ok(rest.every((a) => a.status === 200 || (a.status === 503 && causeIn(a) === "budget" && Number(a.headers["Retry-After"]) >= 1)), rest.map((a) => `${a.status} ${causeIn(a) ?? ""}`).join(" | "));
  assert.ok(rest.filter((a) => a.status === 200).length >= 10, "a window's own reads and the next window's");
  assert.ok(j.sent.filter((s) => s.at === t0).length <= 10 - 4, "the reads sent at once leave the builds' room (BUILD_ROOM 4)");
  void t0;
});

test("card jupiter-build-budget-503: with Jupiter's window full, a build and a page waiting for it: the build goes first as it frees, whichever asked first", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const t0 = c.now();
  // the window filled by builds of five devices (two each) and the pages' searches
  const crowd = [...Array.from({ length: 10 }, (_, i) => build(p, `crowd=${i}`, `198.51.100.${10 + (i % 5)}`)), ...Array.from({ length: 6 }, (_, i) => page(p, `crowd${i}`))];
  const late = c.sleep(100).then(() => page(p, "waits"));
  const buy = c.sleep(200).then(() => p.handle("jupiter", "/swap/v2/build", "buy=late", "", "198.51.100.9", false, 15_000));
  const answers = await c.run(Promise.all([...crowd, late, buy]));
  assert.equal(j.refused(), 0);
  assert.equal(answers.at(-1)!.status, 200, `the late build: ${answers.at(-1)!.status} ${causeIn(answers.at(-1)!) ?? ""}`);
  const order = j.sent.filter((s) => s.q === "?buy=late" || s.q === "?query=waits").map((s) => s.q);
  assert.deepEqual(order.slice(0, 1), ["?buy=late"], `the build first: ${order.join(", ")}`);
  void t0;
});

test("card jupiter-build-budget-503: the live suite's crowd (one device's nine legs, helper-page-jup-429's build, two cold pages, fills, the lists): a new device's S-1 build 1.2 s after them is served at once, ahead of the legs still queued", async () => {
  const c = virtualTime();
  const j = windowJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const legs = Array.from({ length: 9 }, (_, i) => p.handle("jupiter", "/swap/v2/build", `leg=${i}`, "", "198.51.100.1", false, 30_000));
  const others = [build(p, "page=1", "198.51.100.2")];
  const reads = [page(p, "pairA"), page(p, "pairB"), fill(p, "fillA"), fill(p, "fillB"), ...LISTS.map((l) => list(p, l))];
  let asked = 0;
  const s1 = c.sleep(1_200).then(() => ((asked = c.now()), build(p, "buy=S-1", "198.51.100.4")));
  const answers = await c.run(Promise.all([s1, ...legs, ...others, ...reads]));
  assert.equal(j.refused(), 0, "Jupiter never answered 429");
  const a = answers[0]!;
  assert.equal(a.status, 200, `S-1: ${a.status} ${causeIn(a) ?? ""} ${a.timing?.join(", ") ?? ""}`);
  const at = j.sent.find((s) => s.q === "?buy=S-1")!.at;
  assert.ok(at - asked <= QUEUE_WAIT_MS, `S-1 waited ${at - asked} ms`);
  for (const b of answers.slice(1, 11)) assert.equal(b.status, 200, `a build: ${b.status} ${causeIn(b) ?? ""}`);
  const legsAfter = j.sent.filter((s) => s.q.startsWith("?leg=") && s.at > at).length;
  assert.ok(legsAfter >= 1, "the legs past their device's room go after the new device's first build");
});
