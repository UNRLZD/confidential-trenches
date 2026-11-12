// The restore's walk Workers on SIGN_HOST (card restore-shows-the-balance-in-seconds): each lane of the deposit index walk
// runs in a module Worker started from /walk-worker.js, one pinned same-origin file (scripts/build-app.mjs bundles
// packages/wallet/src/restore/walk-worker.ts into it; the release list pins its bytes), never from a blob: or data: URL,
// which worker-src 'self' refuses. SIGN_HOST's CSP requires Trusted Types for every script sink, so the URL is made a
// TrustedScriptURL by the policy `walk-worker` (public/_headers: trusted-types prover-worker walk-worker), created once
// per page, which turns exactly this origin's /walk-worker.js into one and refuses every other, as the kit's
// proverWorkerScriptURL does for the prover's worker. main.ts hands walkWorkerPort to poolRestore as `walkers`, which
// passes it to each pool's walk (walkLanes) as its spawn.
import type { WalkPort } from "../../wallet/src/restore/walk.ts";

export const WALK_POLICY_NAME = "walk-worker";
export const WALK_WORKER_PATH = "/walk-worker.js";

type ScriptURLPolicy = { createScriptURL(input: string): unknown };
type TrustedTypesLike = { createPolicy(name: string, rules: { createScriptURL(s: string): string }): ScriptURLPolicy };
let policy: ScriptURLPolicy | null = null;

/**
 * The walk Worker's script URL made through the policy `walk-worker`, created once per page (the CSP names it without
 * 'allow-duplicates'). The policy throws on anything but this origin's WALK_WORKER_PATH. In a browser without Trusted
 * Types the plain URL is returned, as nothing there checks a sink.
 */
export function walkWorkerScriptURL(): string | object {
  const origin = globalThis.location.origin;
  const url = new URL(WALK_WORKER_PATH, origin).href;
  const tt = (globalThis as unknown as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (!tt) return url;
  policy ??= tt.createPolicy(WALK_POLICY_NAME, {
    createScriptURL(input: string): string {
      const u = new URL(input, globalThis.location.origin);
      if (u.href !== url || u.origin !== globalThis.location.origin) throw new TypeError(`${WALK_POLICY_NAME} refuses ${u.href}`);
      return u.href;
    },
  });
  return policy.createScriptURL(url) as object;
}

/** Starts one walk Worker on this page's origin: a module Worker named "walk" running /walk-worker.js. */
export function walkWorkerPort(): WalkPort {
  if (typeof Worker === "undefined") throw new Error("walk worker: this browser has no Worker");
  return new Worker(walkWorkerScriptURL() as string, { type: "module", name: "walk" });
}
