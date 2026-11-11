// node --test test/chart-zoom.test.ts: the chart's pointer under the shell's design-fit zoom (card
// chart-drags-and-tracks-the-pointer, src/screens/token/zoomEvents.ts). At 1440 the zoom is 0.75: a pointer 600 px into a
// plot drawn from x 100 is 800 of the plot's own px in, and a drag's page delta grows by the same 1 / 0.75.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unzoom } from "../src/screens/token/zoomEvents.ts";

test("a window point maps to the box's own px about its origin; page keeps its scroll offset", () => {
  const q = unzoom({ clientX: 700, clientY: 340, pageX: 700, pageY: 1340 }, 100, 40, 0.75);
  assert.equal(q.clientX - 100, 800);
  assert.equal(q.clientY - 40, 400);
  assert.equal(q.pageX - q.clientX, 0);
  assert.equal(q.pageY - q.clientY, 1000);
});

test("a 150 px move on screen is 200 of the plot's px at zoom 0.75, and itself at zoom 1", () => {
  const a = unzoom({ clientX: 400, clientY: 0, pageX: 400, pageY: 0 }, 100, 0, 0.75);
  const b = unzoom({ clientX: 550, clientY: 0, pageX: 550, pageY: 0 }, 100, 0, 0.75);
  assert.equal(b.pageX - a.pageX, 200);
  const c = unzoom({ clientX: 550, clientY: 9, pageX: 550, pageY: 9 }, 100, 0, 1);
  assert.deepEqual(c, { clientX: 550, clientY: 9, pageX: 550, pageY: 9 });
});
