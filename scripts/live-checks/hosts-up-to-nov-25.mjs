#!/usr/bin/env node
// Live check of card hosts-up-to-nov-25: the three hosts of the live demo answer through 2026-11-25 (judging Nov 16-18,
// the demo kept up to Nov 25). It reads each host's public face with no key: APP_HOST and SIGN_HOST GET / (200 HTML from
// Cloudflare Pages), HELPER_HOST GET /v1/health (200 JSON with ok true). A host that fails is read again after RETRY_MS
// and counts as down only when that read fails too, so one dropped connection opens no issue.
// It passes only when every host answers so. A host down: FAIL, naming its status or error.
// .github/workflows/hosts-up.yml runs it every 15 minutes on GitHub's runners through 2026-11-25; a host down turns
// that run red. No key is read. report() turns a FAIL into one issue per host down, labelled LABEL and titled
// `<host> is down`, or a comment on that host's issue while one is open, through githubIssues(); it is not yet called
// by the workflow, whose token holds contents: read alone (scripts/ci/live-workflow.mjs refuses any other permission).
// After: app
// After: sign
// After: helper
//   node scripts/live-checks/hosts-up-to-nov-25.mjs [--app <url>] [--sign <url>] [--helper <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read (each host's status, content type, ok
//   field, error and time; no body), for the test's replay.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "hosts-up-to-nov-25";
const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2 });
export const HOSTS = Object.freeze([
  { name: "APP_HOST", url: "https://ct-app.unrealized.trade/", kind: "page" },
  { name: "SIGN_HOST", url: "https://confidential.unrealized.trade/", kind: "page" },
  { name: "HELPER_HOST", url: "https://ct-api.unrealized.trade/v1/health", kind: "health" },
]);
/** The wait before a failed host is read again [design: 20 s, past a Pages edge's or Caddy's restart blip, inside the
 *  15-minute probe]. */
export const RETRY_MS = 20_000;
/** One read's bound [design: 15 s; the helper's health answered in under a second, 22 Nov 09:2xZ]. */
export const READ_MS = 15_000;
/** The issue label every probe issue carries, so an open one is found again. */
export const LABEL = "host-down";
/** The last day the scheduled probe reads (UTC): the workflow's window job skips every later run. */
export const LAST_DAY = "2026-11-25";

/** One read of a host: status, content type, the health body's ok, the error, and its ms. */
async function readOnce(h, fetchFn, now) {
  const t0 = now();
  try {
    const r = await fetchFn(h.url, { redirect: "manual", headers: { "cache-control": "no-cache", ...(h.kind === "health" ? { origin: "https://ct-app.unrealized.trade" } : {}) }, signal: AbortSignal.timeout(READ_MS) });
    const text = await r.text();
    let ok = null;
    if (h.kind === "health") {
      try {
        ok = JSON.parse(text)?.ok === true;
      } catch {
        ok = false;
      }
    }
    return { status: r.status, type: r.headers.get("content-type") ?? "", ok, bytes: text.length, error: null, ms: Math.round(now() - t0) };
  } catch (e) {
    return { status: null, type: "", ok: null, bytes: 0, error: String(e?.cause?.code ?? e?.name ?? e?.message ?? e), ms: Math.round(now() - t0) };
  }
}

/** What is wrong with one read of host `h`, or null. */
export function fault(h, a) {
  if (a.error !== null) return `no answer: ${a.error}`;
  if (a.status !== 200) return `HTTP ${a.status}`;
  if (h.kind === "health") return /^application\/json/i.test(a.type) && a.ok === true ? null : `health not ok (${a.type || "no content type"}, ok ${a.ok})`;
  return /^text\/html/i.test(a.type) && a.bytes > 0 ? null : `not a page (${a.type || "no content type"}, ${a.bytes} bytes)`;
}

export async function readRun(hosts = HOSTS, { fetchFn = fetch, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), now = () => performance.now() } = {}) {
  const read = await Promise.all(
    hosts.map(async (h) => {
      const reads = [await readOnce(h, fetchFn, now)];
      if (fault(h, reads[0]) !== null) {
        await sleep(RETRY_MS);
        reads.push(await readOnce(h, fetchFn, now));
      }
      return { ...h, reads };
    }),
  );
  return { readAt: new Date().toISOString(), hosts: read };
}

/** The verdict: PASS when every host's last read is good, else FAIL; `down` names each host down and why. */
export function judge(run) {
  const lines = [];
  const down = [];
  const hosts = Array.isArray(run?.hosts) ? run.hosts : [];
  if (hosts.length !== HOSTS.length) lines.push(`BAD ${hosts.length} host(s) read, ${HOSTS.length} wanted`);
  for (const h of hosts) {
    const last = h.reads?.at(-1);
    const why = last === undefined ? "no read" : fault(h, last);
    const tries = h.reads?.length ?? 0;
    if (why === null) lines.push(`ok  ${h.name} ${h.url}: up (HTTP 200 in ${last.ms} ms${tries > 1 ? `, after a failed first read: ${fault(h, h.reads[0])}` : ""})`);
    else {
      lines.push(`BAD ${h.name} ${h.url}: down, ${why}${tries > 1 ? ` (read ${tries} times, ${RETRY_MS / 1000} s apart)` : ""}`);
      down.push({ name: h.name, url: h.url, why });
    }
  }
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines, down };
}

/** A host's issue title: one open issue per host down. */
export const titleOf = (d) => `${new URL(d.url).host} is down`;

/**
 * Opens an issue for each host down, or comments on its open one. `gh`: { open(label) -> [{number, title}],
 * create(title, body, label) -> number, comment(number, body) }. Returns what it did, one entry per host down.
 */
export async function report(run, { down }, gh, where = "") {
  if (down.length === 0) return [];
  const open = await gh.open(LABEL);
  const done = [];
  for (const d of down) {
    const title = titleOf(d);
    const body = `${d.name} (${d.url}) did not answer as it should at ${run.readAt}: ${d.why}.${where ? `\n\nProbe run: ${where}` : ""}\n\nRead by scripts/live-checks/${KEY}.mjs (card ${KEY}).`;
    const had = open.find((i) => i.title === title);
    if (had !== undefined) {
      await gh.comment(had.number, body);
      done.push(`commented on #${had.number}: ${title}`);
    } else {
      const n = await gh.create(title, body, LABEL);
      done.push(`opened #${n}: ${title}`);
    }
  }
  return done;
}

/** The GitHub REST calls report() makes, with a token that may write issues, in `repo` ("org/name"). */
export function githubIssues(repo, token, fetchFn = fetch) {
  const call = async (method, path, body) => {
    const r = await fetchFn(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    open: async (label) => (await call("GET", `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`)).map((i) => ({ number: i.number, title: i.title })),
    create: async (title, body, label) => (await call("POST", "/issues", { title, body, labels: [label] })).number,
    comment: async (number, body) => void (await call("POST", `/issues/${number}/comments`, { body })),
  };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const hosts = HOSTS.map((h) => ({ ...h, url: opt(`--${h.name.split("_")[0].toLowerCase()}`, h.url) }));
    const run = await readRun(hosts);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(`live-check ${KEY}: ${r.verdict}`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
