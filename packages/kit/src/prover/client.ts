// The prover's page side (vault.md 2.14, row V2.4), for SIGN_HOST only: APP_HOST's policy never allows
// 'wasm-unsafe-eval', so a prover there fails closed (M304 D-8; wallet.md 2.7). It starts the one same-origin worker,
// prover-worker.js (build.mjs), through the Trusted Types policy `prover-worker`, which turns exactly that one URL into a
// TrustedScriptURL and refuses every other (SIGN_HOST's CSP: require-trusted-types-for 'script'; trusted-types
// prover-worker). It fetches each setup file from its own origin at /assets/zk/<sha256>.<ext> (zk/setup-files.ts),
// always asking the server (cache "no-cache": SIGN_HOST caches the files immutable, so a file that once came back wrong
// under its pinned name would otherwise be read from the browser's cache at every retry; a right one costs a 304), and
// moves the bytes to the worker by transfer, so no copy stays here; the worker checks every file's size and sha256
// before snarkjs sees it (worker.js), and proves on its threads (worker.js, card signpage-prover-threads).
import { ZK_SETUP_FILES } from "../zk/setup-files.ts";
import type { VaultSnarkjsProof } from "../vault/shapes.ts";

export const PROVER_POLICY_NAME = "prover-worker";
/** Every refusal of a worker that died or was ended starts with this; such a worker answers nothing again. */
export const PROVER_DEAD_PREFIX = "prover worker: ";

/** True when `e` is the refusal of a dead or ended prover worker: start a new one to prove again. */
export function isProverDead(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(PROVER_DEAD_PREFIX);
}
export const PROVER_WORKER_PATH = "/prover-worker.js";

export type ProverCircuit = "withdraw" | "commitment";
export type ProverInput = Readonly<Record<string, string | readonly string[]>>;
export interface ProverResult {
  proof: VaultSnarkjsProof;
  publicSignals: string[];
  /** fullProve's own time in the worker, in ms. */
  proveMs: number;
}
export interface ProverViolation {
  directive: string;
  blocked: string;
  sample: string;
}
export interface Prover {
  /** Fetches the circuit's wasm and zkey and moves them to the worker, which refuses them unless both match their pins. */
  load(circuit: ProverCircuit): Promise<void>;
  prove(circuit: ProverCircuit, input: ProverInput): Promise<ProverResult>;
  terminate(): void;
}
export interface ProverOptions {
  /** CSP or Trusted Types violations the worker reports. */
  onViolation?: (v: ProverViolation) => void;
}

/** The setup file's address on the page's own origin. */
export function setupFileURL(name: "withdraw.wasm" | "withdraw.zkey" | "commitment.wasm" | "commitment.zkey", origin: string): string {
  // an own key only: a polluted Object.prototype names no file
  if (typeof name !== "string" || !Object.hasOwn(ZK_SETUP_FILES, name)) throw new Error(`no such setup file ${typeof name === "string" ? name : typeof name}`);
  const ext = name.slice(name.lastIndexOf(".") + 1);
  return new URL(`/assets/zk/${ZK_SETUP_FILES[name].sha256}.${ext}`, origin).href;
}

type ScriptURLPolicy = { createScriptURL(input: string): unknown };
let policy: ScriptURLPolicy | null = null;

/**
 * The worker's script URL made through the policy `prover-worker`, created once per page (the CSP names it without
 * 'allow-duplicates'). The policy throws on anything but this origin's PROVER_WORKER_PATH. In a browser without
 * Trusted Types the plain URL is returned, as nothing there checks a sink.
 */
export function proverWorkerScriptURL(): string | object {
  const origin = self.location.origin;
  const url = new URL(PROVER_WORKER_PATH, origin).href;
  const tt = (self as unknown as { trustedTypes?: { createPolicy(n: string, r: { createScriptURL(s: string): string }): ScriptURLPolicy } }).trustedTypes;
  if (!tt) return url;
  policy ??= tt.createPolicy(PROVER_POLICY_NAME, {
    createScriptURL(input: string): string {
      const u = new URL(input, self.location.origin);
      if (u.href !== url || u.origin !== self.location.origin) throw new TypeError(`${PROVER_POLICY_NAME} refuses ${u.href}`);
      return u.href;
    },
  });
  return policy.createScriptURL(url) as object;
}

type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { type: "violation"; violation: ProverViolation };

/** Starts the prover worker on this page's origin. */
export function startProver(opts: ProverOptions = {}): Prover {
  const origin = self.location.origin;
  const worker = new Worker(proverWorkerScriptURL() as string, { name: "prover" });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  let dead: Error | null = null;
  const failAll = (e: Error) => {
    dead = e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.addEventListener("message", (ev: MessageEvent<Reply>) => {
    const m = ev.data;
    if ("type" in m) {
      if (m.type === "violation") opts.onViolation?.(m.violation);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
  });
  worker.addEventListener("error", (ev: ErrorEvent) => failAll(new Error(`${PROVER_DEAD_PREFIX}${ev.message || "failed to load"}`)));
  // a reply the page cannot deserialize would leave its call waiting for ever; no timeout, as a slow phone's proof is not a hang
  worker.addEventListener("messageerror", () => failAll(new Error(`${PROVER_DEAD_PREFIX}a reply could not be read`)));
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const id = next++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });

  const fetchFile = async (name: "withdraw.wasm" | "withdraw.zkey" | "commitment.wasm" | "commitment.zkey"): Promise<ArrayBuffer> => {
    const r = await fetch(setupFileURL(name, origin), { credentials: "omit", cache: "no-cache" });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.arrayBuffer();
  };

  return {
    async load(circuit) {
      const [wasm, zkey] = await Promise.all([fetchFile(`${circuit}.wasm`), fetchFile(`${circuit}.zkey`)]);
      await call({ cmd: "load", circuit, wasm, zkey }, [wasm, zkey]);
    },
    async prove(circuit, input) {
      return (await call({ cmd: "prove", circuit, input })) as ProverResult;
    },
    terminate() {
      worker.terminate();
      failAll(new Error(`${PROVER_DEAD_PREFIX}terminated`));
    },
  };
}
