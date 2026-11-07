#!/usr/bin/env node
// Live check of card app-deposit-mount: the header's Deposit opens the one deposit sheet in the shell, and the sheet runs
// on the kit's deposit calls end to end. APP_HOST's terminal is framed by a stand-in for SIGN_HOST's shell
// (app-in-shell.mjs) that sends one signed-in account with its backup saved and answers the deposit reads as the real
// page answers them after its 1Click reads (H-1c-shaped: deposit.assets, deposit.dry, deposit.quote), then posts the
// deposit's stages under the quote's request id, as the real page does; no check can sign a real account in or send a
// real deposit. Headless Chromium opens /discover at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1),
// dark and light, and reads, in each:
//   - the terminal is inside the shell, and the visible header Deposit (the phone's balance pill with its +) opens the
//     deposit sheet, one sheet only;
//   - the sheet asks deposit.assets, draws the first asset, and typing 15 sends one deposit.dry, with that asset and 15
//     only, whose lines it draws (S4.3, You get $73.18);
//   - Get address sends deposit.quote with the asset and 15 only, and the sheet draws the quote's own address (S4.13)
//     under a heading that names the asset once (NEAR, never NEAR NEAR);
//   - the deposit's stages under that id draw Waiting (S4.14), Processing (S4.15) and Deposited with the credited amount
//     (S4.16), and Done closes the sheet;
//   - Recent reads the account's deposits from state.ops: none under the form before (No activity), and on the done
//     screen the one row Deposited $73.18.
// A screenshot of the quote, the address and the deposited state is kept per width and scheme.
//   node scripts/live-checks/app-deposit-mount.mjs [--shots <dir>] [--record <file>]
//     the deployed APP_HOST (its bytes and headers as served), framed by the stand-in shell
//   node scripts/live-checks/app-deposit-mount.mjs --harness [--build <dir>] [--shots <dir>] [--record <file>]
//     a local build (apps/terminal/dist, or --build <dir>) at APP_HOST's name
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
// Runs: pending app-deposit-mount, it fails on today's deployed app (the header's Deposit opens nothing) until this card deploys
import "../net-window.mjs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { harnessRoute, SIGN_HOST } from "./app-in-shell.mjs";

const KEY = "app-deposit-mount";
export const APP_HOST = "https://confidential.unrealized.trade";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_HOST = "https://api.confidential.unrealized.trade";
/** The signed-in account the stand-in shell sends: backup saved, nothing yet in the vault. */
export const ACCOUNT = { release: "harness-shell", api: 1, signed_in: true, way: "passkey", code_saved: true, vault_balance: "0", wallets: [], positions: [], orders: [], held: [], ops: [] };
/** The deposit reads, in the kit's shapes (messages.ts DepositAsset, DepositDry, SignpageResults["deposit.quote"]). */
export const NEAR = { origin_asset: "nep141:wrap.near", chain: "near", symbol: "NEAR", decimals: 24, min: "2.1", max_usd: "1000" };
const USDC = { origin_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", symbol: "USDC", decimals: 6, min: "1.2", max_usd: "1000" };
export const ADDRESS = "8b0c4e2f61a94d7cb35e0f1a7d29c6e48f5a3b1d07e9c2a64f8d1b5e3a7c9f20";
export const AMOUNT = "15";
export const ANSWERS = {
  "deposit.assets": { assets: [NEAR, USDC] },
  "deposit.dry": { amount_out_usd: "73.18", min_amount_out_usd: "72.45", fee_usd: "0.62", time_estimate_s: 37 },
  // the shell sets the deadline, 72 h from its answer
  "deposit.quote": { deposit_address: ADDRESS, origin_asset: NEAR.origin_asset, amount_in: AMOUNT, min_amount_out: "72.45", time_estimate_s: 37 },
};
export const CREDITED = "73.18";
/** The stages the check posts (each with since_ms 12 s back, and done with the credited amount: the facts the kit allows on each, messages.ts DepositFacts), and the state each draws. */
export const STAGES = [
  [{ stage: "waiting" }, "S4.14"],
  [{ stage: "in_transit" }, "S4.15"],
  [{ stage: "done", amount_usd: CREDITED }, "S4.16"],
];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
export const SCHEMES = ["dark", "light"];
const READY_MS = 15_000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  const want = WIDTHS.flatMap((w) => SCHEMES.map((s) => `${w.name} ${s}`));
  const have = new Set(runs.map((r) => `${r.width} ${r.scheme}`));
  say(want.every((k) => have.has(k)), `${runs.length} run(s) of ${want.length} (every width, dark and light)`);
  for (const r of runs) {
    const n = `${r.width} ${r.scheme}`;
    say(r.framed === true, `${n}: ${r.framed ? "inside SIGN_HOST's shell" : "not inside SIGN_HOST's shell"}`);
    say(r.opened === 1, `${n}: the header's Deposit ${r.opened === 1 ? "opens the deposit sheet" : r.opened ? `opens ${r.opened} deposit sheets` : "opens nothing"}`);
    if (r.opened !== 1) continue;
    say(r.assetsAsked === true, `${n}: the sheet ${r.assetsAsked ? "asks" : "never asks"} deposit.assets`);
    const dry = r.dry ?? [];
    const dryOk = dry.length === 1 && same(dry[0], { origin_asset: NEAR.origin_asset, amount: AMOUNT });
    say(dryOk, `${n}: typing ${AMOUNT} sends ${dry.length} deposit.dry${dry.length ? ` (${dry.map((d) => JSON.stringify(d)).join(", ")})` : ""}, want one with ${NEAR.origin_asset} and ${AMOUNT} only`);
    say(r.quoteState === "S4.3" && r.youGet === "$73.18", `${n}: the dry quote draws ${r.quoteState ?? "no state"}, You get ${r.youGet ?? "nothing"}`);
    const c = r.clear ?? {};
    say(c.ok === true, `${n}: the element at Get address's centre is ${c.first ?? "unread"}, and ${c.under?.length ? `the body's ${c.under.join(", ")} lies under it` : c.ok ? "nothing from the body lies under it" : (c.why ?? "unread")}${c.ok ? "" : ` (${JSON.stringify(c)})`}`);
    const qOk = same(r.quote, { origin_asset: NEAR.origin_asset, amount: AMOUNT });
    say(qOk, `${n}: Get address sends deposit.quote ${r.quote ? JSON.stringify(r.quote) : "nothing"}${!qOk && r.tapGet ? ` (the tap: ${JSON.stringify(r.tapGet)})` : ""}`);
    say(r.addressState === "S4.13" && r.address === ADDRESS, `${n}: the address state ${r.addressState ?? "none"} draws ${r.address === ADDRESS ? "the quote's own address" : (r.address ?? "no address")}`);
    say(same(r.heading, ["NEAR"]), `${n}: the address heading reads ${JSON.stringify(r.heading ?? null)}, the asset once`);
    const want = STAGES.map(([, s]) => s);
    say(same(r.stages, want), `${n}: the deposit's stages draw ${JSON.stringify(r.stages ?? [])}, want ${JSON.stringify(want)}`);
    say(r.credited === CREDITED, `${n}: Deposited draws ${r.credited ?? "no amount"}, credited ${CREDITED}`);
    say(r.recentBefore === 0, `${n}: Recent under the form shows ${r.recentBefore ?? "no block"} row(s), want none (No activity)`);
    say(same(r.recentDone, ["Deposited", "$73.18"]), `${n}: Recent on the done screen reads ${JSON.stringify(r.recentDone ?? null)}, want the deposit's row`);
    say(r.closed === true, `${n}: Done ${r.closed ? "closes the sheet" : "leaves the sheet open"}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

async function terminal(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && originOf(x.url()) === APP_HOST);
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

const asked = (page) => page.evaluate(() => window.__ctShellAsked ?? []);
/** A request's own fields: the message less its v, id and type (the kit's requests carry their params flat). */
const fieldsOf = ({ v: _v, id: _id, type: _t, ...fields }) => fields;
const sheetState = (f) => f.locator("[data-sheet='deposit']").first().getAttribute("data-state", { timeout: 2_000 }).catch(() => null);
const waitState = (f, s) => f.waitForSelector(`[data-sheet='deposit'][data-state='${s}']`, { timeout: 5_000 }).catch(() => null);

async function runOne(browser, w, scheme, shots, route) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, colorScheme: scheme, reducedMotion: "reduce" });
  const run = { width: w.name, scheme, framed: false, opened: 0 };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${w.name}-${scheme}-${name}.png`) });
  try {
    await ctx.route("**/*", route);
    const page = await ctx.newPage();
    await page.goto(`${APP_HOST}/discover`, { waitUntil: "load" });
    const f = await terminal(page);
    run.framed = f !== null && originOf(page.url()) === SIGN_HOST;
    if (!f) return run;
    await f.waitForSelector(".tb [data-action='deposit']:not([disabled]), .phh [data-action='deposit']:not([disabled])", { timeout: READY_MS }).catch(() => {});
    await f.locator("[data-action='deposit']").filter({ visible: true }).first().click({ timeout: 5_000 }).catch(() => {});
    await f.waitForSelector("[data-sheet='deposit']", { timeout: 3_000 }).catch(() => {});
    run.opened = await f.locator("[data-sheet='deposit']").filter({ visible: true }).count();
    if (run.opened !== 1) return run;

    // the assets answered: the amount field is on; two keys typed inside the dry quote's pause
    await f.waitForSelector("[data-sheet='deposit'] [data-field='amount']:not([disabled])", { timeout: 5_000 }).catch(() => {});
    run.assetsAsked = (await asked(page)).some((m) => m.type === "deposit.assets");
    await f.locator("[data-field='amount']").filter({ visible: true }).first().pressSequentially(AMOUNT, { delay: 60, timeout: 3_000 }).catch(() => {});
    await f.waitForSelector("[data-sheet='deposit'][data-state='S4.3'] .dget .v .num", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(600);
    run.dry = (await asked(page)).filter((m) => m.type === "deposit.dry").map(fieldsOf);
    run.quoteState = await sheetState(f);
    run.recentBefore = Number(await f.locator("[data-sheet='deposit'] [data-recent]").first().getAttribute("data-recent", { timeout: 1_000 }).catch(() => "NaN"));
    run.youGet = await f.locator("[data-sheet='deposit'] .dget .v .num").first().textContent({ timeout: 1_000 }).catch(() => null);
    await shot(page, "quote");

    // the action's box is its own (CI's phone run on 4d2b3dee: the focused amount field took the Get address tap): with
    // the button scrolled into view, the element at its centre is the button, and at its centre and four inner corners
    // nothing from the sheet's body lies under it, on top or beneath; the boxes and scroll offsets say where they sat
    run.clear = await f.evaluate(() => {
      const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}` : null);
      const box = (e) => { const q = e?.getBoundingClientRect(); return q ? [q.x, q.y, q.width, q.height].map(Math.round) : null; };
      const sheet = document.querySelector("[data-sheet='deposit']");
      const b = sheet?.querySelector("[data-control='deposit-get']");
      const body = sheet?.querySelector(".dbody");
      if (!b || !body) return { ok: false, why: "no button or body" };
      b.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = b.getBoundingClientRect();
      const pts = [[0.5, 0.5], [0.05, 0.1], [0.95, 0.1], [0.05, 0.9], [0.95, 0.9]].map(([x, y]) => [r.x + r.width * x, r.y + r.height * y]);
      const first = document.elementsFromPoint(...pts[0])[0] ?? null;
      const under = [...new Set(pts.flatMap((p) => document.elementsFromPoint(...p).filter((e) => body.contains(e)).map(name)))];
      const scrolled = [...sheet.querySelectorAll("*"), document.scrollingElement].filter((e) => e && (e.scrollTop || e.scrollLeft)).map((e) => `${name(e)} ${e.scrollLeft},${e.scrollTop}`);
      return { ok: (first === b || b.contains(first)) && under.length === 0, first: first === b || b.contains(first) ? "the button" : name(first), under, button: box(b), body: box(body), foot: box(b.closest(".dfoot")), sheet: box(sheet.querySelector(".dep-box")), input: box(sheet.querySelector("[data-field='amount']")), scrolled };
    }).catch((e) => ({ ok: false, why: String(e?.message ?? e).split("\n")[0] }));

    // what the tap meets: the button's box, whether it is on, the element at its centre, and the tap's own error, so a
    // tap that sends nothing says why
    run.tapGet = await f.evaluate(() => {
      const b = document.querySelector("[data-sheet='deposit'] [data-control='deposit-get']");
      const r = b?.getBoundingClientRect();
      const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}` : null);
      return { box: r ? [r.x, r.y, r.width, r.height].map(Math.round) : null, view: [innerWidth, innerHeight], disabled: b?.disabled ?? null, hit: at === b || (b && b.contains(at)) ? "the button" : name(at) };
    });
    // and whether it holds still (the tap waits for one box over two frames): its box on each of eight frames, the
    // frames counted in 500 ms, and the document's scroll box against the viewport (a scrollbar that comes and goes
    // moves everything)
    Object.assign(run.tapGet, await f.evaluate(async () => {
      const b = document.querySelector("[data-sheet='deposit'] [data-control='deposit-get']");
      const frames = [];
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const r = b?.getBoundingClientRect();
        const d = document.documentElement;
        frames.push(r ? `${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)} doc ${d.clientWidth}x${d.clientHeight}/${d.scrollWidth}x${d.scrollHeight} vv ${visualViewport?.width}x${visualViewport?.height}` : null);
      }
      let n = 0;
      const t0 = performance.now();
      await new Promise((done) => { const step = () => (performance.now() - t0 < 500 ? (n++, requestAnimationFrame(step)) : done()); requestAnimationFrame(step); });
      return { frames: [...new Set(frames)], framesIn500ms: n, active: document.activeElement?.tagName.toLowerCase() ?? null };
    }).catch((e) => ({ frames: `unread: ${String(e?.message ?? e).split("\n")[0]}` })));
    // where the tap really lands: the top window's viewports and scroll, and each press the terminal's frame receives
    // (its point and target), read before and after the tap, since the element under the button's centre was the button
    // while CI's tap reached the amount field
    const views = () => page.evaluate(() => ({ scroll: [scrollX, scrollY], vv: visualViewport && [visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.pageTop, visualViewport.width, visualViewport.height, visualViewport.scale] })).catch(() => null);
    run.tapGet.topBefore = await views();
    await f.evaluate(() => {
      window.__ctPress = [];
      const name = (e) => (e ? `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}` : null);
      for (const t of ["pointerdown", "mousedown", "touchstart"]) addEventListener(t, (e) => { const p = e.touches?.[0] ?? e; window.__ctPress.push(`${t} ${Math.round(p.clientX)},${Math.round(p.clientY)} ${name(e.target)} vv ${visualViewport?.offsetTop},${visualViewport?.pageTop},${visualViewport?.scale}`); }, { capture: true });
    }).catch(() => {});
    run.tapGet.error = await f.locator("[data-control='deposit-get']").filter({ visible: true }).first().click({ timeout: 3_000 }).then(() => null, (e) => [...new Set(String(e?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean))].slice(0, 40).join(" | "));
    if (run.tapGet.error) {
      run.tapGet.topAfter = await views();
      Object.assign(run.tapGet, await f.evaluate(async () => {
        const b = document.querySelector("[data-sheet='deposit'] [data-control='deposit-get']")?.getBoundingClientRect();
        let n = 0;
        const t0 = performance.now();
        await Promise.race([new Promise((done) => { const step = () => (performance.now() - t0 < 500 ? (n++, requestAnimationFrame(step)) : done()); requestAnimationFrame(step); }), new Promise((done) => setTimeout(done, 1_000))]);
        return { presses: window.__ctPress ?? null, boxAfter: b ? [b.x, b.y, b.width, b.height].map(Math.round) : null, framesAfter: n, activeAfter: document.activeElement?.tagName.toLowerCase() ?? null };
      }).catch((e) => ({ presses: `unread: ${String(e?.message ?? e).split("\n")[0]}` })));
    }
    await waitState(f, "S4.13");
    run.quote = (await asked(page)).filter((m) => m.type === "deposit.quote").map(fieldsOf)[0] ?? null;
    run.addressState = await sheetState(f);
    run.address = await f.locator("[data-sheet='deposit'] [data-address]").first().getAttribute("data-address", { timeout: 1_000 }).catch(() => null);
    run.heading = await f.locator("[data-sheet='deposit'] .addrb .ca > span").allTextContents().catch(() => null);
    await shot(page, "address");

    run.stages = [];
    for (const [facts, want] of STAGES) {
      await page.evaluate((x) => window.__ctShellPush({ ...x, since_ms: Date.now() - 12_000 }), facts);
      await waitState(f, want);
      run.stages.push(await sheetState(f));
    }
    run.credited = await f.locator("[data-sheet='deposit'] [data-amount]").first().getAttribute("data-amount", { timeout: 1_000 }).catch(() => null);
    run.recentDone = await f.locator("[data-sheet='deposit'] .drecent .it").first().locator("span").allTextContents().catch(() => null);
    await shot(page, "deposited");
    await f.locator("[data-control='deposit-done']").filter({ visible: true }).first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(300);
    run.closed = (await f.locator("[data-sheet='deposit']").count()) === 0;
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width and scheme in Chromium. `route` answers the hosts' names (see main). */
export async function collect({ shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), route, source }) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) for (const s of SCHEMES) runs.push(await runOne(browser, w, s, shots, route));
    return { check: KEY, at: new Date().toISOString(), source, browser: browser.version(), shots, runs };
  } finally {
    await browser.close();
  }
}

/** The stand-in shell with ACCOUNT and the deposit reads; APP_HOST from `build`, or with no build the deployed APP_HOST and helper as served. */
export async function routeFor(build = null) {
  // the deployed run reads only the shell from the stand-in; its _headers come from the source tree's (the shell's own)
  const shell = await harnessRoute(build ?? path.join(REPO, "apps/terminal/public"), "signed", { state: ACCOUNT, answers: ANSWERS });
  if (build) return shell;
  return (r) => {
    const o = originOf(r.request().url());
    return o === APP_HOST || o === HELPER_HOST ? r.continue() : shell(r);
  };
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    let build = null;
    let source = `live ${APP_HOST}, the stand-in shell signed in`;
    if (a.includes("--harness")) {
      build = path.resolve(opt("--build", path.join(REPO, "apps/terminal/dist")));
      const rel = path.relative(REPO, build);
      source = `harness, terminal build ${rel && !rel.startsWith("..") ? rel : build}, the stand-in shell signed in`;
    }
    const rec = await collect({ shots: opt("--shots", undefined), route: await routeFor(build), source });
    const file = opt("--record", null);
    // the record leaves out where this machine kept the shots
    if (file) writeFileSync(file, `${JSON.stringify({ ...rec, shots: undefined }, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
