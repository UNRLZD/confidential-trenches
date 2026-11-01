// node --test build/sri.test.mjs: the integrity step on planted pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addIntegrity, sha384 } from "./sri.mjs";

const FILES = { "/assets/a.js": Buffer.from("console.log(1)"), "/assets/a.css": Buffer.from("body{}") };
const read = (u) => {
  if (!(u in FILES)) throw new Error(`missing ${u}`);
  return FILES[u];
};
const PAGE = `<head><title>x</title><script type="module" crossorigin src="/assets/a.js"></script><link rel="stylesheet" crossorigin href="/assets/a.css"></head>`;

test("each script and stylesheet carries the sha384 of its file, and the fonts are preloaded", () => {
  const out = addIntegrity(PAGE, read, ["/assets/f.woff2"]);
  assert.match(out, new RegExp(`src="/assets/a.js" integrity="${sha384(FILES["/assets/a.js"]).replace(/[+/]/g, "\\$&")}"`));
  assert.match(out, new RegExp(`href="/assets/a.css" integrity="${sha384(FILES["/assets/a.css"]).replace(/[+/]/g, "\\$&")}"`));
  assert.match(out, /<link rel="preload" href="\/assets\/f.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.equal(sha384(Buffer.from("abc")), "sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn");
});

test("planted: an inline script stops the build", () => {
  assert.throws(() => addIntegrity(`${PAGE}<script>alert(1)</script>`, read), /an inline script/);
});

test("planted: a script whose file is missing stops the build", () => {
  assert.throws(() => addIntegrity(PAGE.replace("a.js", "b.js"), read), /missing \/assets\/b.js/);
});

test("planted: a tag that already names an integrity is refused, not given a second one", () => {
  assert.throws(() => addIntegrity(PAGE.replace("<script ", '<script integrity="sha384-x" '), read), /already has an integrity/);
});
