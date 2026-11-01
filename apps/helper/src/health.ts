// GET /v1/health (markets paper H7 and 7.1): `ok`, `commit` and one state per part of the helper. A part is "down"
// until the card that builds it lands and turns it on here.
// The parts and their states are the kit's HELPER_PARTS and HelperPartState (packages/kit/src/helper/v1.ts).
import { HELPER_PARTS, type HelperPart, type HelperPartState } from "@blindfill/kit";

export const PARTS = HELPER_PARTS;
export type Part = HelperPart;
export type PartState = HelperPartState;

export type Health = { ok: true; commit: string; parts: Record<Part, PartState> };

export function health(commit: string, up: ReadonlySet<Part> = new Set()): Health {
  const parts = {} as Record<Part, PartState>;
  for (const p of PARTS) parts[p] = up.has(p) ? "up" : "down";
  return { ok: true, commit, parts };
}
