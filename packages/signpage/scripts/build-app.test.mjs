// node --test packages/signpage/scripts/build-app.test.mjs: the committed public/app.js and index.html are a fresh
// build of src/main.ts, and the page runs that one script only, under its sha384 (Integrity-Policy, public/_headers).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, sha384 } from "./build-app.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

test("public/app.js and index.html match a fresh build", async () => {
  assert.deepEqual(await check(), []);
});

test("index.html runs one script, /app.js, with its sha384, and nothing inline", () => {
  const html = readFileSync(join(PKG, "index.html"), "utf8");
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(tags.length, 1);
  assert.match(tags[0][1], /\ssrc="\/app\.js"/);
  assert.equal(tags[0][2], "");
  assert.equal(/\sintegrity="([^"]+)"/.exec(tags[0][1])[1], sha384(readFileSync(join(PKG, "public/app.js"))));
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i);
});

test("a hand-edited bundle or a stale integrity is caught", async () => {
  // committed copies with a hand-edited bundle, then with the bundle right and the page's integrity stale
  const d = mkdtempSync(join(tmpdir(), "ct-signpage-build-test-"));
  mkdirSync(join(d, "public"));
  const js = readFileSync(join(PKG, "public/app.js"), "utf8");
  writeFileSync(join(d, "public/app.js"), js.replace("sign.confidential.unrealized.trade", "sign.evil.test"));
  cpSync(join(PKG, "index.html"), join(d, "index.html"));
  assert.match((await check(PKG, d)).join("\n"), /public\/app\.js is not the build/);
  writeFileSync(join(d, "public/app.js"), js);
  writeFileSync(join(d, "index.html"), readFileSync(join(PKG, "index.html"), "utf8").replace(/sha384-[^"]+/, sha384(Buffer.from("x"))));
  assert.deepEqual(await check(PKG, d), ["index.html is not the page around public/app.js with its sha384"]);
  rmSync(d, { recursive: true, force: true });
});
