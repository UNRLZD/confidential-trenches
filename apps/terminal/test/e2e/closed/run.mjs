#!/usr/bin/env node
// Portfolio's closed positions from a device's trade ops, in H-app (card closed-positions-show-every-trade). The real
// terminal and signing page builds on the shipped names (startHarness realNames); the browser reaches no real host.
// Each width signs in the passkey way (a virtual authenticator with PRF), then writes the device store's trade ops as the
// signing page writes them (OPS below: the op records this card's tests write for the 13 Nov round trips, a Solana pool
// buy and its sale at 18:05Z rebuilt from their transactions, and a Robinhood CASHCAT buy and its sale at 21:05Z and
// 21:06Z written back from the pool's events), each sealed with the store's own key as packages/wallet/src/store
// seals a record (AES-GCM, additional data "ops/<key>"), tells the page's store channel, opens Portfolio and its
// Closed tab, and shoots it. No USD: the harness reads no price, so each side's dollars are a dash.
//   node apps/terminal/test/e2e/closed/run.mjs [--shots <dir>]
//     PASS exit 0 (both widths show two closed positions), FAIL exit 1, error exit 2
// Needs the terminal's build (pnpm --filter terminal build), the signing page's (packages/signpage scripts/build-app.mjs)
// and the installed Chrome (scripts/browsers.mjs).
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addAuthenticator, HOSTS, REAL, startHarness } from "../../harness/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the two coins: CASHCAT on Robinhood, and the Solana pool's coin of 13 Nov 18:05Z
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const MIHAO = "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump";
/** The device's trade ops, by store key, as this card's tests write them (test/closed-pieces-buy.test.ts and
 *  test/restore-evm-trades.test.ts in packages/signpage). */
const OPS = {
  "restored/2tmaLQqaDnKHY5v4cMmVRQY1WR5KCQo2LbzDX7rRfYTJden29RSgtPPRa5Esa3suUbr6QsagMCpAzyqRVk2RN7v8": {"kind": "sell", "stage": "filled", "txs": [{"chain": "solana", "hash": "2tmaLQqaDnKHY5v4cMmVRQY1WR5KCQo2LbzDX7rRfYTJden29RSgtPPRa5Esa3suUbr6QsagMCpAzyqRVk2RN7v8"}], "created_ms": 1794593139000, "chain": "solana", "units": "32.828936", "pool_amount": "0.006193354", "token": MIHAO},
  "restored/55LqP9PDVU5foK5kvKbfDRHDJN8zeNW9pLXwnutmQefJtXDc2wmkoXqhg32TPZSUr3utn9yaAQAYw247n5MyMcBs": {"kind": "buy", "stage": "filled", "txs": [{"chain": "solana", "hash": "55LqP9PDVU5foK5kvKbfDRHDJN8zeNW9pLXwnutmQefJtXDc2wmkoXqhg32TPZSUr3utn9yaAQAYw247n5MyMcBs"}], "created_ms": 1794593121000, "chain": "solana", "units": "32.828936", "pool_amount": "0.006261988", "token": MIHAO},
  "trade/robinhood/0xd55fa259c2122c23fb906ee25de6b55edc58aa2c1fd2abf1149adf62fb09c6df": {"kind": "buy", "stage": "filled", "txs": [{"chain": "robinhood", "hash": "0xd55fa259c2122c23fb906ee25de6b55edc58aa2c1fd2abf1149adf62fb09c6df"}], "created_ms": 1794603912000, "chain": "robinhood", "units": "78.20499874395625728", "pool_amount": "0.00194", "token": CASHCAT},
  "trade/robinhood/0x6de337eda1b3bcecc05171709977929b7585f84a458e4933cd2d3205fb867a83": {"kind": "sell", "stage": "filled", "txs": [{"chain": "robinhood", "hash": "0x6de337eda1b3bcecc05171709977929b7585f84a458e4933cd2d3205fb867a83"}], "created_ms": 1794604000000, "chain": "robinhood", "pool_amount": "0.001880137434291065", "token": CASHCAT},
};
const WAIT_MS = 60_000;
export const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];

async function oneWidth(h, w, shots) {
  const { context } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await addAuthenticator(page, { hasPrf: true });
  const app = page.frameLocator("iframe#app");
  const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
  const top = (sel) => page.locator(sel).first();
  const tap = (loc) => (w.hasTouch ? loc.tap() : loc.click());
  await page.goto(`https://${REAL.app}/discover`, { waitUntil: "commit" });
  await page.waitForURL((u) => u.hostname === REAL.sign, { timeout: WAIT_MS });
  await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
  // sign in, the passkey way
  await tap(vis('[data-header="S1.1"] button, button[data-header="S1.1"]'));
  await tap(vis('.sgn-opt[data-way="passkey"]'));
  await tap(top('#screen:not([hidden]) #signin[data-signin="signed-out"] button[data-action="create"]'));
  await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
  await vis('[data-header="S1.3"], [data-header="S1.4"]').waitFor({ timeout: WAIT_MS });
  // the device's trade ops, sealed as the store seals them, on SIGN_HOST's own page
  const wrote = await page.evaluate(async (ops) => {
    const req = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
    const db = await req(indexedDB.open("ct-wallet", 1));
    const k = await req(db.transaction("meta", "readonly").objectStore("meta").get("k_wrap"));
    let n = 0;
    for (const [key, op] of Object.entries(ops)) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`ops/${key}`) }, k, new TextEncoder().encode(JSON.stringify(op)));
      await req(db.transaction("ops", "readwrite").objectStore("ops").put({ iv, ct }, key));
      n++;
    }
    db.close();
    new BroadcastChannel("ct-wallet").postMessage({ kind: "changed", stores: ["ops"] });
    return n;
  }, OPS);
  // Portfolio, its Closed tab
  await tap(vis('a[href="/portfolio"]'));
  await tap(vis('[data-control="closed"]'));
  const rows = app.locator("[data-closed] >> visible=true");
  await rows.nth(1).waitFor({ timeout: WAIT_MS }).catch(() => {});
  await page.waitForTimeout(1500);
  const n = await rows.count();
  const file = path.join(shots, `closed-${w.name}.png`);
  await page.screenshot({ path: file });
  await context.close();
  return { width: w.name, wrote, closed: n, file };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--shots");
  const shots = path.resolve(i > 0 ? process.argv[i + 1] : path.join(HERE, "shots"));
  mkdirSync(shots, { recursive: true });
  let code = 2;
  try {
    const h = await startHarness({ realNames: true, edit: (sites) => (sites[HOSTS.sign].spa = true) });
    const out = [];
    try {
      for (const w of WIDTHS) out.push(await oneWidth(h, w, shots));
    } finally {
      await h.close();
    }
    for (const r of out) console.log(`${r.closed === 2 && r.wrote === 4 ? "ok " : "BAD"} ${r.width}: ${r.wrote} ops written, ${r.closed} closed positions shown: ${r.file}`);
    code = out.every((r) => r.closed === 2 && r.wrote === 4) ? 0 : 1;
    console.log(code === 0 ? "PASS" : "FAIL");
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.stack : String(e)}`);
  }
  process.exit(code);
}
