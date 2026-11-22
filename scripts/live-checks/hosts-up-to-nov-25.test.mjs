// node --test scripts/live-checks/hosts-up-to-nov-25.test.mjs: the live check of card hosts-up-to-nov-25 judges recorded
// runs (hosts-up-to-nov-25.answers.json). good: the three deployed hosts up: PASS. bad: SIGN_HOST pointed at a name with
// no DNS record and HELPER_HOST at a path it does not serve, each read twice: FAIL. A planted down host, read twice, is
// FAIL; a host that fails once and then answers is up. The read rules and the scheduled workflow (every 15 minutes to
// 2026-11-25, actions pinned as ci.yml pins them, contents: read and no key) are held on their own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fault, HOSTS, judge, LAST_DAY, readRun, RETRY_MS } from "./hosts-up-to-nov-25.mjs";

const A = JSON.parse(readFileSync(new URL("./hosts-up-to-nov-25.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("good: the three deployed hosts up: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(A.good.hosts.map((h) => h.name), ["APP_HOST", "SIGN_HOST", "HELPER_HOST"]);
  assert.equal(r.down.length, 0);
});

test("bad: a host with no DNS record and a path not served, each read twice: FAIL, both named", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(r.down.map((d) => [d.name, d.why]), [["SIGN_HOST", "no answer: ENOTFOUND"], ["HELPER_HOST", "HTTP 404"]]);
  assert.ok(bad(r).every((l) => l.endsWith(`(read 2 times, ${RETRY_MS / 1000} s apart)`)), r.lines.join("\n"));
});

/** fetch for the three hosts; `answer(url, n)` gives the n-th read of url (1-based) as [status, type, body]. */
const fetchOf = (answer) => {
  const n = new Map();
  return async (url) => {
    n.set(url, (n.get(url) ?? 0) + 1);
    const [status, type, body] = answer(url, n.get(url));
    if (status === null) throw Object.assign(new TypeError("fetch failed"), { cause: { code: body } });
    return new Response(body, { status, headers: { "content-type": type } });
  };
};
const up = (url) => (url.endsWith("/v1/health") ? [200, "application/json", JSON.stringify({ ok: true })] : [200, "text/html; charset=utf-8", "<!doctype html><title>x</title>"]);
const clock = () => {
  let t = 0;
  return { sleep: async (ms) => void (t += ms), now: () => t };
};

test("planted: the helper down on both reads, or every host unreachable: FAIL, each host down named", async () => {
  const run = await readRun(HOSTS, { fetchFn: fetchOf((url) => (url.endsWith("/v1/health") ? [503, "application/json", '{"error":{"code":"upstream"}}'] : up(url))), ...clock() });
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(r.down.map((d) => [d.name, d.why]), [["HELPER_HOST", "HTTP 503"]]);
  assert.equal(run.hosts[2].reads.length, 2, "read again before it counts as down");
  const none = judge(await readRun(HOSTS, { fetchFn: fetchOf(() => [null, "", "ECONNREFUSED"]), ...clock() }));
  assert.deepEqual(none.down.map((d) => [d.name, d.why]), HOSTS.map((h) => [h.name, "no answer: ECONNREFUSED"]));
});

test("a host that fails once and then answers is up: PASS", async () => {
  const fetchFn = fetchOf((url, n) => (url.includes("ct-app") && n === 1 ? [502, "text/html", "bad gateway"] : up(url)));
  const run = await readRun(HOSTS, { fetchFn, ...clock() });
  const r = judge(run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines[0].includes("after a failed first read: HTTP 502"), r.lines[0]);
});

test("fault: a page is 200 HTML with a body, the health 200 JSON with ok true", () => {
  const [app, , helper] = HOSTS;
  const a = (o) => ({ status: 200, type: "text/html", ok: null, bytes: 10, error: null, ms: 1, ...o });
  assert.equal(fault(app, a({})), null);
  assert.equal(fault(helper, a({ type: "application/json", ok: true })), null);
  assert.match(fault(app, a({ type: "application/json" })), /not a page/);
  assert.match(fault(app, a({ bytes: 0 })), /not a page/);
  assert.match(fault(app, a({ status: 301 })), /HTTP 301/);
  assert.match(fault(helper, a({ type: "application/json", ok: false })), /health not ok/);
  assert.match(fault(helper, a({ type: "text/html", ok: true })), /health not ok/);
  assert.match(fault(helper, a({ status: null, error: "ETIMEDOUT" })), /no answer: ETIMEDOUT/);
});

test("the workflow: every 15 minutes, its window ends on LAST_DAY, contents: read alone, actions pinned as ci.yml pins them, no key", () => {
  const wf = readFileSync(new URL("../../.github/workflows/hosts-up.yml", import.meta.url), "utf8");
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const cron = /cron: "([^"]+)"/.exec(wf)?.[1];
  const mins = cron.split(" ")[0].split(",").map(Number);
  assert.equal(mins.length, 4);
  assert.ok(mins.every((m, i) => i === 0 || m - mins[i - 1] === 15) && cron.endsWith(" * * * *"), cron);
  assert.ok(wf.includes(`\\> ${LAST_DAY} ]`), "the window skips scheduled runs after LAST_DAY");
  assert.match(wf, /\npermissions:\n {2}contents: read\n\n/);
  assert.equal(wf.match(/permissions:/g).length, 1, "no job widens it");
  const uses = [...wf.matchAll(/uses: (\S+)@(\S+)/g)].map((m) => [m[1], m[2]]);
  assert.ok(uses.length >= 2);
  for (const [action, sha] of uses) {
    assert.match(sha, /^[0-9a-f]{40}$/, action);
    assert.ok(ci.includes(`uses: ${action}@${sha}`), `${action} at the sha ci.yml pins`);
  }
  const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /\$\{\{|secrets|token/i, "no token or secret read");
  assert.match(wf, /run: node scripts\/live-checks\/hosts-up-to-nov-25\.mjs\n/);
  assert.doesNotMatch(wf, /pnpm install|npm (ci|install)/, "the check needs no install");
});
