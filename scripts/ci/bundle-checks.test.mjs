// node --test scripts/ci/bundle-checks.test.mjs: the bundle checks on a pull request's build (card
// signpage-check-shapes-on-build). Planted on a copy of this checkout's SIGN_HOST build: the build as it is, every
// check PASS; the reader's filter turned into one that lists owed/ keys (and the page re-pinned), signpage-withdraw-own-
// spend alone FAILs; /app.js changed under an old pin, every check FAILs; a check that reads past the build, a check
// that throws and a local-mode run that exits 1 each FAIL. And every check the SIGN_HOST and APP_HOST deploys run is
// either run here or left out with its reason, so a check a deploy adds is never silently skipped.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readerFilter } from "../live-checks/signpage-withdraw-own-spend.mjs";
import { buildFetch, CHILD_RUNS, IN_PROCESS, OUT, ROOT, run, SIGN, SIGN_DIR } from "./bundle-checks.mjs";
import { listOf } from "./live-plan.mjs";
import { signBuilt } from "../signpage-built.mjs";

const SIGN_ONLY = IN_PROCESS.filter((c) => c.host === "sign");
const sha384 = (b) => `sha384-${createHash("sha384").update(b).digest("base64")}`;

/** A copy of SIGN_HOST's build (index.html and public/app.js) with `edit` applied to app.js; `repin` writes its new sha384 into index.html. */
function signCopy(edit = (js) => js, repin = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-checks-"));
  mkdirSync(path.join(dir, "public"));
  signBuilt(); // this checkout's build, made from its sources (card signpage-generated-merge-free)
  const js = edit(readFileSync(path.join(SIGN_DIR, "public/app.js"), "utf8"));
  writeFileSync(path.join(dir, "public/app.js"), js);
  const index = readFileSync(path.join(SIGN_DIR, "index.html"), "utf8");
  writeFileSync(path.join(dir, "index.html"), repin ? index.replace(/integrity="sha384-[^"]+"/, `integrity="${sha384(js)}"`) : index);
  return dir;
}

test("every check the SIGN_HOST and APP_HOST deploys run is run here or left out with its reason, never both", () => {
  const listed = new Set(["sign", "app"].flatMap((h) => listOf(h, ROOT, { commit: "0".repeat(40), network: "mainnet" }).checks));
  const ran = new Set([...IN_PROCESS, ...CHILD_RUNS].map((c) => c.key));
  for (const k of listed) assert.ok(ran.has(k) !== Object.hasOwn(OUT, k), `${k}: ${ran.has(k) ? "run and left out" : "neither run nor left out"}`);
  for (const k of [...ran, ...Object.keys(OUT)]) assert.ok(listed.has(k), `${k} is no deploy's live check`);
});

test("this checkout's SIGN_HOST build as it is: every check PASS", async () => {
  const dir = signCopy();
  try {
    const out = await run({ sign: dir, app: dir, inProcess: SIGN_ONLY, childRuns: [] });
    assert.equal(out.length, SIGN_ONLY.length);
    for (const r of out) assert.equal(r.ok, true, `${r.key}: ${r.lines.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: the reader's filter lists owed/ keys: signpage-withdraw-own-spend alone FAILs", async () => {
  const dir = signCopy((js) => {
    const f = readerFilter(js);
    assert.ok(f, "the build's reader is found");
    return js.replace(f.body, "!0");
  });
  try {
    const out = await run({ sign: dir, app: dir, inProcess: SIGN_ONLY, childRuns: [] });
    assert.deepEqual(out.filter((r) => !r.ok).map((r) => r.key), ["signpage-withdraw-own-spend"]);
    assert.ok(out.find((r) => !r.ok).lines.includes("BAD the frame's reader lists owed/ keys of meta"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: /app.js changed under the old pin: every check FAILs", async () => {
  const dir = signCopy((js) => `${js}\n`, false);
  try {
    const out = await run({ sign: dir, app: dir, inProcess: SIGN_ONLY, childRuns: [] });
    assert.deepEqual(out.filter((r) => r.ok).map((r) => r.key), []);
    assert.equal(out.length, SIGN_ONLY.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: a check that reads past the build, or throws, FAILs with ERROR", async () => {
  const dir = signCopy();
  try {
    const past = { key: "signpage-withdraw-own-spend", host: "sign", load: () => import("../live-checks/signpage-withdraw-own-spend.mjs"), run: async (_m, f) => ((await f("https://rpc.example/")), { ok: true, lines: [] }) };
    const throws = { key: "signpage-withdraw-own-spend", host: "sign", load: () => import("../live-checks/signpage-withdraw-own-spend.mjs"), run: async () => { throw new Error("planted"); } };
    const passes = { key: "signpage-withdraw-own-spend", host: "sign", load: () => import("../live-checks/signpage-withdraw-own-spend.mjs"), run: async (m, f) => m.judge(await m.read(f)) };
    const out = await run({ sign: dir, app: dir, inProcess: [past, throws, passes], childRuns: [] });
    assert.deepEqual(out.map((r) => r.ok), [false, false, true]);
    assert.match(out[0].lines[0], /^ERROR https:\/\/rpc\.example: not this build/);
    assert.deepEqual(out[1].lines, ["ERROR planted"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planted: a local-mode run that exits 1 FAILs with its last lines; one that exits 0 PASSes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-checks-root-"));
  try {
    mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
    writeFileSync(path.join(root, "scripts/live-checks/planted.mjs"), 'console.log("BAD planted"); process.exit(process.argv.includes("--bad") ? 1 : 0);\n');
    const out = await run({ root, inProcess: [], childRuns: [{ key: "planted", host: "sign", args: ["--bad"] }, { key: "planted", host: "sign", args: [] }] });
    assert.deepEqual(out.map((r) => r.ok), [false, true]);
    assert.deepEqual(out[0].lines, ["BAD planted"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fetch answers only from the build: a path outside it is 404", async () => {
  const dir = signCopy();
  try {
    copyFileSync(path.join(dir, "index.html"), path.join(dir, "secret.txt"));
    const f = buildFetch({ sign: path.join(dir, "public"), app: dir });
    assert.equal((await f(`${SIGN}/app.js`)).status, 404, "public/public/app.js is not there");
    assert.equal((await f(`${SIGN}/index.html`)).status, 404, "no index.html in public/");
    assert.equal((await f(`${SIGN}/..%2F..%2Fsecret.txt`)).status, 404, "no path climbs out of the build");
    assert.equal((await f(`${SIGN}/..%2F..%2Fpublic%2Fapp.js`)).status, 200, "an escaped path inside it is read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
