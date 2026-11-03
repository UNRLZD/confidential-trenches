// node --test scripts/ci/server-write.test.mjs: a stand-in HTTP server never sends its headers before it has read what
// it answers with. `res.writeHead(200, ...).end(readFileSync(file))` sends the 200 and then reads: a missing file throws
// after the headers are out, the catch's writeHead(404) throws ERR_HTTP_HEADERS_SENT inside the request handler, and the
// whole test run dies there (card ci-live-runners, apps/terminal test:e2e on Chrome, after BAR-10).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// a writeHead call whose chained .end( reads a file (or anything read in the argument) after the headers are sent
const HEADERS_THEN_READ = /\.writeHead\([^;]*\)\s*\.end\(\s*(?:\w+\.)?(?:readFileSync|readFile)\(/;

/** The files of `files` ([{ path, text }]) with a stand-in server that answers before it has read. */
export function sendsBeforeReading(files) {
  return files.filter(({ text }) => HEADERS_THEN_READ.test(text)).map((f) => f.path);
}

test("no stand-in server sends its headers before it reads the file it answers with", () => {
  const names = execFileSync("git", ["ls-files", "-z", "--", "*.mjs", "*.ts", "*.js"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = names.filter((n) => n !== "scripts/ci/server-write.test.mjs").map((n) => ({ path: n, text: readFileSync(path.join(ROOT, n), "utf8") }));
  assert.deepEqual(sendsBeforeReading(files), []);
});

test("planted: the pattern that crashed the e2e chain is found, and the read-first form is not", () => {
  const bad = 'try {\n  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "x" }).end(readFileSync(file));\n} catch { res.writeHead(404).end(); }';
  const good = 'try {\n  const body = readFileSync(file);\n  res.writeHead(200, { "content-type": "x" }).end(body);\n} catch { res.writeHead(404).end(); }';
  assert.deepEqual(sendsBeforeReading([{ path: "bad.mjs", text: bad }, { path: "good.mjs", text: good }]), ["bad.mjs"]);
  assert.deepEqual(sendsBeforeReading([{ path: "m.ts", text: 'rs.writeHead(200, {}).end(await readFile(p))' }]), []);
});
