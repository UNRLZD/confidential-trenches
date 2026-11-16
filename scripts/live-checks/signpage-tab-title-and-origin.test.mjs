// node --test scripts/live-checks/signpage-tab-title-and-origin.test.mjs: the live check replays recorded answers
// (signpage-tab-title-and-origin.answers.json). bad: SIGN_HOST on release-166, before this card: no <title>, and the
// shell's frame its peer from its insertion: FAIL, each named. good: this card's build, as SIGN_HOST serves it once
// deployed: PASS. Planted on the good one: a second title, another name, the peer set at insertion again, a served
// /app.js that is not the pinned one, and no frame code: FAIL. NAME is the framed app's own title, read here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FRAME_MARK, NAME, judge } from "./signpage-tab-title-and-origin.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-tab-title-and-origin.answers.json", import.meta.url), "utf8"));
const g = ANSWERS.good;

test("NAME is the framed app's own title (apps/terminal/index.html), the one it sets", () => {
  const app = readFileSync(new URL("../../apps/terminal/index.html", import.meta.url), "utf8");
  assert.deepEqual([...app.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]), [NAME]);
});

test("recorded bad answer: SIGN_HOST on release-166, no title and the peer set at the frame's insertion: FAIL", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [
    "BAD index.html's head holds 0 <title>, not one: the tab reads the address",
    "BAD the shell posts to its frame from its insertion: the peer is its window before its first load (its about:blank, on SIGN_HOST's origin)",
    "BAD the shell's frame does not become its peer in its own load listener",
  ]);
});

test("recorded good answer: the app's name in the tab, and the frame the peer from its load on: PASS", () => {
  const v = judge(g);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted: two titles, another name, a title outside the head, the peer set at insertion, an unpinned /app.js, no frame code: FAIL", () => {
  const fails = (a, re) => {
    const v = judge(a);
    assert.equal(v.ok, false);
    assert.ok(v.lines.some((l) => re.test(l)), v.lines.join("\n"));
  };
  fails({ ...g, index: g.index.replace("</title>", "</title><title>x</title>") }, /holds 2 <title>/);
  fails({ ...g, index: g.index.replace(`<title>${NAME}</title>`, "<title>Sign</title>") }, /reads "Sign"/);
  fails({ ...g, index: g.index.replace(`<title>${NAME}</title>`, "").replace("<body></body>", `<body><title>${NAME}</title></body>`) }, /holds 0 <title>/);
  const atInsert = g.app.frame.replace(/;(\w+)=(\w+)\}$/, ";$1=$2,l=r}");
  assert.notEqual(atInsert, g.app.frame, "the planted frame code changed");
  fails({ ...g, app: { ...g.app, frame: atInsert } }, /posts to its frame from its insertion/);
  fails({ ...g, app: { ...g.app, frame: g.app.frame.replace("(l=r,u())", "u()") } }, /does not become its peer in its own load listener/);
  fails({ ...g, app: { ...g.app, sha384: "sha384-other" } }, /not the one index\.html pins/);
  fails({ ...g, app: { ...g.app, frame: null } }, new RegExp(FRAME_MARK));
});
