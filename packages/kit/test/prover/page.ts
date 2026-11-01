// The test page of chromium.e2e.mjs, bundled into one classic page.js (SIGN_HOST's Integrity-Policy needs the page's
// one script to carry its integrity). It runs the kit's prover client as SIGN_HOST will and reports what happened:
// Trusted Types refusals, every postMessage to the worker (what it moved by transfer, and whether the page's copy was
// left detached), each CSP violation on the page or in the worker, the load and the proof.
import { PROVER_POLICY_NAME, PROVER_WORKER_PATH, proverWorkerScriptURL, startProver, type ProverInput } from "../../src/prover/client.ts";

type Violation = { where: string; directive: string; blocked: string; sample: string };
const violations: Violation[] = [];
document.addEventListener("securitypolicyviolation", (e) =>
  violations.push({ where: "page", directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }),
);

// every message the page posts to a worker: its command, how many buffers it moved and their size after the post
const posts: { cmd: unknown; transferred: number; bytesLeftHere: number[] }[] = [];
const post = Worker.prototype.postMessage as (this: Worker, m: unknown, t?: Transferable[]) => void;
Worker.prototype.postMessage = function (this: Worker, m: unknown, t?: Transferable[] | StructuredSerializeOptions) {
  const transfer = Array.isArray(t) ? t : [];
  post.call(this, m, transfer);
  posts.push({
    cmd: (m as { cmd?: unknown }).cmd,
    transferred: transfer.length,
    bytesLeftHere: transfer.map((b) => (b as ArrayBuffer).byteLength),
  });
} as typeof Worker.prototype.postMessage;

const err = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const attempt = (f: () => unknown) => {
  try {
    f();
    return "allowed";
  } catch (e) {
    return err(e);
  }
};

async function run(input: ProverInput) {
  const tt = (window as unknown as { trustedTypes?: { createPolicy(n: string, r: object): unknown; isScriptURL(v: unknown): boolean } }).trustedTypes;
  const out: Record<string, unknown> = { violations, posts };
  out.plainStringWorker = attempt(() => new Worker(PROVER_WORKER_PATH));
  const url = proverWorkerScriptURL();
  out.workerURLIsTrusted = !!tt && tt.isScriptURL(url);
  out.secondPolicySameName = attempt(() => tt?.createPolicy(PROVER_POLICY_NAME, { createScriptURL: (s: string) => s }));
  out.otherPolicy = attempt(() => tt?.createPolicy("other", { createScriptURL: (s: string) => s }));

  const prover = startProver({ onViolation: (v) => violations.push({ where: "worker", ...v }) });
  const t0 = performance.now();
  try {
    await prover.load("withdraw");
    out.loadMs = Math.round(performance.now() - t0);
  } catch (e) {
    out.loadError = err(e);
    prover.terminate();
    return out;
  }
  const t1 = performance.now();
  try {
    out.result = await prover.prove("withdraw", input);
    out.proveWallMs = Math.round(performance.now() - t1);
  } catch (e) {
    out.proveError = err(e);
  }
  prover.terminate();
  return out;
}

(window as unknown as { __kitProver: unknown }).__kitProver = { run };
