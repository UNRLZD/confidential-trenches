// The token identity's logic (card app-token-header): which link icons draw, the share link, copy, and the star.
//   node --test apps/terminal/test/token-header.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyText, readWatch, shareHref, toggleWatch, tokenLinks, WATCH_KEY } from "../src/screens/token/model.ts";

test("link icons only where data exists: Search on X by the address and the chain's explorer, never a website, X account or Telegram the row does not carry", () => {
  const mint = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  assert.deepEqual(tokenLinks("solana", mint), [
    { id: "xSearch", href: `https://x.com/search?q=${mint}` },
    { id: "explorer", name: "solscan", href: `https://solscan.io/token/${mint}` },
  ]);
  assert.equal(tokenLinks("base", "0xabc")[1]!.href, "https://basescan.org/token/0xabc");
  assert.equal(tokenLinks("robinhood", "0xabc")[1]!.href, "https://robinhoodchain.blockscout.com/token/0xabc");
  assert.equal(tokenLinks("near", "nearly-993927.nearlytrade.near")[1]!.href, "https://nearblocks.io/token/nearly-993927.nearlytrade.near");
  // a chain with no explorer named draws no explorer icon; an id is one path segment and one query value
  assert.deepEqual(tokenLinks("other", "x").map((l) => l.id), ["xSearch"]);
  assert.equal(tokenLinks("solana", "a/b?c")[1]!.href, "https://solscan.io/token/a%2Fb%3Fc");
  assert.equal(tokenLinks("solana", "a&b")[0]!.href, "https://x.com/search?q=a%26b");
});

test("share names the token's public address on the shell's host", () => {
  assert.equal(shareHref("https://confidential.unrealized.trade/", "solana", "Mint1"), "https://confidential.unrealized.trade/token/solana/Mint1");
  assert.equal(shareHref("https://confidential.unrealized.trade/", "near", "a/b"), "https://confidential.unrealized.trade/token/near/a%2Fb");
});

test("copy: the async clipboard first; refused (a framed page), the page's own copy; neither, false", async () => {
  const took: string[] = [];
  const clip = { writeText: async (t: string) => void took.push(`clip ${t}`) };
  const refused = {
    writeText: async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
  };
  const page = (ok: boolean) => (t: string) => (took.push(`page ${t}`), ok);
  assert.equal(await copyText("A", clip, page(true)), true);
  assert.equal(await copyText("B", refused, page(true)), true);
  assert.equal(await copyText("C", undefined, page(true)), true);
  assert.equal(await copyText("D", refused, page(false)), false);
  const broken = () => {
    throw new Error("no document");
  };
  assert.equal(await copyText("E", refused, broken), false);
  assert.deepEqual(took, ["clip A", "page B", "page C", "page D"]);
});

test("the star keeps the token on this device and toggles back; a broken or missing store never breaks the press", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  assert.deepEqual(readWatch(store), []);
  assert.equal(toggleWatch(store, "solana/A"), true);
  assert.equal(toggleWatch(store, "near/B"), true);
  assert.deepEqual(readWatch(store), ["solana/A", "near/B"]);
  assert.equal(toggleWatch(store, "solana/A"), false);
  assert.deepEqual(JSON.parse(m.get(WATCH_KEY)!), ["near/B"]);
  m.set(WATCH_KEY, "{not json");
  assert.deepEqual(readWatch(store), []);
  m.set(WATCH_KEY, JSON.stringify(["x", 1, null]));
  assert.deepEqual(readWatch(store), ["x"]);
  const blocked = () => {
    throw new Error("blocked");
  };
  assert.equal(toggleWatch({ getItem: blocked, setItem: blocked }, "solana/A"), true);
  assert.equal(toggleWatch(null, "solana/A"), true);
});

// card token-page-data-complete-and-fast: the token's own site, X and Telegram (the helper's token read `links`) and
// its launchpad's page are drawn when they exist; the X account takes Search on X's place
test("the token's own links are drawn when the helper's read carries them, each checked, named by its address", async () => {
  const { socialLinks } = await import("../src/screens/token/model.ts");
  const mint = "Dbo4K8s93qPsB2t6ae1MCJPr4aNND2RtZNFSWc8Jpump";
  const social = socialLinks({ site: "https://bubble.fun/", x: "https://x.com/bubble", telegram: "https://t.me/bubble", extra: "https://a.b" });
  assert.deepEqual(tokenLinks("solana", mint, social, "pump.fun"), [
    { id: "site", href: "https://bubble.fun/", label: "bubble.fun" },
    { id: "x", href: "https://x.com/bubble", label: "x.com/bubble" },
    { id: "telegram", href: "https://t.me/bubble", label: "t.me/bubble" },
    { id: "pad", href: `https://pump.fun/coin/${mint}`, label: "pump.fun" },
    { id: "explorer", name: "solscan", href: `https://solscan.io/token/${mint}` },
  ]);
  // a launchpad with no known page path draws none; no X account keeps Search on X
  assert.deepEqual(tokenLinks("solana", mint, {}, "letsbonk.fun").map((l) => l.id), ["xSearch", "explorer"]);
  // hostile links are no links: a script URL, data, an IP, credentials, X or Telegram on another host
  assert.deepEqual(socialLinks({ site: "javascript:alert(1)", x: "https://evil.example/x.com", telegram: "https://t.me.evil.example/a" }), {});
  for (const bad of ["data:text/html,<b>", "https://127.0.0.1/", "https://u:p@a.b/", `https://a.b/${"x".repeat(300)}`, 5, null]) assert.deepEqual(socialLinks({ site: bad }), {});
  assert.deepEqual(socialLinks("not an object"), {});
});
