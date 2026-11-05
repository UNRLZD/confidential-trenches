// The tests' only way to mock and reset timers (card evm-quote-l5b-flake). node:test's mock.timers.reset() drops every
// timer still set but leaves each its place in the mocked clock's queue; work that outlives a test and clears one of
// them later, while timers are mocked again, takes out whatever live timer holds that place then, and that wait never
// ends. enableTimers keeps track of every timer set while mocked; resetTimers clears each one still set first, so no
// handle leaves with a place. test/mock-timers.test.mjs refuses a direct timers.enable( or timers.reset( in any test.
// The same file sits in each package whose tests mock timers (packages/kit, packages/signpage, apps/helper), byte for
// byte: no package imports another's tests.
import type { MockTimers } from "node:test";

type Clear = (h: unknown) => void;
type Kept = { live: Map<unknown, Clear>; mocked: [string, unknown][] };
const KEPT = new WeakMap<MockTimers, Kept>();
// each mockable timer and its clear: a timeout or an immediate is no longer set once it fires, an interval stays set
const PAIRS = [
  ["setTimeout", "clearTimeout", true],
  ["setInterval", "clearInterval", false],
  ["setImmediate", "clearImmediate", true],
] as const;

/** `timers.enable(options)`, with every timer set while they are mocked kept track of for resetTimers. */
export function enableTimers(timers: MockTimers, options?: Parameters<MockTimers["enable"]>[0]): void {
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>;
  const before = PAIRS.map(([set]) => g[set]);
  timers.enable(options);
  const kept: Kept = { live: new Map(), mocked: [] };
  PAIRS.forEach(([setName, clearName, once], k) => {
    const set = g[setName]!;
    const clear = g[clearName]! as Clear;
    if (set === before[k]) return; // not mocked
    kept.mocked.push([setName, set], [clearName, clear]);
    g[setName] = (f: unknown, ...a: unknown[]) => {
      const run = typeof f === "function" ? (...b: unknown[]) => (once && kept.live.delete(h), (f as (...b: unknown[]) => unknown)(...b)) : f;
      const h = set(run, ...a);
      kept.live.set(h, clear);
      return h;
    };
    g[clearName] = (h: unknown) => {
      kept.live.delete(h);
      clear(h);
    };
  });
  KEPT.set(timers, kept);
}

/** Every timer still set since enableTimers cleared, then `timers.reset()`. */
export function resetTimers(timers: MockTimers): void {
  const kept = KEPT.get(timers);
  if (kept !== undefined) {
    KEPT.delete(timers);
    for (const [h, clear] of kept.live) clear(h);
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [name, f] of kept.mocked) g[name] = f;
  }
  timers.reset();
}
