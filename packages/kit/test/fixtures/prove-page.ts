// The Chromium page of prove-e2e.test.ts, bundled into one classic page.js (SIGN_HOST's Integrity-Policy needs the
// page's one script to carry its integrity). It asks the kit's one call, vaultProveWithdraw, for a proof from the
// fixture's leaves, in the real prover worker (client.ts startProver), and reports what it got, what the page posted to
// the worker, and each CSP or Trusted Types violation on the page or in the worker.
import { startProver } from "../../src/prover/client.ts";
import { vaultProveWithdraw, type VaultProver } from "../../src/prover/prove.ts";
import { fixtureArgs, type ContextVector, type FixtureTamper } from "./prove-fixture.ts";

type Violation = { where: string; directive: string; blocked: string; sample: string };
const violations: Violation[] = [];
document.addEventListener("securitypolicyviolation", (e) =>
  violations.push({ where: "page", directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }),
);

// every command the page posts to a worker, in order
const posts: unknown[] = [];
const post = Worker.prototype.postMessage as (this: Worker, m: unknown, t?: Transferable[]) => void;
Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: Transferable[] | StructuredSerializeOptions) {
  post.call(this, m, Array.isArray(t) ? t : []);
  posts.push((m as { cmd?: unknown }).cmd);
} as typeof Worker.prototype.postMessage;

/** How a run is planted: in the leaves (fixture), or in the worker's answer (its last public signal changed). */
type Plant = FixtureTamper | "answer-signal";

/** `times` calls on one worker: the first loads the setup files, the rest reuse them. */
async function run(cv: ContextVector, plant: Plant, times = 1) {
  posts.length = 0;
  violations.length = 0;
  const worker = startProver({ onViolation: (v) => violations.push({ where: "worker", ...v }) });
  const prover: VaultProver =
    plant === "answer-signal"
      ? {
          load: (c) => worker.load(c),
          prove: async (c, i) => {
            const r = await worker.prove(c, i);
            r.publicSignals[7] = String(BigInt(r.publicSignals[7]!) + 1n);
            return r;
          },
        }
      : worker;
  const calls: Record<string, unknown>[] = [];
  for (let k = 0; k < times; k++) {
    const call: Record<string, unknown> = {};
    const args = fixtureArgs(cv, plant === "answer-signal" ? "none" : plant);
    const t0 = performance.now();
    try {
      call.result = await vaultProveWithdraw(prover, args);
      call.wallMs = Math.round(performance.now() - t0);
    } catch (e) {
      call.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    calls.push(call);
  }
  worker.terminate();
  return { calls, posts, violations };
}

(window as unknown as { __kitProve: unknown }).__kitProve = { run };
