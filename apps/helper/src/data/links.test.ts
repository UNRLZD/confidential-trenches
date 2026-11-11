// A token's links (links.ts): what passes, what is refused, and the token page carrying them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LINKS, linksOf } from "./links.ts";
import { toRow } from "./solana/lists.ts";
import { PAGE_FIELDS, toPage } from "./solana/token.ts";

test("linksOf keeps an http(s) site, an X link on x.com or twitter.com and a Telegram link on t.me, and refuses the rest", () => {
  assert.deepEqual(linksOf("https://bubble.fun", "https://x.com/bubble", "https://t.me/bubble"), { site: "https://bubble.fun/", x: "https://x.com/bubble", telegram: "https://t.me/bubble" });
  assert.deepEqual(linksOf("http://old.site/a", "https://twitter.com/i/communities/1", "https://telegram.me/b"), { site: "http://old.site/a", x: "https://twitter.com/i/communities/1", telegram: "https://telegram.me/b" });
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://a.b/c", "https://user:pw@a.b/", "https://127.0.0.1/", "https://[::1]/", "not a url", `https://a.b/${"x".repeat(300)}`, 7, null, undefined])
    assert.deepEqual(linksOf(bad, undefined, undefined), {}, String(bad).slice(0, 40));
  assert.deepEqual(linksOf(undefined, "https://evil.example/x.com", "https://t.me.evil.example/x"), {}, "X and Telegram only on their own hosts");
});

test("a Solana token's page carries the links its Jupiter row gives, and none it does not", () => {
  const raw = JSON.parse(readFileSync(new URL("./solana/fixtures/jupiter-recent.json", import.meta.url), "utf8")) as Record<string, unknown>[];
  const withX = raw.find((t) => typeof t.twitter === "string")!;
  const none = raw.find((t) => t.twitter === undefined && t.website === undefined && t.telegram === undefined)!;
  for (const t of [withX, none]) toRow(t, Date.now());
  const mint = { decimals: 6, mintAuth: false, freezeAuth: false, feeBps: 0 } as unknown as Parameters<typeof toPage>[0];
  const page = toPage(mint, toRow(withX, Date.now())!, null, null, true, Date.now(), Date.now());
  assert.deepEqual(Object.keys(page), [...PAGE_FIELDS]);
  assert.deepEqual(page.links, { x: withX.twitter });
  assert.deepEqual(toPage(mint, toRow(none, Date.now())!, null, null, true, Date.now(), Date.now()).links, {});
  assert.deepEqual(LINKS.of("solana", "So11111111111111111111111111111111111111112"), {});
});
