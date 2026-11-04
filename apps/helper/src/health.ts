// GET /v1/health (markets paper H7 and 7.1): `ok`, `commit`, `release` and one state per part of the helper. A part is
// "down" until the card that builds it lands and turns it on here.
// The parts and their states are the kit's HELPER_PARTS and HelperPartState (packages/kit/src/helper/v1.ts).
// `release` (card helper-release-bump) is HELPER_RELEASE, which deploy/redeploy.sh raises by one for every new commit,
// or null when the host sets none; it is for the operator's live check, and the kit's answer type leaves it out.
// `ready` (card helper-ready-gate): false until this process's warm-up is done (server.ts warmUntilReady: the Solana
// and EVM lists answer 200, and a Solana token page and its holders answer 200), true from then on; the deploy's
// healthcheck (deploy/compose.yaml) moves traffic only to a helper that answers true. Like `release`, the kit's answer
// type leaves it out.
import { HELPER_PARTS, type HelperPart, type HelperPartState } from "@blindfill/kit";
import { RELEASE_ENV } from "./withdraw/send.ts";

export const PARTS = HELPER_PARTS;
export type Part = HelperPart;
export type PartState = HelperPartState;

export type Health = { ok: true; commit: string; release: number | null; ready: boolean; parts: Record<Part, PartState> };

/** HELPER_RELEASE as the relayers read it (send.ts, bind/env.ts: 1 to 9 digits, no leading zero), else null. */
export function releaseOf(env: Record<string, string | undefined>): number | null {
  const v = env[RELEASE_ENV] ?? "";
  return /^[1-9][0-9]{0,8}$/.test(v) ? Number(v) : null;
}

export function health(commit: string, up: ReadonlySet<Part> = new Set(), release: number | null = null, ready = true): Health {
  const parts = {} as Record<Part, PartState>;
  for (const p of PARTS) parts[p] = up.has(p) ? "up" : "down";
  return { ok: true, commit, release, ready, parts };
}
