// node test/store.e2e.mjs (from packages/wallet): the wallet store in headless Chromium on SIGN_HOST's own origin
// (https://sign.confidential.unrealized.trade, answered by Playwright from this checkout; no network). WU-06
// (docs/plan1/wallet.md:1045) and the card's risk, in a real browser:
//   1. kill: a tab reserves a deposit index and its renderer is crashed (CDP Page.crash) before the index is used;
//      a new tab gets a new index.
//   2. race: two tabs reserve 50 indices each at once; all 100 differ.
//   3. wrapped: every stored value is { iv, ct } except K_wrap, a non-extractable AES-GCM CryptoKey; no localStorage.
//   4. sign out in one tab closes the other and deletes the database.
// STORE_SRC=<path> runs the same cases on another copy of the store (the planted bad copies of the red runs).
// A Playwright run in headless Chromium. exit 0 all as expected, 1 otherwise.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../../../scripts/browsers.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = process.env.STORE_SRC ?? join(PKG, "src/store/index.ts");
const JS = stripTypeScriptTypes(readFileSync(SRC, "utf8"));
const SIGN = "https://sign.confidential.unrealized.trade";
const SCOPE = "19146924376397433563414578315227104779963410245624609409577613413512870757636";

async function context(browser) {
  const ctx = await browser.newContext();
  await ctx.route(`${SIGN}/**`, (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/store.js") return r.fulfill({ status: 200, contentType: "text/javascript", body: JS });
    return r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>store</title>" });
  });
  return ctx;
}
async function tab(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${SIGN}/`);
  await p.evaluate(async () => {
    const m = await import("/store.js");
    window.__events = [];
    window.__store = await m.openWalletStore({ onEvent: (e) => window.__events.push(e.kind) });
  });
  return p;
}
const reserve = (p, n) =>
  p.evaluate(
    ([scope, n]) => Promise.all(Array.from({ length: n }, () => window.__store.reserveDepositIndex(BigInt(scope)))),
    [SCOPE, n],
  );

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? "ok " : "BAD"} ${name}: ${detail}`);
};

const browser = await launchBrowser("chromium");
try {
  // 1. kill the tab between "counter reserved" and "account used"
  {
    const ctx = await context(browser);
    const a = await tab(ctx);
    const [i] = await reserve(a, 1);
    // the index is out; the tab dies before it derives or uses the account
    const cdp = await ctx.newCDPSession(a);
    await Promise.race([cdp.send("Page.crash").catch(() => {}), new Promise((ok) => setTimeout(ok, 1000))]);
    const crashed = await a.evaluate(() => 1).then(() => false, () => true);
    const b = await tab(ctx);
    const [j] = await reserve(b, 1);
    const lane = await b.evaluate(() => window.__store.lane);
    check("kill between reserve and use", crashed && j !== i && j === i + 8 && i % 8 === lane,
      `tab crashed: ${crashed}; reserved ${i}, after reopen ${j} (lane ${lane})`);
    await ctx.close();
  }
  // 2. two tabs race for one counter
  {
    const ctx = await context(browser);
    const [p, q] = [await tab(ctx), await tab(ctx)];
    const [x, y] = await Promise.all([reserve(p, 50), reserve(q, 50)]);
    const all = [...x, ...y];
    const lane = await p.evaluate(() => window.__store.lane);
    const want = Array.from({ length: 100 }, (_, k) => lane + 8 * k).join();
    check("two tabs race", new Set(all).size === 100 && [...all].sort((m, n) => m - n).join() === want,
      `${new Set(all).size} different values of 100`);
    // 3. what sits in SIGN_HOST's storage
    await p.evaluate(() => window.__store.put("notes", "n1", { value: 5n, tag: "MARKER-plain-text" }));
    const seen = await q.evaluate(async () => {
      const db = await new Promise((ok, no) => {
        const r = indexedDB.open("ct-wallet");
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      const out = { origin: location.origin, localStorage: localStorage.length, cookies: document.cookie, records: [] };
      for (const name of db.objectStoreNames) {
        const tx = db.transaction(name, "readonly");
        const os = tx.objectStore(name);
        const [keys, vals] = await Promise.all(
          [os.getAllKeys(), os.getAll()].map((r) => new Promise((ok) => (r.onsuccess = () => ok(r.result)))),
        );
        keys.forEach((k, n) => {
          const v = vals[n];
          const text = v instanceof CryptoKey ? "" : new TextDecoder("latin1").decode(v.ct);
          out.records.push({
            at: `${name}/${k}`,
            cryptoKey: v instanceof CryptoKey ? { extractable: v.extractable, alg: v.algorithm.name } : null,
            wrapped: !(v instanceof CryptoKey) && Object.keys(v).sort().join() === "ct,iv" && v.iv.length === 12,
            plain: /MARKER|PLANNED|next/.test(text),
          });
        });
      }
      db.close();
      out.note = await window.__store.get("notes", "n1");
      return out;
    });
    const key = seen.records.find((r) => r.at === "meta/k_wrap");
    const others = seen.records.filter((r) => r.at !== "meta/k_wrap");
    check("records wrapped on SIGN_HOST",
      seen.origin === SIGN && seen.localStorage === 0 && seen.cookies === "" && key?.cryptoKey?.extractable === false &&
        key.cryptoKey.alg === "AES-GCM" && others.length >= 3 && others.every((r) => r.wrapped && !r.plain) &&
        seen.note?.value === 5n,
      `origin ${seen.origin}; ${others.length} records all {iv, ct}: ${others.every((r) => r.wrapped && !r.plain)}; ` +
        `K_wrap extractable ${key?.cryptoKey?.extractable}; localStorage ${seen.localStorage}`);
    // 4. sign out in one tab
    await p.evaluate(() => window.__store.signOut());
    await q.waitForTimeout(200);
    const after = await q.evaluate(async () => ({
      events: window.__events,
      closed: await window.__store.get("notes", "n1").then(() => false, (e) => /closed/.test(String(e))),
      dbs: (await indexedDB.databases()).map((d) => d.name),
    }));
    check("sign out", after.events.includes("signout") && after.closed && !after.dbs.includes("ct-wallet"),
      `other tab told: ${after.events.includes("signout")}, closed: ${after.closed}, databases left: [${after.dbs}]`);
    await ctx.close();
  }
} finally {
  console.log(`${browserLabel(browser)}, store ${SRC === join(PKG, "src/store/index.ts") ? "src/store/index.ts" : SRC}`);
  await browser.close();
}
const ok = results.length === 4 && results.every(Boolean);
console.log(`store.e2e: ${ok ? "PASS" : "FAIL"} (${browserLabel(browser)})`);
process.exit(ok ? 0 : 1);
