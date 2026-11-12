// src/backdrop.ts drawSealedGround, the sealed screens' ground (the owner's pick A, 12 Nov 16:17Z), and its logo
// (src/ground-logo.ts): each layer is the brand's own file byte for byte, served as a data: image from the page's
// bundle; the ground starts hidden (the shell shows it, test/shell.test.ts), and draws the desktop cut or the phone cut
// by the width, lit over cool.
//   node --test test/backdrop.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drawSealedGround, groundLogo } from "../src/backdrop.ts";
import { GROUND_LOGO_FROM, GROUND_LOGO_SVG } from "../src/ground-logo.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");

test("the ground's logo is the brand's own files, byte for byte", () => {
  for (const [k, from] of Object.entries(GROUND_LOGO_FROM)) {
    assert.equal(GROUND_LOGO_SVG[k as keyof typeof GROUND_LOGO_SVG], readFileSync(join(REPO, from), "utf8"), `${k}: ${from}`);
  }
  // a data: image of exactly that text (img-src 'self' data:, public/_headers)
  const urls = groundLogo(GROUND_LOGO_SVG);
  for (const k of Object.keys(GROUND_LOGO_FROM) as (keyof typeof GROUND_LOGO_SVG)[]) {
    assert.ok(urls[k].startsWith("data:image/svg+xml,"));
    assert.equal(decodeURIComponent(urls[k].slice("data:image/svg+xml,".length)), GROUND_LOGO_SVG[k]);
  }
});

type Node = { tagName: string; id: string; hidden: boolean; alt?: string; src?: string; style: Record<string, string>; children: Node[]; attrs: Record<string, string> };
function fakeDoc(phone: boolean) {
  const changes: (() => void)[] = [];
  const mq = (q: string) => ({ get matches() { return q.includes("max-width") ? phone : !phone; }, addEventListener: (_: string, fn: () => void) => changes.push(fn) });
  const doc = {
    defaultView: { matchMedia: mq, innerWidth: phone ? 390 : 1440 },
    createElement: (tagName: string): Node => {
      const n: Node = { tagName, id: "", hidden: false, style: {}, children: [], attrs: {} };
      return Object.assign(n, { append: (...c: Node[]) => n.children.push(...c), setAttribute: (k: string, v: string) => void (n.attrs[k] = v) });
    },
  };
  return { doc: doc as unknown as Document, flip: (to: boolean) => ((phone = to), changes.forEach((f) => f())) };
}
const imgs = (n: Node): Node[] => (n.tagName === "img" ? [n] : n.children.flatMap(imgs));

test("the ground: hidden until the shell shows it, the logo lit over cool, its desktop cut or its phone cut by the width", () => {
  const logo = { lit: "L", cool: "C", phoneLit: "PL", phoneCool: "PC" };
  const { doc, flip } = fakeDoc(false);
  const g = drawSealedGround(doc, logo) as unknown as Node;
  assert.equal(g.id, "ground");
  assert.equal(g.hidden, true, "hidden until the frame leaves");
  assert.equal(g.attrs["aria-hidden"], "true");
  assert.equal(g.style.pointerEvents, "none");
  assert.deepEqual(imgs(g).map((i) => [i.src, i.alt]), [["C", ""], ["L", ""]], "cool first, lit over it");
  flip(true);
  assert.deepEqual(imgs(g).map((i) => i.src), ["PC", "PL"], "the phone cut below 768");
  flip(false);
  assert.deepEqual(imgs(g).map((i) => i.src), ["C", "L"]);
});
