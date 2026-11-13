// The chart's drawing tools (screens/token/draw, owner 12 Nov: chart drawing tools on par with UNRLZD): the live UNRLZD
// terminal's own tests (chart/draw/draw.test.ts there) on CT's port, under node:test, plus the unit rule CT adds (a
// drawing is saved in the helper's own unit and drawn back in the chart's).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// the vitest matchers those tests use, on node:assert
function expect(v: unknown, _label?: string) {
  const m = {
    toBe: (e: unknown) => assert.equal(v, e),
    toEqual: (e: unknown) => assert.deepEqual(v, e),
    toBeNull: () => assert.equal(v, null),
    toBeGreaterThan: (e: number) => assert.ok((v as number) > e, `${v} > ${e}`),
    toBeLessThanOrEqual: (e: number) => assert.ok((v as number) <= e, `${v} <= ${e}`),
    toHaveLength: (n: number) => assert.equal((v as { length: number }).length, n),
    toMatchObject: (e: Record<string, unknown>) => {
      for (const [k, x] of Object.entries(e)) assert.deepEqual((v as Record<string, unknown>)[k], x, k);
    },
    not: { toThrow: () => assert.doesNotThrow(v as () => unknown) },
  };
  return m;
}
import type { SavedDrawing } from "../src/screens/token/draw/persist.ts";
import {
  drawKey,
  loadDrawings,
  MAX_DRAWINGS,
  MAX_JSON,
  parseDrawings,
    saveDrawings,
  serializeDrawings,
  toSaved,
} from "../src/screens/token/draw/persist.ts";
import {
  BUILTIN_OVERLAYS,
  CUSTOM_OVERLAYS,
  columnHeight,
  DRAW_TOOLS,
  fmtDuration,
  foldedGroups,
  KNOWN_OVERLAYS,
  measureLabel,
  measureUp,
  nextMagnet,
} from "../src/screens/token/draw/tools.ts";

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const seg = (i = 0): SavedDrawing => ({
  name: "segment",
  points: [
    { timestamp: 1_000 + i, value: 2.5e-9 },
    { timestamp: 61_000 + i, value: 3.1e-9 },
  ],
  extendData: null,
  lock: false,
  visible: true,
  mode: "normal",
});

describe("persist", () => {
  it("round-trips per token", () => {
    const st = new MemStore();
    const note: SavedDrawing = { ...seg(), name: "ntText", extendData: { text: "breakout" } };
    saveDrawings("a.near", [seg(), note], st);
    expect(loadDrawings("a.near", st)).toEqual([seg(), note]);
    expect(loadDrawings("b.near", st)).toEqual([]);
    expect([...st.m.keys()]).toEqual([drawKey("a.near")]);
    // saving none removes the key
    saveDrawings("a.near", [], st);
    expect(st.m.size).toBe(0);
  });

  it("drops malformed entries and unknown overlays", () => {
    const raw = [
      seg(),
      { name: "evil", points: [{ timestamp: 1, value: 1 }] },
      { name: "segment", points: [] },
      { name: "segment", points: [{ timestamp: "x", value: 1 }] },
      { name: "segment", points: [{ timestamp: 1, value: Number.NaN }] },
      null,
      7,
      { ...seg(), mode: "bogus", lock: "yes", extendData: { text: 5 } },
    ];
    const out = parseDrawings(JSON.stringify(raw));
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ mode: "normal", lock: false, extendData: null });
    expect(parseDrawings("{not json")).toEqual([]);
    expect(parseDrawings(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseDrawings(null)).toEqual([]);
  });

  it("caps count and size", () => {
    const many = Array.from({ length: MAX_DRAWINGS + 50 }, (_, i) => seg(i));
    expect(parseDrawings(JSON.stringify(many))).toHaveLength(MAX_DRAWINGS);
    const kept = JSON.parse(serializeDrawings(many)) as SavedDrawing[];
    expect(kept).toHaveLength(MAX_DRAWINGS);
    // the newest are kept
    expect(kept.at(-1)).toEqual(seg(MAX_DRAWINGS + 49));
    const big = Array.from({ length: 150 }, (_, i) => ({
      ...seg(i),
      name: "ntText",
      extendData: { text: "x".repeat(490) },
    }));
    const json = serializeDrawings(big);
    expect(json.length).toBeLessThanOrEqual(MAX_JSON);
    expect(parseDrawings(json).length).toBeGreaterThan(0);
    expect(parseDrawings("x".repeat(MAX_JSON + 1))).toEqual([]);
  });

  it("survives storage that throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("x");
      },
    };
    expect(loadDrawings("a", bad)).toEqual([]);
    expect(() => saveDrawings("a", [seg()], bad)).not.toThrow();
    expect(() => saveDrawings("a", [], bad)).not.toThrow();
    expect(loadDrawings("a", null)).toEqual([]);
    // node test env: no localStorage at all
    expect(loadDrawings("a")).toEqual([]);
  });

  it("saves an overlay's timestamps + values only", () => {
    const s = toSaved({
      name: "rayLine",
      points: [
        { timestamp: 5, value: 1 },
        { timestamp: 9, value: 2 },
      ],
      extendData: undefined,
      lock: false,
      visible: true,
      mode: "weak_magnet",
    });
    expect(s).toEqual({
      name: "rayLine",
      points: [
        { timestamp: 5, value: 1 },
        { timestamp: 9, value: 2 },
      ],
      extendData: null,
      lock: false,
      visible: true,
      mode: "weak_magnet",
    });
    expect(
      toSaved({
        name: "rayLine",
        points: [{ value: 1 }],
        lock: false,
        visible: true,
        mode: "normal",
      }),
    ).toBeNull();
  });
});

describe("measure", () => {
  it("labels % · bars · time", () => {
    expect(
      measureLabel(
        { value: 100, dataIndex: 10, timestamp: 0 },
        { value: 112.34, dataIndex: 24, timestamp: 14 * 60_000 },
      ),
    ).toBe("+12.34% · 14 bars · 14m");
    expect(
      measureLabel(
        { value: 2, dataIndex: 5, timestamp: 0 },
        { value: 1, dataIndex: 4, timestamp: 60_000 },
      ),
    ).toBe("−50.00% · 1 bar · 1m");
    // unknown parts drop out
    expect(measureLabel({ value: 0 }, { value: 1 })).toBe("");
    expect(measureLabel({ dataIndex: 3 }, { dataIndex: 0 })).toBe("3 bars");
    expect(measureUp({ value: 1 }, { value: 1 })).toBe(true);
    expect(measureUp({ value: 2 }, { value: 1 })).toBe(false);
  });

  it("formats durations", () => {
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(14 * 60_000)).toBe("14m");
    expect(fmtDuration(2 * 3_600_000)).toBe("2h");
    expect(fmtDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(fmtDuration(3 * 86_400_000)).toBe("3d");
    expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(fmtDuration(-60_000)).toBe("1m");
  });
});

describe("catalogue", () => {
  it("every tool's overlay is built in or ours, ids unique", async () => {
    // klinecharts probes `window` at import: a bare stub is enough to register overlays
    const g = globalThis as { window?: unknown };
    g.window ??= globalThis;
    const { getSupportedOverlays } = await import("klinecharts");
    const { registerDrawOverlays } = await import("../src/screens/token/draw/overlays.ts");
    registerDrawOverlays();
    registerDrawOverlays(); // idempotent
    const have = new Set(getSupportedOverlays());
    for (const n of [...CUSTOM_OVERLAYS, ...BUILTIN_OVERLAYS]) expect(have.has(n), n).toBe(true);
    for (const t of DRAW_TOOLS) expect(KNOWN_OVERLAYS.has(t.overlay), t.id).toBe(true);
    expect(new Set(DRAW_TOOLS.map((t) => t.id)).size).toBe(DRAW_TOOLS.length);
  });

  it("magnet cycles off → weak → strong → off", () => {
    expect(nextMagnet("normal")).toBe("weak_magnet");
    expect(nextMagnet("weak_magnet")).toBe("strong_magnet");
    expect(nextMagnet("strong_magnet")).toBe("normal");
  });

  it("folds groups to the chart height", () => {
    // 30px steps (28px buttons + 2px gap)
    expect([...foldedGroups(800, 30)]).toEqual([]);
    expect([...foldedGroups(400, 30)]).toEqual(["lines"]);
    expect([...foldedGroups(360, 30)]).toEqual(["lines", "marks"]);
    expect([...foldedGroups(300, 30)]).toEqual(["lines", "marks", "shapes"]);
    // whatever stays inline fits
    for (const h of [300, 360, 400, 600]) {
      const f = foldedGroups(h, 30);
      const n =
        5 +
        (["lines", "shapes", "marks"] as const).reduce(
          (a, g) => a + (f.has(g) ? 1 : DRAW_TOOLS.filter((t) => t.group === g).length),
          0,
        );
      expect(columnHeight(n, 30, 4)).toBeLessThanOrEqual(h);
    }
  });
});

describe("CT's unit rule", () => {
  it("a drawing is saved in the helper's unit and drawn back in the chart's, whatever unit it was drawn in", () => {
    // drawn on the MCap chart (price factor = supply 1e9): a point at MC $2.5M is a price of $0.0025
    const mcap = 1e9;
    const drawnAt = { timestamp: 1_700_000_000_000, value: 2_500_000 };
    const saved = toSaved({ name: "segment", points: [{ timestamp: drawnAt.timestamp, value: drawnAt.value / mcap }, { timestamp: drawnAt.timestamp + 60_000, value: 3_000_000 / mcap }], lock: false, visible: true, mode: "normal" });
    expect(saved?.points[0]?.value).toBe(0.0025);
    // drawn back on the Price chart (factor 1) and on the MCap chart: the same place on each
    expect(saved!.points.map((p) => p.value * 1)).toEqual([0.0025, 0.003]);
    expect(saved!.points.map((p) => p.value * mcap)).toEqual([2_500_000, 3_000_000]);
  });
  it("keys a token's drawings by chain and token", () => {
    expect(drawKey("solana/So11111111111111111111111111111111111111112")).toBe("ct:chart-draw:v1:solana/So11111111111111111111111111111111111111112");
  });
});
