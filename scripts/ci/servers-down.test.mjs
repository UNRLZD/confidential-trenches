// Card helper-unplug-off: the unplug drill's check that every server of ours is off (scripts/drill/servers-down.mjs).
// It replays scripts/drill/servers-down.answers.json: the stack read after deploy/unplug.sh off passes; the live helper
// read while it served and the same stack read after unplug.sh on fail; a read with one port still open, a health that
// answered, or no helper read at all fails; the static hosts never decide the verdict.
//   node --test scripts/ci/servers-down.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, tcp } from "../drill/servers-down.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const ANSWERS = `${ROOT}/scripts/drill/servers-down.answers.json`;
const answers = JSON.parse(readFileSync(ANSWERS, "utf8"));

test("the answers are the recorded reads: the stack after off and after on (unplug-proof.yml's run), and the live helper", () => {
  for (const name of ["good", "back_on", "live_up"]) {
    assert.equal(typeof answers[name]?.at, "string", `${name} is a recorded read`);
    assert.ok(Object.keys(answers[name].helper?.tcp ?? {}).length >= 2, `${name} read two ports`);
  }
});

test("the recorded good answer (the stack after unplug.sh off) passes: every port and the health answered nothing", () => {
  const v = judge(answers.good);
  assert.equal(v.pass, true, v.lines.join("\n"));
  assert.ok(v.lines.filter((l) => l.startsWith("ok ")).length >= 3, v.lines.join("\n"));
});

test("the recorded bad answers fail: the live helper while it served, and the local stack after unplug.sh on", () => {
  for (const name of ["live_up", "back_on"]) {
    const v = judge(answers[name]);
    assert.equal(v.pass, false, `${name}: ${v.lines.join("\n")}`);
  }
  assert.match(judge(answers.live_up).lines.join("\n"), /BAD ct-api\.unrealized\.trade\/v1\/health answered 200/);
});

test("one port still taking a connection, or a health that answered at all (a 502 from Caddy with the helper off), fails", () => {
  const g = answers.good;
  const open = { ...g, helper: { ...g.helper, tcp: { ...g.helper.tcp, [Object.keys(g.helper.tcp)[0]]: "open" } } };
  assert.equal(judge(open).pass, false);
  const answered = { ...g, helper: { ...g.helper, health: { status: 502 } } };
  assert.equal(judge(answered).pass, false);
  const onePort = { ...g, helper: { ...g.helper, tcp: { 443: "refused" } } };
  assert.equal(judge(onePort).pass, false);
});

test("no helper read is nothing to judge, a FAIL; the static hosts are reported and never change the verdict", () => {
  assert.equal(judge({}).pass, false);
  assert.equal(judge({ helper: null }).pass, false);
  const statics = [{ host: "ct-app.unrealized.trade", status: 200 }, { host: "confidential.unrealized.trade", status: null, error: "ENOTFOUND" }];
  const v = judge({ ...answers.good, statics });
  assert.equal(v.pass, true, v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("-- ct-app.unrealized.trade answered 200")), v.lines.join("\n"));
});

test("tcp reads a listening port as open and a closed one as refused", async () => {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const port = srv.address().port;
  assert.equal(await tcp("127.0.0.1", port), "open");
  await new Promise((ok) => srv.close(ok));
  assert.equal(await tcp("127.0.0.1", port), "refused");
});

test("the command judges a recorded answer: PASS exit 0 on the good one, FAIL exit 1 on a bad one", () => {
  const dir = mkdtempSync(`${tmpdir()}/servers-down-`);
  try {
    for (const [name, want] of [["good", 0], ["live_up", 1], ["back_on", 1]]) {
      writeFileSync(`${dir}/${name}.json`, JSON.stringify(answers[name]));
      const r = spawnSync(process.execPath, [`${ROOT}/scripts/drill/servers-down.mjs`, "--dry", `${dir}/${name}.json`], { encoding: "utf8" });
      assert.equal(r.status, want, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, new RegExp(`servers-down: ${want === 0 ? "PASS" : "FAIL"} `));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
