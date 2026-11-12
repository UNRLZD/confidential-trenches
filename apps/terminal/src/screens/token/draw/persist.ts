/**
 * Drawings per token, per browser (the live UNRLZD terminal's chart/draw/persist.ts): localStorage
 * `ct:chart-draw:v1:<chain>/<token>` = JSON array of saved drawings. Points keep timestamp + value only (data indexes
 * shift as candles arrive); the value is the helper's own unit, USD per token (the chart draws its bars scaled into
 * Price / MCap and USD / the chain's coin, units.ts factors; useDrawings.ts divides by that factor before saving and
 * multiplies when it draws), so drawings survive every unit switch. Every storage access is guarded (private windows,
 * quota, disabled storage).
 */
import { KNOWN_OVERLAYS } from "./tools.ts";
import type { MagnetMode } from "./tools.ts";

export const DRAW_KEY_PREFIX = "ct:chart-draw:v1:";
export const MAX_DRAWINGS = 200;
/** serialized size cap per token (chars) */
export const MAX_JSON = 200_000;

export interface SavedPoint {
  timestamp: number;
  value: number;
}

export interface SavedDrawing {
  name: string;
  points: SavedPoint[];
  extendData?: { text?: string } | null;
  lock: boolean;
  visible: boolean;
  mode: MagnetMode;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MODES: readonly string[] = ["normal", "weak_magnet", "strong_magnet"];
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const drawKey = (tokenId: string) => `${DRAW_KEY_PREFIX}${tokenId}`;

/** One entry from storage, or null when malformed / unknown. */
export function validDrawing(x: unknown): SavedDrawing | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== "string" || !KNOWN_OVERLAYS.has(o.name)) return null;
  if (!Array.isArray(o.points) || o.points.length === 0 || o.points.length > 4) return null;
  const points: SavedPoint[] = [];
  for (const p of o.points) {
    if (!p || typeof p !== "object") return null;
    const { timestamp, value } = p as Record<string, unknown>;
    if (!fin(timestamp) || !fin(value)) return null;
    points.push({ timestamp, value });
  }
  let extendData: SavedDrawing["extendData"] = null;
  if (o.extendData && typeof o.extendData === "object") {
    const t = (o.extendData as Record<string, unknown>).text;
    if (typeof t === "string") extendData = { text: t.slice(0, 500) };
  }
  return {
    name: o.name,
    points,
    extendData,
    lock: o.lock === true,
    visible: o.visible !== false,
    mode: (MODES.includes(o.mode as string) ? o.mode : "normal") as MagnetMode,
  };
}

export function parseDrawings(json: string | null): SavedDrawing[] {
  if (!json || json.length > MAX_JSON) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SavedDrawing[] = [];
  for (const x of raw) {
    const d = validDrawing(x);
    if (d) out.push(d);
    if (out.length >= MAX_DRAWINGS) break;
  }
  return out;
}

/** JSON for storage: newest MAX_DRAWINGS, and dropped oldest-first until under MAX_JSON */
export function serializeDrawings(list: readonly SavedDrawing[]): string {
  let keep = list.slice(-MAX_DRAWINGS);
  let json = JSON.stringify(keep);
  while (json.length > MAX_JSON && keep.length > 0) {
    keep = keep.slice(1);
    json = JSON.stringify(keep);
  }
  return json;
}

function storage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadDrawings(tokenId: string, st: Store | null = storage()): SavedDrawing[] {
  if (!st) return [];
  try {
    return parseDrawings(st.getItem(drawKey(tokenId)));
  } catch {
    return [];
  }
}

export function saveDrawings(
  tokenId: string,
  list: readonly SavedDrawing[],
  st: Store | null = storage(),
): void {
  if (!st) return;
  try {
    if (list.length === 0) st.removeItem(drawKey(tokenId));
    else st.setItem(drawKey(tokenId), serializeDrawings(list));
  } catch {
    // quota / disabled storage: drawings stay for this session only
  }
}

/** A chart overlay as it is saved (null: still drawing, not ours, or no usable points). */
export function toSaved(o: {
  name: string;
  points: ReadonlyArray<{ timestamp?: number | undefined; value?: number | undefined }>;
  extendData?: unknown;
  lock: boolean;
  visible: boolean;
  mode: string;
}): SavedDrawing | null {
  return validDrawing({
    name: o.name,
    points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
    extendData: o.extendData,
    lock: o.lock,
    visible: o.visible,
    mode: o.mode,
  });
}
