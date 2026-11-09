#!/usr/bin/env node
// The first run's sign-in, end to end, in H-app (card app-harness-signin-e2e; app.md 5.2 AE-01, AE-05, AS-01, and the
// launch rule of app.md 5.0's passkey row). The real hosts: APP_HOST serves the terminal's build and SIGN_HOST the
// signing page's build, each under its own _headers, on the shipped names (startHarness realNames), so the terminal
// runs framed in SIGN_HOST's shell as it does live and every screen of SIGN_HOST is its own top-level page.
//
// Three launches, each its own browser with at most one internal virtual authenticator at a time (app.md:1312):
//   prf     branch P (app.md 2.7.2) to the signed-in empty account: FR-P0 Discover signed out and READY, FR-P1 the
//           sign-in sheet, FR-P2 the passkey way (two taps send one signin.open), FR-P3 SIGN_HOST's passkey page, the
//           create with PRF (prf.enabled read on the create itself), FR-P4 the layer closes with no SIGN_HOST screen
//           after the sheet, FR-P5 the same route with S1.3 and the backup dot.
//   no-prf  branch N (app.md 2.7.3) with hasPrf false: the same up to the create, then FR-N4 the 12 words on SIGN_HOST
//           (counted, never read; masked in the shot), Saved, FR-N5 back, FR-N6 S1.3 with no backup dot.
//   wallet  the wallet way as SIGN_HOST builds it today (wallet.md:50, OD:349): FR-W1 the sheet with the wallet second,
//           the two choices with New account drawn and not offered (data-pending="wallet-signature"), I already have
//           one, Recovery code, the published all-zero test vector typed (packages/wallet/test/vectors/a8.json), back
//           to S1.3. The wallet signature itself has no code on SIGN_HOST yet, so FR-W2 to FR-W5 cannot run.
// Each launch runs at 390 x 844 (dpr 2, touch) and 1440 x 900 (dpr 1), each width in a fresh context (a new device).
//
// Per step it records (AE-05): a CDP screencast in png (blank frames, white flashes, BAR-03), every layout shift of
// every document with its host (BAR-04: CLS per page at most 0.1, and 0 inside a step on a READY APP_HOST page), the
// header's and the shell's boxes before the first tap and after the return (BAR-02, BAR-05's 1 px), the time from the
// passkey create (or the last tap on SIGN_HOST) to the first paint of the signed-in header (BAR-06, 2,500 ms), the
// context's pages (BAR-01), the taps (BAR-07), every message the app sent the shell, and CSP violations in any frame.
// AS-01: one shot per frame and width, fr-<frame>-<state id>-<width>.png, read back from disk: a missing file fails.
//
//   node apps/terminal/test/e2e/signin/run.mjs [--runs prf,no-prf,wallet] [--shots <dir>] [--record <file>]
//     [--plant jump | missing-frame | prf-off] [--cpu <rate>]   --cpu 4 slows the page's CPU 4x (CDP
//     Emulation.setCPUThrottlingRate), a slower device than the machine running it      PASS exit 0, FAIL exit 1, error exit 2
// Needs the terminal's build (pnpm --filter terminal build) and Playwright's Chromium. --plant breaks one thing on
// purpose so the run shows it red: jump moves the page 48 px inside the sign-in step, missing-frame drops FR-P1's shot,
// prf-off gives the prf launch an authenticator with no PRF.
// Records hold states, counts, times and boxes only: never the 12 words, a key or a PRF output.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addAuthenticator, cdpFor, HOSTS, REAL, startHarness } from "../../harness/harness.mjs";
import { framePixels } from "./png.mjs";

export const RUNS = ["prf", "no-prf", "wallet"];
export const PLANTS = ["jump", "missing-frame", "prf-off"];
export const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
/** The route the run starts on and must land on again (FR-P0, BAR-02). */
export const ROUTE = "/discover";
/** The frames each launch shoots, in order: AS-01 counts these files on disk. */
export const FRAMES = {
  prf: ["P0-S5.6", "P1-S2.1", "P2-hop", "P3-S2.2", "P4-hop", "P5-S1.3"],
  "no-prf": ["P0-S5.6", "P1-S2.1", "P2-hop", "P3-S2.2", "N4-S3.1", "N5-hop", "N6-S1.3"],
  wallet: ["P0-S5.6", "W1-S2.1", "W2-choose", "W2-existing", "W2-words", "W6-hop", "W7-S1.3"],
};
/** The bounds (app.md 2.7.1). */
export const BOUND = {
  blankMs: 100, // BAR-03
  clsPage: 0.1, // BAR-04 per page load
  boxPx: 1, // BAR-05
  scrollPx: 2, // BAR-02
  landMs: 2_500, // BAR-06
  readyMs: 5_000, // BAR-09, cold
  taps: { prf: 3, "no-prf": 4, wallet: 5 },
};
// BAR-07: 2 taps in the app (sign in, the passkey way) and the one action of SIGN_HOST's page (Create passkey); no-PRF
// adds Saved; the wallet way as built: sign in, wallet, I already have one, Recovery code, Continue.
const GUARD_MS = 600; // past SIGN_HOST's 500 ms activation guard on Saved (packages/signpage/src/guard.ts)
const SETTLE_MS = 800;
const WAIT_MS = 15_000;
const VECTOR_WORDS = `${"abandon ".repeat(11)}about`; // entropy 00..00, packages/wallet/test/vectors/a8.json

// ------------------------------------------------------------------------------------------------ the verdict
/** One launch's verdict lines from what run() recorded (its shots as listed on disk after the run). */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const w of rec.widths ?? []) {
    const at = `${rec.run} @${w.width}`;
    if (w.error) say(false, `${at}: ${w.error}`);
    // the passkey: PRF read on the create itself (app.md:1318)
    if (rec.run !== "wallet") {
      const c = w.creates ?? [];
      const wantPrf = rec.run === "prf";
      say(c.length === 1 && c[0].prfAsked === true && c[0].rpId === REAL.sign, `${at} one create, rp ${c[0]?.rpId ?? "none"}, PRF asked ${c[0]?.prfAsked ?? "-"}`);
      say(c.length === 1 && c[0].prf === wantPrf, `${at} prf.enabled on the create: ${c[0]?.prf ?? "none"} (want ${wantPrf})`);
    }
    const seen = w.signinStates ?? [];
    if (rec.run === "prf") say(!seen.includes("backup") && seen.at(-1) === "signed-in", `${at} SIGN_HOST: ${seen.join(" > ")} (no screen after the sheet, FR-P4)`);
    if (w.error) continue;
    // AS-01: every frame on disk, in order of the flow
    const want = FRAMES[rec.run].map((f) => `fr-${f}-${w.width}.png`);
    const missing = want.filter((f) => !(w.shots ?? []).includes(f));
    say(missing.length === 0, `${at} AS-01 shots: ${missing.length ? `missing ${missing.join(", ")}` : `${want.length} of ${want.length}`}`);
    const reached = w.frames ?? [];
    say(reached.join() === FRAMES[rec.run].join(), `${at} frames reached in order: ${reached.join(" > ") || "none"}`);

    if (rec.run === "wallet") {
      say((w.creates ?? []).length === 0, `${at} no passkey made on the wallet way (${(w.creates ?? []).length})`);
      say(w.newAccount === "wallet-signature", `${at} New account drawn and not offered: ${w.newAccount ?? "not drawn"}`);
    }
    if (rec.run === "no-prf") say(seen.includes("backup") && w.words === 12 && seen.at(-1) === "signed-in", `${at} SIGN_HOST: ${seen.join(" > ")}, ${w.words ?? 0} words drawn (FR-N4)`);
    if (rec.run === "wallet") say(["choose", "existing", "words"].every((s) => seen.includes(s)) && seen.at(-1) === "signed-in", `${at} SIGN_HOST: ${seen.join(" > ")}`);

    // the signed-in landing (FR-P5, FR-N6, FR-W7)
    const l = w.landing ?? {};
    const dot = rec.run === "prf";
    say(l.header === "S1.3", `${at} landed header ${l.header ?? "none"} (want S1.3)`);
    // the wallet way's "I already have one" restores an account, so the sheet may stay on its restore (S19,
    // SigninSheet.tsx): a build that pins a pool scans it (the mainnet Solana pin, card sol-pools-mainnet-pin), and the
    // harness reaches no RPC, so the landing reads it scanning (S19.1) or stalled (S19.5); any other open sheet, or a
    // restore on a new account's way, is a sheet left open
    const restore = rec.run === "wallet" && l.sheet === 1 && /^S19\.[1-5]$/.test(l.sheetState ?? "");
    say(l.sheet === 0 || restore, restore ? `${at} the sign-in sheet shows the restore (${l.sheetState})` : `${at} the sign-in sheet closed (${l.sheet ?? "-"}${l.sheet ? `, ${l.sheetState ?? "no state"}` : ""})`);
    if (w.width === "1440") say(l.dot === dot, `${at} backup dot ${l.dot} (want ${dot})`);
    // BAR-02: same route and scroll, in the top window and the frame
    say(l.topPath === ROUTE && l.framePath === ROUTE, `${at} BAR-02 route: top ${l.topPath}, frame ${l.framePath}`);
    say(Math.abs(l.scrollY ?? 99) <= BOUND.scrollPx, `${at} BAR-02 scroll ${l.scrollY}`);
    // BAR-05: the page behind keeps its boxes across the round trip
    for (const k of ["header", "shell"]) {
      const a = w.boxes?.before?.[k];
      const b = w.boxes?.after?.[k];
      const d = a && b ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : null;
      say(d !== null && d <= BOUND.boxPx, `${at} BAR-05 ${k} box ${a ? a.join(",") : "none"} -> ${b ? b.join(",") : "none"}${d === null ? "" : ` (delta ${d.toFixed(1)})`}`);
    }
    // BAR-01: one page from first frame to last
    say(w.pages === 1, `${at} BAR-01 pages ${w.pages}`);
    // BAR-03: no blank frame over 100 ms in any step's transition and no white flash, from READY to the end
    const b = w.blank ?? {};
    say(b.frames > 0 && b.white === 0, `${at} BAR-03 ${b.frames ?? 0} frames, white flashes ${b.white ?? "-"}`);
    for (const s of b.steps ?? []) say(s.blankMs <= BOUND.blankMs, `${at} BAR-03 step ${s.step}: ${s.ms} ms to the next screen, blank ${s.blankMs} ms${s.colour ? ` (${s.colour})` : ""}`);
    for (const r of b.resting ?? []) lines.push(`note ${at} BAR-03 screen ${r.screen} rests near empty (${(r.oneColour * 100).toFixed(1)}% one colour) for ${r.ms} ms`);
    for (const r of b.signhost ?? []) lines.push(`note ${at} BAR-03 SIGN_HOST screen ${r.screen} near empty (${(r.oneColour * 100).toFixed(1)}% one colour) for ${r.ms} ms`);
    if (b.hops?.length) lines.push(`note ${at} BAR-03 hop back: the app's first paint ${b.hops.join(", ")} ms after SIGN_HOST's layer closed`);
    // BAR-04: CLS per page load, and none inside a step on a READY APP_HOST page
    for (const p of w.cls?.pages ?? []) say(p.sum <= BOUND.clsPage, `${at} BAR-04 CLS ${p.host}${p.top ? " (top)" : ""} doc ${p.doc}: ${p.sum.toFixed(4)}${p.sum > 0 && p.sources?.length ? ` (${p.sources.join("; ")})` : ""}`);
    for (const s of w.cls?.steps ?? []) say(s.sum === 0, `${at} BAR-04 CLS in step ${s.step}: ${s.sum.toFixed(4)}`);
    // BAR-06: the last action to the first paint of the signed-in header
    say(typeof w.landMs === "number" && w.landMs <= BOUND.landMs, `${at} BAR-06 to signed in: ${w.landMs ?? "-"} ms`);
    // BAR-07: taps
    say(w.taps <= BOUND.taps[rec.run], `${at} BAR-07 taps ${w.taps} (at most ${BOUND.taps[rec.run]})`);
    // BAR-09: READY
    say(typeof w.readyMs === "number" && w.readyMs <= BOUND.readyMs, `${at} BAR-09 READY ${w.readyMs ?? "-"} ms after the terminal's start`);
    // FR-P2: a double tap sends one signin.open
    const opens = (w.messages ?? []).filter((m) => m === "signin.open").length;
    say(opens === 1, `${at} FR-P2 signin.open sent ${opens} time(s) for ${w.doubleTap ? "a double tap" : "one tap"}`);
    say((w.csp ?? []).length === 0, `${at} CSP violations: ${(w.csp ?? []).map((v) => `${v.host} ${v.directive} ${v.blocked}`).join("; ") || "none"}`);
  }
  if (!(rec.widths ?? []).length) say(false, `${rec.run}: no width ran`);
  return { ok: lines.length > 0 && !lines.some((l) => l.startsWith("BAD")), lines };
}

// ------------------------------------------------------------------------------------------------ the browser side
// Before any page script, in every document of the context: its layout shifts, READY, the signed-in header's first
// paint, SIGN_HOST's own screen states, the create's PRF flag (wrapped, the credential passed on untouched), the
// messages the shell hears, and CSP violations, each reported through the __ct binding with an epoch time.
const PROBE = ({ sign, app, plant }) => {
  const report = (e) => {
    try {
      /** @type {any} */ (window).__ct({ ...e, doc, host: location.hostname, top: window.top === window });
    } catch {}
  };
  const doc = Math.random().toString(36).slice(2, 8);
  const now = () => performance.timeOrigin + performance.now();
  report({ kind: "doc", t: performance.timeOrigin });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        // what moved, for the report: each source's element and its box before and after
        const sources = (/** @type {any} */ (e).sources ?? []).map((x) => {
          const n = x.node;
          const name = n ? `${n.nodeName.toLowerCase()}${n.id ? `#${n.id}` : ""}${typeof n.className === "string" && n.className ? `.${n.className.split(" ").join(".")}` : ""}` : "?";
          const r = (b) => [b.x, b.y, b.width, b.height].map(Math.round).join(",");
          return `${name} ${r(x.previousRect)} -> ${r(x.currentRect)}`;
        });
        report({ kind: "shift", t: performance.timeOrigin + e.startTime, value: /** @type {any} */ (e).value, sources });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  addEventListener("securitypolicyviolation", (e) => report({ kind: "csp", t: now(), directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 80) }));
  if (location.hostname === sign && window.top === window) {
    addEventListener("message", (e) => e.data && typeof e.data.type === "string" && report({ kind: "msg", t: now(), type: e.data.type }), true);
    const cc = navigator.credentials;
    if (cc) {
      const create = cc.create.bind(cc);
      cc.create = async (o) => {
        const c = await create(o);
        report({ kind: "create", t: now(), rpId: o?.publicKey?.rp?.id ?? null, prfAsked: !!o?.publicKey?.extensions?.prf, prf: c?.getClientExtensionResults?.().prf?.enabled === true });
        return c;
      };
    }
  }
  let ready = false;
  let landed = false;
  let signin = null;
  let layer = false;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) report({ kind: "paint", name: e.name, t: performance.timeOrigin + e.startTime });
    }).observe({ type: "paint", buffered: true });
  } catch {}
  const look = () => {
    // SIGN_HOST's layer (its own screens over the app's frame), open or hidden
    if (location.hostname === sign && window.top === window) {
      const open = document.getElementById("screen")?.hidden === false;
      if (open !== layer) {
        layer = open;
        report({ kind: "layer", t: now(), open });
      }
    }
    if (location.hostname === app && !ready && document.documentElement?.dataset.signpage === "ready") {
      ready = true;
      report({ kind: "ready", t: now() });
    }
    if (location.hostname === app && !landed && document.querySelector('[data-header="S1.3"],[data-header="S1.4"]')) {
      landed = true;
      requestAnimationFrame(() => report({ kind: "landed", t: now() }));
    }
    const s = location.hostname === sign && window.top === window ? document.getElementById("signin")?.dataset.signin ?? null : null;
    if (s && s !== signin) {
      signin = s;
      report({ kind: "signin", t: now(), state: s });
    }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-signpage", "data-header", "data-signin", "hidden"] });
  // the planted jump: 48 px pushed in above the page just after the sign-in tap, inside the step
  if (plant === "jump" && location.hostname === app) {
    addEventListener(
      "click",
      (e) => {
        if (!(e.target instanceof Element) || !e.target.closest('[data-header="S1.1"]')) return;
        setTimeout(() => {
          const d = document.createElement("div");
          d.style.height = "48px";
          document.querySelector(".shell")?.prepend(d);
        }, 50);
      },
      true,
    );
  }
};

async function oneWidth(h, runName, w, { plant, shotDir, cpu }) {
  const out = { width: w.name, frames: [], shots: [], taps: 0, doubleTap: false };
  const shotsAt = [];
  const { context, rec } = await h.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch, reducedMotion: "reduce" });
  const events = [];
  await context.exposeBinding("__ct", (_src, e) => events.push(e));
  await context.addInitScript(PROBE, { sign: REAL.sign, app: REAL.app, plant });
  const page = await context.newPage();
  const cdp = await cdpFor(page);
  // --cpu N: the page's CPU slowed N times (a slower device than the runner), for every document of the tab
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const hasPrf = runName === "prf" ? plant !== "prf-off" : false;
  const auth = runName === "wallet" ? null : await addAuthenticator(page, { hasPrf });
  const cast = [];
  cdp.on("Page.screencastFrame", (f) => {
    cast.push({ t: (f.metadata.timestamp ?? 0) * 1000, png: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: 390, maxHeight: 900, everyNthFrame: 1 });

  const marks = [];
  const mark = (step) => marks.push({ step, t: Date.now() });
  // a step's transition runs from its tap to the arrival of the screen it leads to (BAR-03's step change or hop)
  const arrivals = [];
  const arrived = () => arrivals.push(Date.now());
  const app = page.frameLocator("iframe#app");
  const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
  const top = (sel) => page.locator(sel).first();
  const tap = async (loc) => {
    out.taps += 1;
    if (w.hasTouch) await loc.tap();
    else await loc.click();
  };
  const shot = async (frame, mask = []) => {
    out.frames.push(frame);
    shotsAt.push({ frame, t: Date.now() });
    const file = `fr-${frame}-${w.name}.png`;
    if (plant === "missing-frame" && frame === "P1-S2.1") return;
    await page.screenshot({ path: path.join(shotDir, file), mask });
  };
  const boxes = () =>
    app.locator(":root").evaluate(() => {
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10);
      };
      const header = [...document.querySelectorAll("header.tb, header.phh")].find((e) => e.getClientRects().length && getComputedStyle(e).display !== "none");
      return { header: r(header), shell: r(document.querySelector(".shell")) };
    });

  try {
    // FR-P0: APP_HOST top-level moves to the shell, which frames it; Discover signed out, READY
    const t0 = Date.now();
    await page.goto(`https://${REAL.app}${ROUTE}`, { waitUntil: "commit" });
    await page.waitForURL((u) => u.hostname === REAL.sign, { timeout: WAIT_MS });
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: WAIT_MS });
    const signIn = vis('[data-header="S1.1"] button, button[data-header="S1.1"]');
    await signIn.waitFor({ timeout: WAIT_MS });
    await page.waitForTimeout(SETTLE_MS);
    mark("P0");
    await shot("P0-S5.6");
    out.boxes = { before: await boxes() };
    const startT = events.find((e) => e.kind === "doc" && e.host === REAL.app && !e.top)?.t ?? t0;
    out.readyMs = (() => {
      const r = events.find((e) => e.kind === "ready");
      return r ? Math.round(r.t - startT) : null;
    })();

    // FR-P1 / FR-W1: the sheet
    mark("signin");
    await tap(signIn);
    await vis('.sgn[data-state="S2.1"] .sgn-box').waitFor({ timeout: WAIT_MS });
    arrived();
    await page.waitForTimeout(400);
    await shot(runName === "wallet" ? "W1-S2.1" : "P1-S2.1");

    if (runName !== "wallet") {
      // FR-P2: the passkey way, tapped twice 40 ms apart; one signin.open must go
      const opt = vis('.sgn-opt[data-way="passkey"]');
      const box = await opt.boundingBox();
      if (!box) throw new Error("the passkey way has no box");
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      mark("passkey");
      out.taps += 1;
      out.doubleTap = true;
      for (let i = 0; i < 2; i++) {
        if (w.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        if (i === 0) await page.waitForTimeout(40);
      }
      await shot("P2-hop");
      // FR-P3: SIGN_HOST's passkey page in its layer
      const create = top('#screen:not([hidden]) #signin[data-signin="signed-out"] button[data-action="create"]');
      await create.waitFor({ timeout: WAIT_MS });
      arrived();
      await page.waitForTimeout(300);
      await shot("P3-S2.2");
      mark("create");
      await tap(create);
      if (runName === "prf") {
        // the layer closes with no SIGN_HOST screen after the sheet (FR-P4); the no-PRF backup here is a PRF launch fallen
        // to branch N, which stops the run at once
        await top('#screen[hidden], #screen #signin[data-signin="backup"]').waitFor({ state: "attached", timeout: WAIT_MS });
        if (!(await top("#screen").isHidden())) throw new Error("the PRF launch drew the no-PRF backup after the create");
        await shot("P4-hop");
      } else {
        // FR-N4: the 12 words on SIGN_HOST, counted, masked in the shot
        const list = top('#screen:not([hidden]) #signin[data-signin="backup"] [data-words="12"]');
        await list.waitFor({ timeout: WAIT_MS });
        arrived();
        out.words = await list.locator("li").count();
        await page.waitForTimeout(GUARD_MS);
        await shot("N4-S3.1", [list]);
        mark("saved");
        await tap(top('#signin[data-signin="backup"] button[data-action="saved"]'));
        await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
        await shot("N5-hop");
      }
    } else {
      // the wallet way: the two choices, nothing asked of any wallet, then the typed published vector
      mark("wallet");
      await tap(vis('.sgn-opt[data-way="wallet"]'));
      const choose = top('#screen:not([hidden]) #signin[data-signin="choose"]');
      await choose.waitFor({ timeout: WAIT_MS });
      arrived();
      await page.waitForTimeout(300);
      out.newAccount = await choose.locator('button[data-action="new-account"]').evaluate((b) => (b.disabled ? b.dataset.pending ?? "disabled" : "offered"));
      await shot("W2-choose");
      mark("have-one");
      await tap(choose.locator('button[data-action="have-one"]'));
      const existing = top('#signin[data-signin="existing"]');
      await existing.waitFor({ timeout: WAIT_MS });
      arrived();
      await shot("W2-existing");
      mark("recovery");
      await tap(existing.locator('button[data-action="recovery"]'));
      const box = top('#signin[data-signin="words"] textarea[data-input="words"]');
      await box.waitFor({ timeout: WAIT_MS });
      arrived();
      await box.fill(VECTOR_WORDS);
      await shot("W2-words");
      mark("continue");
      await tap(top('#signin[data-signin="words"] button[data-action="next"]'));
      await top("#screen").waitFor({ state: "hidden", timeout: WAIT_MS });
      await shot("W6-hop");
    }

    // FR-P5 / FR-N6 / FR-W7: back on the same route, signed in
    const landedHdr = vis('[data-header="S1.3"], [data-header="S1.4"]');
    await landedHdr.waitFor({ timeout: WAIT_MS });
    arrived();
    await page.waitForTimeout(SETTLE_MS);
    mark("end");
    await shot(runName === "prf" ? "P5-S1.3" : runName === "no-prf" ? "N6-S1.3" : "W7-S1.3");
    out.boxes.after = await boxes();
    out.landing = {
      header: await landedHdr.getAttribute("data-header"),
      sheet: await app.locator(".sgn").count(),
      sheetState: (await app.locator(".sgn").evaluateAll((els) => els.map((e) => e.getAttribute("data-state"))))[0] ?? null,
      dot: (await app.locator(".tb [data-backup-dot]").count()) > 0,
      topPath: new URL(page.url()).pathname,
      framePath: await app.locator(":root").evaluate(() => location.pathname),
      scrollY: await app.locator(":root").evaluate(() => scrollY),
    };
    const lastAct = marks.find((m) => m.step === (runName === "prf" ? "create" : runName === "no-prf" ? "saved" : "continue"));
    const createT = events.find((e) => e.kind === "create")?.t;
    const landedT = events.find((e) => e.kind === "landed")?.t;
    const from = runName === "prf" ? createT : lastAct?.t;
    out.landMs = from && landedT ? Math.round(landedT - from) : null;
  } catch (e) {
    out.error = String(e.message).split("\n")[0];
    try {
      await page.screenshot({ path: path.join(shotDir, `error-${w.name}.png`) });
    } catch {}
  }
  await cdp.send("Page.stopScreencast").catch(() => {});
  await page.waitForTimeout(100);

  // the records
  out.pages = rec.pages.length;
  out.creates = events.filter((e) => e.kind === "create").map(({ rpId, prfAsked, prf }) => ({ rpId, prfAsked, prf }));
  out.signinStates = events.filter((e) => e.kind === "signin").map((e) => e.state);
  out.messages = events.filter((e) => e.kind === "msg").map((e) => e.type);
  out.csp = events.filter((e) => e.kind === "csp").map(({ host, directive, blocked }) => ({ host, directive, blocked }));
  out.marks = marks.map((m) => ({ step: m.step, t: m.t - marks[0]?.t }));
  // BAR-03 from READY (the P0 mark) to the end: a frame shows until the next one; consecutive blank frames are one run.
  // While SIGN_HOST's layer is open the screen is SIGN_HOST's own page: a near-empty frame there is that page drawn near
  // empty, a note on the page (card signpage-signin-brand draws those pages and makes it gated). Outside the layer: gated, the
  // longest blank inside a step's transition (its tap to the next screen's arrival; the hop back is the layer's close to
  // the app's first frame with content); a blank while an app screen rests is a note on that screen. White flashes are
  // gated everywhere.
  const p0 = marks.find((m) => m.step === "P0")?.t ?? Infinity;
  const end = Date.now();
  const flow = cast.filter((f, i) => (cast[i + 1]?.t ?? end) >= p0);
  let white = 0;
  const runs = [];
  for (let i = 0; i < flow.length; i++) {
    const px = framePixels(Buffer.from(flow[i].png, "base64"));
    if (px.white) white += 1;
    const [a, b] = [Math.max(flow[i].t, p0), flow[i + 1]?.t ?? end];
    if (!px.blank) continue;
    const last = runs.at(-1);
    if (last && last.b === a) last.b = b;
    else runs.push({ a, b, colour: px.colour, oneColour: Math.round(px.oneColour * 1000) / 1000 });
  }
  // the layer's open intervals, from SIGN_HOST's own reports
  const layers = [];
  for (const e of events.filter((x) => x.kind === "layer")) {
    if (e.open) layers.push({ a: e.t, b: end });
    else if (layers.length && layers.at(-1).b === end) layers.at(-1).b = e.t;
  }
  const overlap = (r, w) => Math.max(0, Math.min(r.b, w.b) - Math.max(r.a, w.a));
  // each blank run cut into its parts outside the layer (the app's frame, or the shell with no frame yet) and inside it;
  // a frame of one colour only (nothing drawn at all) is gated wherever it shows, the layer included
  const outside = [];
  for (const r of runs) {
    let parts = [{ a: r.a, b: r.b }];
    if (r.oneColour < 1) for (const l of layers) parts = parts.flatMap((p) => [{ a: p.a, b: Math.min(p.b, l.a) }, { a: Math.max(p.a, l.b), b: p.b }]).filter((p) => p.b > p.a);
    for (const p of parts) outside.push({ ...p, colour: r.colour, oneColour: r.oneColour });
  }
  const screenAt = (t) => shotsAt.filter((x) => x.t <= t).at(-1)?.frame ?? null;
  const windows = marks
    .filter((m) => m.step !== "P0" && m.step !== "end")
    .map((m) => ({ step: m.step, a: m.t, b: arrivals.find((t) => t > m.t) ?? end }));
  const blankSteps = windows.map((w) => {
    const hit = outside.map((p) => ({ ms: overlap(p, w), colour: p.colour })).sort((x, y) => y.ms - x.ms)[0];
    return { step: w.step, ms: Math.round(w.b - w.a), blankMs: Math.round(hit?.ms ?? 0), colour: hit?.ms ? hit.colour : null };
  });
  const resting = outside
    .map((p) => ({ ms: Math.round(p.b - p.a - windows.reduce((s, w) => s + overlap(p, w), 0)), at: Math.round(p.a - p0), oneColour: p.oneColour, screen: screenAt(p.b) }))
    .filter((r) => r.ms > BOUND.blankMs);
  const signhost = runs
    .filter((r) => r.oneColour < 1)
    .map((r) => ({ ms: Math.round(layers.reduce((s, l) => s + overlap(r, l), 0)), oneColour: r.oneColour, screen: screenAt(r.b) }))
    .filter((r) => r.ms > BOUND.blankMs);
  // the hop back: the layer's close to the first paint of the app's new document (the shell alone in between)
  const hops = layers.filter((l) => l.b < end).map((l) => {
    const paint = events.find((e) => e.kind === "paint" && e.host === REAL.app && !e.top && e.t >= l.b);
    return paint ? Math.round(paint.t - l.b) : null;
  });
  out.blank = { frames: flow.length, white, longestMs: Math.max(0, ...blankSteps.map((x) => x.blankMs)), steps: blankSteps, resting, signhost, hops };
  // BAR-04: per document, and per step on an APP_HOST document READY before the step began
  const docs = new Map();
  for (const e of events) if (e.kind === "doc") docs.set(e.doc, { host: e.host, top: e.top, t: e.t, sum: 0, shifts: [] });
  for (const e of events) if (e.kind === "shift" && docs.has(e.doc)) docs.get(e.doc).shifts.push(e), (docs.get(e.doc).sum += e.value);
  const readyAt = new Map(events.filter((e) => e.kind === "ready").map((e) => [e.doc, e.t]));
  const steps = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const [a, b] = [marks[i], marks[i + 1]];
    if (a.step === "P0") continue;
    let sum = 0;
    for (const [id, d] of docs) {
      if (d.host !== REAL.app || !(readyAt.get(id) <= a.t)) continue;
      for (const s of d.shifts) if (s.t >= a.t && s.t < b.t) sum += s.value;
    }
    steps.push({ step: a.step, sum });
  }
  out.cls = {
    pages: [...docs.entries()].filter(([, d]) => d.host === REAL.app || d.host === REAL.sign).map(([id, d]) => ({ doc: id, host: d.host, top: d.top, sum: d.sum, sources: d.shifts.flatMap((x) => x.sources ?? []).slice(0, 6) })),
    steps,
  };
  out.shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => f.endsWith(`-${w.name}.png`)) : [];
  await auth?.remove().catch(() => {});
  await context.close();
  return out;
}

/** One launch: its own harness and browser, both widths in turn. */
export async function run(runName, { plant = null, shots, cpu = 1 }) {
  const shotDir = path.join(shots, runName);
  rmSync(shotDir, { recursive: true, force: true });
  mkdirSync(shotDir, { recursive: true });
  // SIGN_HOST serves its shell at any path, as Pages does for a build with no 404.html: the top window keeps the app's
  // path (packages/signpage/src/shell.ts nav)
  const h = await startHarness({ realNames: true, edit: (sites) => (sites[HOSTS.sign].spa = true) });
  const rec = { run: runName, plant, cpu, browser: h.browser.version(), widths: [] };
  const t0 = Date.now();
  try {
    for (const w of WIDTHS) rec.widths.push(await oneWidth(h, runName, w, { plant, shotDir, cpu }));
  } finally {
    await h.close();
  }
  rec.ms = Date.now() - t0;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const runs = opt("--runs", RUNS.join()).split(",");
  const plant = opt("--plant", null);
  const cpu = Number(opt("--cpu", "1"));
  if (runs.some((r) => !RUNS.includes(r)) || (plant && !PLANTS.includes(plant)) || !(cpu >= 1)) {
    console.error(`usage: run.mjs [--runs ${RUNS.join(",")}] [--plant ${PLANTS.join("|")}] [--cpu <rate>] [--shots <dir>] [--record <file>]`);
    process.exit(2);
  }
  const temp = opt("--shots", null) ? null : mkdtempSync(path.join(tmpdir(), "ct-signin-e2e-"));
  const shots = path.resolve(opt("--shots", temp));
  let ok = true;
  const recs = [];
  try {
    for (const r of runs) {
      const rec = await run(r, { plant, shots, cpu });
      recs.push(rec);
      const v = judge(rec);
      for (const l of v.lines) console.log(l);
      console.log(`${v.ok ? "PASS" : "FAIL"} ${r} launch in ${(rec.ms / 1000).toFixed(1)} s (Chromium ${rec.browser}${cpu > 1 ? `, CPU ${cpu}x slower` : ""}${plant ? `, planted ${plant}` : ""})`);
      ok &&= v.ok;
    }
  } catch (e) {
    console.error(`ERROR app-harness-signin-e2e: ${e.stack ?? e}`);
    process.exit(2);
  } finally {
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(recs, null, 2)}\n`);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  console.log(`${ok ? "PASS" : "FAIL"} app-harness-signin-e2e: ${runs.join(", ")}${plant ? ` (planted ${plant})` : ""}${temp ? "" : `; shots in ${shots}`}`);
  process.exit(ok ? 0 : 1);
}
