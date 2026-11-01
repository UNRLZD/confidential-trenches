// GET /v1/health (markets paper H7 and 7.1): `ok`, `commit` and one state per part of the helper. A part is "down"
// until the card that builds it lands and turns it on here.
export const PARTS = ["proxy", "relay", "intents", "delegate", "orders", "log"] as const;
export type Part = (typeof PARTS)[number];
export type PartState = "up" | "down";

export type Health = { ok: true; commit: string; parts: Record<Part, PartState> };

export function health(commit: string, up: ReadonlySet<Part> = new Set()): Health {
  const parts = {} as Record<Part, PartState>;
  for (const p of PARTS) parts[p] = up.has(p) ? "up" : "down";
  return { ok: true, commit, parts };
}
