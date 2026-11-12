// The restore's walk Workers (src/walk-workers.ts), card restore-shows-the-balance-in-seconds.
//   node --test test/walk-workers.test.ts      (from packages/signpage)
// The Worker starts from this origin's /walk-worker.js as a module named "walk", through the Trusted Types policy
// walk-worker, created once, which refuses every other URL (another origin, another path, a query, blob: and data:);
// with no Trusted Types the plain URL; with no Worker it throws. The page's globals are fakes, set on globalThis in
// the order the tests run (the policy is created once per page, as SIGN_HOST's CSP names it once).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WALK_POLICY_NAME, WALK_WORKER_PATH, walkWorkerPort, walkWorkerScriptURL } from "../src/walk-workers.ts";

const ORIGIN = "https://confidential.unrealized.trade";
const g = globalThis as unknown as Record<string, unknown>;
const had = { location: Object.getOwnPropertyDescriptor(globalThis, "location"), Worker: g.Worker, trustedTypes: g.trustedTypes };
Object.defineProperty(globalThis, "location", { value: { origin: ORIGIN }, configurable: true, writable: true });

class TrustedScriptURL {
  readonly href: string;
  constructor(href: string) {
    this.href = href;
  }
}
type Started = { url: unknown; opts: unknown };
const started: Started[] = [];
class FakeWorker {
  constructor(url: unknown, opts: unknown) {
    started.push({ url, opts });
  }
  postMessage(): void {}
  addEventListener(): void {}
  terminate(): void {}
}

test("with no Worker in the browser, walkWorkerPort throws and starts nothing", () => {
  delete g.Worker;
  assert.throws(() => walkWorkerPort(), /walk worker: this browser has no Worker/);
});

test("with no Trusted Types, the Worker starts from this origin's /walk-worker.js as a module named walk", () => {
  delete g.trustedTypes;
  g.Worker = FakeWorker;
  assert.equal(walkWorkerScriptURL(), `${ORIGIN}/walk-worker.js`);
  walkWorkerPort();
  assert.deepEqual(started.at(-1), { url: `${ORIGIN}${WALK_WORKER_PATH}`, opts: { type: "module", name: "walk" } });
});

test("under Trusted Types: one walk-worker policy makes the Worker's TrustedScriptURL and refuses every other URL", () => {
  const made: { name: string; rules: { createScriptURL(s: string): string } }[] = [];
  g.trustedTypes = {
    createPolicy(name: string, rules: { createScriptURL(s: string): string }) {
      made.push({ name, rules });
      return { createScriptURL: (s: string) => new TrustedScriptURL(rules.createScriptURL(s)) };
    },
  };
  g.Worker = FakeWorker;
  walkWorkerPort();
  walkWorkerPort();
  assert.equal(made.length, 1, "the policy is created once per page");
  assert.equal(made[0]!.name, WALK_POLICY_NAME);
  assert.equal(WALK_POLICY_NAME, "walk-worker");
  for (const s of started.slice(-2)) {
    assert.ok(s.url instanceof TrustedScriptURL, "the Worker gets a TrustedScriptURL, never a string");
    assert.equal((s.url as TrustedScriptURL).href, `${ORIGIN}/walk-worker.js`);
    assert.deepEqual(s.opts, { type: "module", name: "walk" });
  }
  const { rules } = made[0]!;
  assert.equal(rules.createScriptURL("/walk-worker.js"), `${ORIGIN}/walk-worker.js`);
  for (const bad of [
    "https://evil.example/walk-worker.js",
    "/prover-worker.js",
    "/app.js",
    "/walk-worker.js?x=1",
    "/walk-worker.js#x",
    "/assets/walk-worker.js",
    "blob:https://confidential.unrealized.trade/0b6c3d1e-3f5a-4d7e-9a43-1c2b3d4e5f60",
    "data:text/javascript,postMessage(1)",
    "http://confidential.unrealized.trade/walk-worker.js",
  ]) {
    assert.throws(() => rules.createScriptURL(bad), /^TypeError: walk-worker refuses /, bad);
  }
});

test.after(() => {
  if (had.location) Object.defineProperty(globalThis, "location", had.location);
  else delete g.location;
  if (had.Worker === undefined) delete g.Worker;
  else g.Worker = had.Worker;
  if (had.trustedTypes === undefined) delete g.trustedTypes;
  else g.trustedTypes = had.trustedTypes;
});
