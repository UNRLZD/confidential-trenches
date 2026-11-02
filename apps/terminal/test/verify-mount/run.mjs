#!/usr/bin/env node
// Verify mounted, in the app (card app-verify-mount): the terminal built for testnet (VITE_NEAR_NETWORK=testnet) opened
// at /verify inside the stand-in shell of the live check's harness (scripts/live-checks/app-verify-mount.mjs), at 390 and
// 1440. The page's NEAR reads are answered by a test double: Playwright's route answers each from the recording
// (answers.json, made by record.ts), so nothing recorded is in the build. Three runs:
//   recorded: the panel draws the read: both rows and every check ok, the pair named, the block read, and the footer
//             pill's second open starts from loading and reads again (the live check's own verdict, judge());
//   re-open:  the first open answered from the recording, then both RPCs refuse: the pill's second open draws every
//             check Unverified, so it never shows the first open's read;
//   failed:   both RPCs refuse every request: the panel draws every check Unverified (its existing word), both rows
//             amber, and no word the panel did not already have.
// The unit test (test/verify-mount.test.ts) holds the refused pair and the other network's pair to the same view.
//   node apps/terminal/test/verify-mount/run.mjs [--build <dir>] [--shots <dir>]     PASS exit 0, FAIL exit 1
// --build: a build to test (default: this tree built for testnet into a temp dir), e.g. a build of main for the red run.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, collect, harnessRoute, judge } from "../../../../scripts/live-checks/app-verify-mount.mjs";
import { VERIFY_RELEASES } from "../../src/screens/verify/release.ts";
import { WORDS } from "../../src/screens/verify/words.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL = path.resolve(HERE, "../..");
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const REC = JSON.parse(readFileSync(path.join(HERE, "answers.json"), "utf8"));
const RPCS = VERIFY_RELEASES.testnet.rpcs;

async function build() {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(tmpdir(), "ct-verify-mount-"));
  process.env.VITE_NEAR_NETWORK = "testnet";
  await build({ root: TERMINAL, logLevel: "error", build: { outDir: out, emptyOutDir: true } });
  return out;
}

/** The test double: each NEAR read answered from the recording by its RPC and params. */
const recorded = async (route) => {
  const q = route.request();
  const params = JSON.stringify(JSON.parse(q.postData() ?? "{}").params);
  const hit = REC.answers.find((a) => new URL(a.url).host === new URL(q.url()).host && JSON.stringify(a.params) === params);
  if (!hit) return route.abort("failed");
  return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(hit.answer) });
};
const refused = (route) => route.abort("connectionrefused");

const own = opt("--build") ? null : await build();
const dir = path.resolve(opt("--build") ?? own);
const shots = opt("--shots");
const fails = [];
const known = new Set(Object.values(WORDS).map((w) => w.text));
/** Every check Unverified, both rows amber, and only the panel's own words; else the reason. */
function unverified(p) {
  const n = (p?.words ?? []).filter((x) => x === WORDS.unverified.text).length;
  const all = !!p && CHECKS.every((c) => p.checks[c] === "warn") && Object.keys(p.checks).length === CHECKS.length;
  const extra = (p?.words ?? []).filter((x) => !known.has(x));
  const ok = p?.state === "unverified" && p.code === "warn" && p.funds === "warn" && all && n === CHECKS.length && !extra.length;
  return { ok, text: `panel ${p?.state ?? "none"}, code ${p?.code}, funds ${p?.funds}; ${n} x ${WORDS.unverified.text}${extra.length ? `; words the panel lacks: ${extra.join(", ")}` : ""}` };
}
try {
  const good = await collect({ shots: shots && path.join(shots, "recorded"), route: await harnessRoute(dir, RPCS, recorded), network: "testnet", source: "recorded reads" });
  const g = judge(good);
  for (const l of g.lines) console.log(`recorded: ${l}`);
  if (!g.ok) fails.push("recorded: the panel did not draw the recorded read");

  let mode = recorded;
  const again = await collect({ shots: shots && path.join(shots, "reopen"), route: await harnessRoute(dir, RPCS, (r) => mode(r)), network: "testnet", source: "recorded, then refused", beforeReopen: () => (mode = refused) });
  const d = again.runs.find((r) => r.width === "desktop");
  const first = d?.panel?.state === "read";
  const u = unverified(d?.footer?.panel);
  const ok = first && d.footer.firstState === "loading" && u.ok;
  console.log(`${ok ? "ok " : "BAD"} re-open: first open ${d?.panel?.state ?? "none"}; after the RPCs refuse, the pill's open starts ${d?.footer?.firstState ?? "nowhere"} and draws ${u.text}`);
  if (!ok) fails.push("re-open: the second open did not read afresh");

  const bad = await collect({ shots: shots && path.join(shots, "failed"), route: await harnessRoute(dir, RPCS, refused), network: "testnet", source: "refused reads" });
  for (const r of bad.runs) {
    const v = unverified(r.panel);
    console.log(`${v.ok ? "ok " : "BAD"} failed: ${r.width}: ${v.text}`);
    if (!v.ok) fails.push(`failed: ${r.width}`);
  }
} finally {
  if (own) rmSync(own, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`FAIL ${fails.join("; ")}`);
  process.exit(1);
}
console.log(`PASS the recorded read drawn at 390/1440 and read again on the pill's open; a re-open after the RPCs refuse draws Unverified; failed reads drawn Unverified at 390/1440${shots ? `; shots in ${shots}` : ""}`);
