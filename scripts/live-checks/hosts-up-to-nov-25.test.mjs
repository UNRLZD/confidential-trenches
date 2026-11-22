// node --test scripts/live-checks/hosts-up-to-nov-25.test.mjs: the live check of card hosts-up-to-nov-25 judges recorded
// runs (hosts-up-to-nov-25.answers.json). good: the three deployed hosts up: PASS. bad: SIGN_HOST pointed at a name with
// no DNS record and HELPER_HOST at a path it does not serve, each read twice: FAIL. A planted down host opens one issue
// labelled host-down, or comments on its open one; a host that fails once and then answers is up and opens none. The
// GitHub calls, the read rules and the scheduled workflow (every 15 minutes to 2026-11-25, actions pinned as ci.yml
// pins them, contents: read and no key) are held on their own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fault, githubIssues, HOSTS, judge, LABEL, LAST_DAY, readRun, report, RETRY_MS, titleOf } from "./hosts-up-to-nov-25.mjs";

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

/** A fake GitHub: the issues open under LABEL, and what report() asked of it. */
const fakeGh = (open = []) => {
  const did = [];
  return {
    did,
    open: async (label) => (did.push(["open", label]), open),
    create: async (title, body, label) => (did.push(["create", title, label, body]), 101),
    comment: async (n, body) => void did.push(["comment", n, body]),
  };
};
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

test("planted: the helper down on both reads opens one issue labelled host-down; with its issue open, a comment instead", async () => {
  const fetchFn = fetchOf((url) => (url.endsWith("/v1/health") ? [503, "application/json", '{"error":{"code":"upstream"}}'] : up(url)));
  const run = await readRun(HOSTS, { fetchFn, ...clock() });
  const r = judge(run);
  assert.equal(r.verdict, "FAIL");
  assert.deepEqual(r.down.map((d) => [d.name, d.why]), [["HELPER_HOST", "HTTP 503"]]);
  assert.equal(run.hosts[2].reads.length, 2, "read again before it counts as down");
  const gh = fakeGh();
  assert.deepEqual(await report(run, r, gh, "https://github.com/o/r/actions/runs/1"), ["opened #101: ct-api.unrealized.trade is down"]);
  const made = gh.did.filter(([k]) => k === "create");
  assert.equal(made.length, 1);
  assert.equal(made[0][1], "ct-api.unrealized.trade is down");
  assert.equal(made[0][2], LABEL);
  assert.match(made[0][3], /HTTP 503/);
  assert.match(made[0][3], /actions\/runs\/1/);
  const again = fakeGh([{ number: 7, title: titleOf(r.down[0]) }, { number: 8, title: "confidential.unrealized.trade is down" }]);
  assert.deepEqual(await report(run, r, again), ["commented on #7: ct-api.unrealized.trade is down"]);
  assert.equal(again.did.filter(([k]) => k === "create").length, 0);
});

test("planted: every host unreachable opens three issues, one a host", async () => {
  const run = await readRun(HOSTS, { fetchFn: fetchOf(() => [null, "", "ECONNREFUSED"]), ...clock() });
  const r = judge(run);
  assert.equal(r.down.length, 3);
  const gh = fakeGh();
  assert.deepEqual(await report(run, r, gh), ["ct-app.unrealized.trade", "confidential.unrealized.trade", "ct-api.unrealized.trade"].map((h) => `opened #101: ${h} is down`));
});

test("a host that fails once and then answers is up: no issue", async () => {
  const fetchFn = fetchOf((url, n) => (url.includes("ct-app") && n === 1 ? [502, "text/html", "bad gateway"] : up(url)));
  const run = await readRun(HOSTS, { fetchFn, ...clock() });
  const r = judge(run);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.ok(r.lines[0].includes("after a failed first read: HTTP 502"), r.lines[0]);
  const gh = fakeGh();
  assert.deepEqual(await report(run, r, gh), []);
  assert.equal(gh.did.length, 0, "a good run asks GitHub nothing");
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

test("githubIssues: the REST calls, with the workflow's token in the Authorization header only", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([init.method, url, init.headers.authorization, init.body ? JSON.parse(init.body) : null]);
    return new Response(JSON.stringify(init.method === "GET" ? [{ number: 3, title: "t", body: "x" }] : { number: 9 }), { status: 200 });
  };
  const gh = githubIssues("o/r", "tok", fetchFn);
  assert.deepEqual(await gh.open(LABEL), [{ number: 3, title: "t" }]);
  assert.equal(await gh.create("a is down", "b", LABEL), 9);
  await gh.comment(3, "c");
  assert.deepEqual(calls, [
    ["GET", `https://api.github.com/repos/o/r/issues?state=open&labels=${LABEL}&per_page=100`, "Bearer tok", null],
    ["POST", "https://api.github.com/repos/o/r/issues", "Bearer tok", { title: "a is down", body: "b", labels: [LABEL] }],
    ["POST", "https://api.github.com/repos/o/r/issues/3/comments", "Bearer tok", { body: "c" }],
  ]);
  await assert.rejects(githubIssues("o/r", "tok", async () => new Response("{}", { status: 403 })).open(LABEL), /HTTP 403/);
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
