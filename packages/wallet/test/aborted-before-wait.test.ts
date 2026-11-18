// Card aborted-signal-waits-end-at-once: the wallet's waits on a signal end at once when the signal ended before the
// wait began. An aborted signal never fires its event again, so a wait that only listens for it runs its whole time.
// Each wait here starts on an ended signal and must settle within a few turns of the event loop (settledSoon races it
// against setImmediate turns, never the clock), and each test has its own short bound.
//   node --test test/aborted-before-wait.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as d from "../src/derive/index.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { slices } from "../src/notes/restore.ts";
import { WALK_LANE_MAX_MS, walkLanes, type WalkPort } from "../src/restore/walk.ts";

const B = { timeout: 20_000 };
/** "settled" when `p` settles within 20 turns of the event loop, "pending" when only a timer could end it. */
async function settledSoon(p: Promise<unknown>): Promise<"settled" | "pending"> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let k = 0; k < 20 && !done; k++) await new Promise<void>((r) => setImmediate(r));
  return done ? "settled" : "pending";
}

test("restore/walk.ts: a lane whose Worker fails as it is heard ends with no lane timer left (120 s each, on a lane already ended)", B, async () => {
  // the lane's bound is the real timer (walk.ts `after`); every one made at WALK_LANE_MAX_MS is tracked, and any still
  // set once the walk is done is a lane bound that outlived its lane
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const live = new Set<unknown>();
  globalThis.setTimeout = ((f: () => void, ms?: number, ...a: unknown[]) => {
    const t = real.set(() => (live.delete(t), f()), ms, ...a);
    if (ms === WALK_LANE_MAX_MS) live.add(t);
    return t;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => (live.delete(t), real.clear(t))) as typeof clearTimeout;
  try {
    // a Worker that fails the moment its error is listened for: its lane has ended before the bound is set
    const failing = (): WalkPort => ({ postMessage: () => {}, addEventListener: (t, f) => void (t === "error" && f({})), terminate: () => {} });
    const M = d.masters(d.wordsToSeed64(d.entropyToWords(new Uint8Array(16))), "deposit"); // the published all-zero vector (a8.json)
    const walks = await walkLanes({ m: M, scope: 777n, match: { kind: "pre", precommitments: [] }, gap: 2, slice: slices(), spawn: failing, cores: 2 });
    assert.equal(walks.length, 8, "each lane walked on the page");
    assert.equal(live.size, 0, `${live.size} lane bound(s) of ${WALK_LANE_MAX_MS} ms still set after their lanes ended`);
  } finally {
    for (const t of live) real.clear(t as Parameters<typeof clearTimeout>[0]);
    globalThis.setTimeout = real.set;
    globalThis.clearTimeout = real.clear;
  }
});

test("pace.ts: a shared turn whose caller stops while it holds the URL's lock ends at once, never after the slot's wait", B, async () => {
  type Pace = typeof import("../src/pace.ts");
  const P = (await import(new URL("../src/pace.ts?aborted-before-wait", import.meta.url).href)) as Pace;
  const FAST = NEAR_NETWORKS.mainnet.fastnear[0];
  const stored = new Map<string, string>();
  let stopInLock: AbortController | null = null;
  P.sharePaces({
    // the lock is granted at once; the caller's stop lands while its callback runs (a sign out mid-turn)
    locks: { request: async (_n, _o, fn) => { const v = await fn(null); stopInLock?.abort(new Error("signed out")); return v; } },
    storage: { get: (k) => stored.get(k) ?? null, set: (k, v) => void stored.set(k, v) },
    origin: performance.timeOrigin,
  });
  try {
    const f = P.pacedFetch(FAST, (async () => new Response("{}")) as unknown as typeof fetch);
    // FastNEAR's burst of 8 is spent at once; the 9th turn has a slot's wait (about 2.6 s) ahead of it
    for (let k = 0; k < P.PACE.fastnear.burst; k++) await f(FAST, { signal: new AbortController().signal });
    stopInLock = new AbortController();
    const ninth = f(FAST, { signal: stopInLock.signal });
    assert.equal(await settledSoon(ninth), "settled", "the turn waited out its slot on a signal that had ended");
    await assert.rejects(ninth, /signed out/);
  } finally {
    P.sharePaces(null);
  }
});
