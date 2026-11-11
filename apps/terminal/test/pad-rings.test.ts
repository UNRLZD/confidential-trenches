// The launchpad ring colours (card discover-matches-the-main-app, src/screens/market/pads.ts PAD_RING), held to the main
// app's rules (UNRLZD components/viz/padColors.test.tsx): a colour for every pad the table names, inside sRGB, every two
// pads apart, legible on every dark ground and on the ring's own track, clear of gain, loss and live, saturated and
// clean; a pad with no brand colour takes the one neutral ring; a row with no known pad keeps its stage colour (null).
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEUTRAL_RING, PAD_RING, PADS, padRing } from "../src/screens/market/pads.ts";

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rad = (h: number) => (h * Math.PI) / 180;
type Lab = [number, number, number];
const fromLch = (l: number, c: number, h: number): Lab => [l, c * Math.cos(rad(h)), c * Math.sin(rad(h))];
function linearRgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const luminance = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const hexRgb = (hex: string): number[] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => lin(v / 255));
};
function hexLab(hex: string): Lab {
  const [r, g, b] = hexRgb(hex) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dE = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// the app's own tokens (src/screens/discover/discover.css, src/shell/shell.css, src/shell/search.css)
const GROUNDS = ["#0a0a0a", "#0f0f0f", "#111111", "#141414", "#181818"];
const TRACK = "#2a2a2a";
const MONEY = { gain: "#50e397", loss: "#ff5d4d", live: "#5b8cff" };

const branded = Object.entries(PAD_RING).flatMap(([id, r]) => (r === "neutral" ? [] : [[id, fromLch(r.l, r.c, r.h), r] as const]));
const all: [string, Lab][] = [...branded.map(([id, lab]) => [id, lab] as [string, Lab]), ["neutral", hexLab(NEUTRAL_RING)]];

test("every pad the table names has a ring colour, and the ring table names no pad the table does not", () => {
  assert.deepEqual(Object.keys(PAD_RING).sort(), Object.keys(PADS).sort());
});

test("every colour is inside sRGB, saturated and clean (chroma 0.10 or more, lightness 0.56 or more)", () => {
  for (const [id, lab, r] of branded) {
    for (const v of linearRgb(lab)) assert.ok(v >= -1e-4 && v <= 1 + 1e-4, `${id} out of sRGB`);
    assert.ok(r.c >= 0.1, `${id} chroma ${r.c}`);
    assert.ok(r.l >= 0.56, `${id} lightness ${r.l}`);
  }
});

test("every two pads, and each pad and the neutral ring, are at least 0.08 apart in OKLab", () => {
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) assert.ok(dE(all[i]![1], all[j]![1]) >= 0.08, `${all[i]![0]} / ${all[j]![0]}: ${dE(all[i]![1], all[j]![1]).toFixed(3)}`);
});

test("every ring holds 3:1 on every dark ground and 2.5:1 on its own empty track", () => {
  for (const [id, lab] of all) {
    const y = luminance(id === "neutral" ? hexRgb(NEUTRAL_RING) : linearRgb(lab));
    for (const g of GROUNDS) assert.ok(contrast(y, luminance(hexRgb(g))) >= 3, `${id} on ${g}`);
    assert.ok(contrast(y, luminance(hexRgb(TRACK))) >= 2.5, `${id} on the track`);
  }
});

test("no ring is the gain green, the loss red or the live blue (0.07 or more away in OKLab)", () => {
  for (const [id, lab] of all) for (const [k, hex] of Object.entries(MONEY)) assert.ok(dE(lab, hexLab(hex)) >= 0.07, `${id} vs ${k}`);
});

test("padRing: a pad's own colour, the neutral ring for a pad with no brand colour, null for null, unknown and prototype keys", () => {
  assert.equal(padRing("pump.fun"), "oklch(0.76 0.12 154)");
  assert.equal(padRing("pons"), NEUTRAL_RING);
  for (const id of [null, undefined, "", "nope", "constructor", "__proto__", "toString"]) assert.equal(padRing(id), null, String(id));
  // the pads the live lists showed on 11 Nov 15:20Z draw at least three colours
  assert.ok(new Set(["pump.fun", "stonkfun", "raydium-launchlab", "letsbonk.fun", "zora", "pons", "torch", "clanker", "doppler"].map(padRing)).size >= 3);
});
