// Card solana-buy-from-cash-quotes: a device's build is never refused by our own Jupiter budget while Jupiter has room.
// Helper live run 43710945844 (15 Nov 11:57-12:03Z, helper 4a1746fcc): solana-jupiter-build's candidate scan (one
// runner, about three builds every 8 s) beside the helper's own background reads (one every 4 s: "jupiter turn:
// background ... 3 of 10 sent in 10 s", vendor remaining 5 to 7) had its S-1 and S-2 builds answered 503 cause "budget",
// refusal "ours", Retry-After 18 to 34 s, with Jupiter's 60 a minute (developers.jup.ag/docs/api-rate-limit, Free:
// "1 | 60", 60-second sliding window) never reached: the minute kept 34 for own reads that drew 15, and a lone heavy
// device was held to 26 less 12 kept for others. Trades come first: the own reads keep a floor (a page a caller waits
// for), background own reads go only while they leave the callers their room, and callers take what is idle.
// Self-contained (its own clock and Jupiter), so the same file runs on the code before the card: the red run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxy } from "./proxy.ts";

const ENV = { JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16), RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16), LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16), ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16) };
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const causeIn = (a: { timing?: string[] }): string | undefined => a.timing?.find((e) => e.startsWith("cause;"))?.match(/desc="([^"]+)"/)?.[1];

/** Virtual time (as build-first.test.ts). */
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
/** A fake Jupiter Free key: at most 10 calls in any 10 s and 60 in any 60 s, a 429 past either. */
function freeJupiter(c: { now: () => number }) {
  const sent: { at: number; q: string }[] = [];
  let refused = 0;
  const fetch = async (url: string) => {
    const u = new URL(url);
    if (sent.filter((x) => x.at > c.now() - 10_000).length >= 10 || sent.filter((x) => x.at > c.now() - 60_000).length >= 60) return (refused++, json({ e: "slow" }, 429));
    sent.push({ at: c.now(), q: u.search });
    return json([]);
  };
  return { fetch, sent, refused: () => refused };
}
type P = ReturnType<typeof createProxy>;
/** A held page's refresh and Discover's lists (token.ts, lists.ts): the helper's own reads nobody waits for. */
const background = (p: P, q: string) => p.handle("jupiter", "/tokens/v2/search", `query=${q}`, "", undefined, true, 10_000, false);
/** A cold page's search a caller waits for (token.ts). */
const page = (p: P, q: string) => p.handle("jupiter", "/tokens/v2/search", `query=${q}`, "", undefined, true, 10_000, true);
/** A device's build at the device route's wait. */
const build = (p: P, q: string, client: string) => p.handle("jupiter", "/swap/v2/build", q, "", client);

test("card solana-buy-from-cash-quotes: the live run's load (own background reads every 4 s, the check's one build every 8 s, seven devices each trading 4 builds a minute, for 3 minutes): no build is refused by our minute budget while Jupiter has room", async () => {
  const c = virtualTime();
  const j = freeJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const at = <T>(ms: number, f: () => Promise<T>) => c.sleep(ms).then(f);
  const own: Promise<unknown>[] = [];
  for (let s = 0; s < 180_000; s += 4_000) own.push(at(s, () => background(p, `own${s}`)));
  const builds: Promise<{ status: number; timing?: string[]; headers: Record<string, string> }>[] = [];
  // the check (scripts/live-checks/solana-jupiter-build.mjs PACE_MS 8 s), as the helper's log showed it 11:59:48-12:02:21Z
  for (let s = 0; s < 180_000; s += 8_000) builds.push(at(s + 100, () => build(p, `check=${s}`, "198.51.100.7")));
  // seven devices, each a one-leg trade once a minute at its own second: its cap search's three builds and its floor
  // rebuild, one after another as the kit asks them (packages/kit/src/trade/solana/build.ts, flow.ts prepareLeg)
  const trades: Promise<{ status: number; timing?: string[]; headers: Record<string, string> }[]>[] = [];
  for (let s = 0; s < 180_000; s += 60_000)
    for (let d = 0; d < 7; d++)
      trades.push(at(s + 2_000 + d * 8_000, async () => {
        const out = [];
        for (let k = 0; k < 4; k++) out.push(await build(p, `trade=${s}-${d}-${k}`, `198.51.100.${30 + d}`), await c.sleep(150));
        return out.filter((x) => x !== undefined);
      }));
  const [checked, traded] = await c.run(Promise.all([Promise.all(builds), Promise.all(trades)]));
  const answers = [...checked, ...traded.flat()];
  await c.run(Promise.all(own));
  assert.equal(j.refused(), 0, "Jupiter never answered 429: its 60 a minute and 10 a 10 s held");
  // the minute's budget (limits.ts "jupiter total" / "jupiter share") refuses none; a send the 10 s window has no turn
  // for yet ("jupiter turn") is told its Retry-After, which the kit waits out (build.ts SolanaBuildWait)
  const refused = answers.filter((a) => a.status !== 200 && (a as { why?: string }).why !== "jupiter turn");
  assert.equal(refused.length, 0, `builds refused by the minute's budget: ${refused.length} of ${answers.length}, e.g. ${refused.slice(0, 2).map((a) => `${a.status} ${(a as { why?: string }).why ?? ""} Retry-After ${a.headers["Retry-After"] ?? "-"}`).join(" | ")}`);
  const turns = answers.filter((a) => a.status !== 200).length;
  assert.ok(answers.filter((a) => a.status !== 200).every((a) => Number(a.headers["Retry-After"]) >= 1), "a turn not yet free names its wait");
  console.log(`  [trades-first] ${answers.length - turns} of ${answers.length} builds at once, ${turns} told a turn's wait`);
});

test("card solana-buy-from-cash-quotes: devices drawing most of Jupiter's minute: a new device's build is served at once, the background own reads yield to them, and a page a caller waits for still has its floor", async () => {
  const c = virtualTime();
  const j = freeJupiter(c);
  const p = createProxy(ENV, { fetch: j.fetch, now: c.now, sleep: c.sleep, log: () => {} });
  const at = <T>(ms: number, f: () => Promise<T>) => c.sleep(ms).then(f);
  // the background own reads ask every 2 s (30 a minute, the lists and fills at their busiest) for two minutes
  const own: Promise<{ status: number }>[] = [];
  for (let s = 0; s < 120_000; s += 2_000) own.push(at(s, () => background(p, `own${s}`)));
  // eight devices, one build each every 10 s (48 a minute), each inside its share
  const crowd: Promise<{ status: number }>[] = [];
  for (let s = 0; s < 120_000; s += 10_000) for (let d = 0; d < 8; d++) crowd.push(at(s + 50 + d * 100, () => build(p, `crowd=${s}-${d}`, `198.51.100.${20 + d}`)));
  const late = at(90_500, () => build(p, "buy=new", "198.51.100.99"));
  const cold = at(91_000, () => page(p, "cold"));
  const [n, pg, crowded, owned] = await c.run(Promise.all([late, cold, Promise.all(crowd), Promise.all(own)]));
  assert.equal(j.refused(), 0, "Jupiter never answered 429");
  assert.equal(n.status, 200, `the new device's build: ${n.status} ${causeIn(n) ?? ""}`);
  assert.equal(pg.status, 200, `the cold page: ${pg.status} ${causeIn(pg) ?? ""}`);
  const served = crowded.filter((a) => a.status === 200).length;
  assert.ok(served >= crowded.length - 2, `the devices' builds: ${served} of ${crowded.length} served`);
  const ownServed = owned.filter((a) => a.status === 200).length;
  assert.ok(ownServed < owned.length, "the background own reads were shed for the devices, not the devices for them");
});
