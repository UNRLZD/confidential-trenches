// node --test scripts/live-checks/signpage-generated-merge-free.test.mjs: the live check of card
// signpage-generated-merge-free replays its recorded answers (signpage-generated-merge-free.answers.json): the good one
// (this commit's deploy build, served from its folder as SIGN_HOST serves it) passes; SIGN_HOST read live while it served
// an older release fails on the bundle and the page alone; a checkout that commits the four outputs (main at 124994e7)
// fails on that alone. And this tree's own deploy build, read through the check's reader, passes the live rule.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read } from "./signpage-generated-merge-free.mjs";
import { gateBuild } from "./signpage-prover-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const answers = JSON.parse(readFileSync(path.join(HERE, "signpage-generated-merge-free.answers.json"), "utf8"));
const bad = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  assert.equal(judge(answers.good).pass, true, judge(answers.good).lines.join("\n"));
});

test("SIGN_HOST serving another build than the commit's sources fails on /app.js and / only", () => {
  const b = bad(answers.bad_host_lags);
  assert.equal(b.length, 2, b.join("\n"));
  assert.match(b[0], /\/app\.js is this commit's build/);
  assert.match(b[1], /\/ is this commit's build/);
});

test("a commit that tracks the build outputs fails on that alone, naming each", () => {
  const b = bad(answers.bad_tracked);
  assert.equal(b.length, 1, b.join("\n"));
  for (const f of ["index.html", "public/app.js", "public/prover-worker.js", "public/prover-thread.js"]) assert.ok(b[0].includes(`packages/signpage/${f} is tracked`), f);
});

test("planted: a page whose pin is not its /app.js, and a record missing a part, fail", () => {
  const g = structuredClone(answers.good);
  g.served.index.pin = "sha384-AAAA";
  assert.match(bad(g).join("\n"), /pins \/app\.js with the sha384/);
  assert.deepEqual(judge({ served: answers.good.served }).lines, ["BAD the record lacks served, built or tracked"]);
});

test("this tree's deploy build, read through the check's reader as SIGN_HOST would serve it, passes the live rule", async () => {
  const dir = gateBuild(); // node packages/signpage/scripts/deploy.mjs --build: the deploy's own build, gate passed
  try {
    const local = async (url) => new Response(readFileSync(path.join(dir, new URL(url).pathname === "/" ? "index.html" : new URL(url).pathname.slice(1))), { status: 200 });
    const rec = await read(local);
    assert.equal(judge(rec).pass, true, judge(rec).lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
