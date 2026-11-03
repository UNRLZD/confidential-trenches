#!/usr/bin/env node
// Live check of card app-launchpad-chain-badges: every token on Discover, as served at APP_HOST, shows where it was
// launched and on which chain as logo badges at its avatar's corners, never as a raw id. Headless Chromium opens
// /discover at 390 x 844 (phone, dpr 2, touch; each tab in turn) and 1440 x 900 (desktop, every column), keeps the
// lists answer the page itself read from HELPER_HOST, and for every drawn row reads:
//   - its served `launchpad` id has a row in the terminal's table (apps/terminal/src/screens/market/pads.ts), so a pad
//     the lists start serving shows here as a fault, not as a token with no badge;
//   - with an id, the launchpad badge draws that pad: data-pad is the id, the hover title is the pad's proper name, its
//     logo loaded; with null (or a pad the table holds no cited logo for, NO_LOGO), no launchpad badge;
//   - the chain badge always draws: data-chain is the row's chain, the title the chain's name, its mark loaded;
//   - no element of the row (the avatar's initials aside) has the raw id as its text;
//   - each badge lies inside its row's box and is not cut by the column (no clipping at either width).
// A screenshot of every width is kept.
//   node scripts/live-checks/app-launchpad-badges.mjs [--url <page>] [--shots <dir>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge(). A row is recorded by its `addr`
// (the token id): an id under a "token" key reads to gitleaks as a secret.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAINS, NO_LOGO, PADS } from "../../apps/terminal/src/screens/market/pads.ts";
import { launchBrowser } from "../browsers.mjs";

const KEY = "app-launchpad-badges";
export const APP_HOST = "https://confidential.unrealized.trade";
export const HELPER_HOST = "https://api.confidential.unrealized.trade";
export const LISTS_URL = `${HELPER_HOST}/v1/market/lists?chain=solana`;
export const COLUMNS = ["new", "trending", "hot", "graduating"];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READ_MS = 20_000;
const own = (t, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k);

// ------------------------------------------------------------------------------------------------ the verdict
/** What is wrong with one drawn row against what the lists served for it (empty: nothing). */
export function rowFaults(row) {
  const bad = [];
  const s = row.served;
  if (!s) return ["not in the lists answer the page read"];
  const id = s.launchpad;
  if (id !== null && !own(PADS, id) && !NO_LOGO.includes(id)) bad.push(`launchpad ${JSON.stringify(id)} has no row in the table`);
  const pad = id !== null && own(PADS, id) ? PADS[id] : null;
  if (pad) {
    if (!row.pad) bad.push(`no ${pad.name} badge`);
    else {
      if (row.pad.id !== id) bad.push(`launchpad badge says ${JSON.stringify(row.pad.id)}, served ${JSON.stringify(id)}`);
      if (row.pad.title !== pad.name) bad.push(`launchpad hover ${JSON.stringify(row.pad.title)}, not ${JSON.stringify(pad.name)}`);
      if (!row.pad.loaded) bad.push(`${pad.name} logo did not load`);
    }
  } else if (row.pad) bad.push(`a launchpad badge (${JSON.stringify(row.pad.id)}) where ${id === null ? "none was served" : `${JSON.stringify(id)} has no logo`}`);
  const chain = own(CHAINS, s.chain) ? CHAINS[s.chain] : null;
  if (!chain) bad.push(`chain ${JSON.stringify(s.chain)} has no mark in the table`);
  if (!row.chain) bad.push("no chain badge");
  else {
    if (row.chain.id !== s.chain) bad.push(`chain badge says ${JSON.stringify(row.chain.id)}, served ${JSON.stringify(s.chain)}`);
    if (chain && row.chain.title !== chain.name) bad.push(`chain hover ${JSON.stringify(row.chain.title)}, not ${JSON.stringify(chain.name)}`);
    if (!row.chain.loaded) bad.push("chain mark did not load");
  }
  if (id !== null && (row.texts ?? []).includes(id)) bad.push(`raw id ${JSON.stringify(id)} drawn as text`);
  if (row.clipped?.length) bad.push(`clipped: ${row.clipped.join(", ")}`);
  return bad;
}

/** The check on one recorded run. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const loads = rec.loads ?? [];
  say(loads.length === WIDTHS.length, `${loads.length} loads of ${WIDTHS.length} (every width)`);
  for (const l of loads) {
    const tag = `${l.width} ${l.path}`;
    if (l.state !== "ready" || !l.lists || l.lists.status !== 200) {
      say(false, `${tag}: Discover ${l.state ?? "not drawn"}, lists ${l.lists ? `${l.lists.url} ${l.lists.status}` : "not read"}`);
      continue;
    }
    const rows = l.rows ?? [];
    const faulty = rows.map((r) => ({ r, bad: rowFaults(r) })).filter((x) => x.bad.length);
    const padded = rows.filter((r) => r.served?.launchpad !== null && r.served?.launchpad !== undefined).length;
    const ids = [...new Set(rows.map((r) => r.served?.launchpad).filter((x) => x !== null && x !== undefined))].sort();
    if (!rows.length) say(false, `${tag}: no rows drawn`);
    else if (faulty.length) {
      const first = faulty.slice(0, 3).map((x) => `${x.r.column}/${x.r.addr.slice(0, 8)}: ${x.bad.join("; ")}`).join(" | ");
      say(false, `${tag}: ${faulty.length} of ${rows.length} rows wrong, first ${first}`);
    } else say(true, `${tag}: ${rows.length} rows, ${padded} with a launchpad badge (${ids.join(", ")}), every row its chain mark, no raw id, nothing clipped`);
    if (!l.shot) say(false, `${tag}: no screenshot`);
  }
  return { ok: lines.every((x) => x.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the live read
/** In the frame that draws Discover: every visible row of `scope` with its badges, its leaf texts and any clipping. */
export const READ = ({ scope, column }) => {
  const vis = (e) => e.getClientRects().length > 0;
  const out = [];
  const root = document.querySelector(scope);
  if (!root) return out;
  const clipBox = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflow !== "visible" && !p.classList.contains("tok-pb") && !p.classList.contains("tok-cb")) return p.getBoundingClientRect();
    return null;
  };
  for (const row of [...root.querySelectorAll('[role="listitem"][data-token]')].filter(vis)) {
    const rb = row.getBoundingClientRect();
    const badge = (sel, attr) => {
      const b = row.querySelector(sel);
      if (!b) return null;
      const img = b.querySelector("img");
      return { id: b.getAttribute(attr), title: b.getAttribute("title"), loaded: !!img && img.complete && img.naturalWidth > 0, rect: b.getBoundingClientRect() };
    };
    const pad = badge(".tok-pb", "data-pad");
    const chain = badge(".tok-cb", "data-chain");
    const clipped = [];
    for (const [k, b] of [["launchpad", pad], ["chain", chain]]) {
      if (!b) continue;
      const r = b.rect;
      if (r.left < rb.left - 0.5 || r.right > rb.right + 0.5 || r.top < rb.top - 0.5 || r.bottom > rb.bottom + 0.5) clipped.push(`${k} badge outside its row`);
      // the nearest box that cuts its content; judged only for a row wholly inside it (a row half scrolled out is not cut)
      const c = clipBox(row.querySelector(k === "chain" ? ".tok-cb" : ".tok-pb"));
      const rowIn = c && rb.left >= c.left - 0.5 && rb.right <= c.right + 0.5 && rb.top >= c.top - 0.5 && rb.bottom <= c.bottom + 0.5;
      if (rowIn && (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5)) clipped.push(`${k} badge cut by its box`);
      if (r.width < 9.5) clipped.push(`${k} badge ${r.width}px`);
    }
    // the row's own words, not the avatar's drawn initials (two letters of the symbol, never an id)
    const texts = [...row.querySelectorAll("*")].filter((e) => e.children.length === 0 && !e.closest(".tok-av")).map((e) => e.textContent.trim()).filter(Boolean);
    const strip = (b) => (b ? { id: b.id, title: b.title, loaded: b.loaded } : null);
    out.push({ column, addr: row.dataset.token, pad: strip(pad), chain: strip(chain), texts, clipped });
  }
  return out;
};

export async function collect({ url = `${APP_HOST}/discover`, shots = path.join(tmpdir(), `${KEY}-${Date.now()}`), prepare = null } = {}) {
  mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  const rec = { url, at: new Date().toISOString(), browser: browser.version(), loads: [] };
  try {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
      if (prepare) await prepare(ctx);
      const page = await ctx.newPage();
      let lists = null;
      page.on("response", (r) => r.url() === LISTS_URL && !lists && (lists = r));
      await page.goto(url, { waitUntil: "load" });
      const stateOf = (f) => f.evaluate(() => document.querySelector('main[data-route="discover"] .dsc')?.dataset.discover ?? null).catch(() => null);
      let app = null;
      let state = null;
      for (const t0 = Date.now(); Date.now() - t0 < READ_MS; await page.waitForTimeout(250)) {
        app = null;
        for (const f of page.frames()) {
          state = await stateOf(f);
          if (state) {
            app = f;
            break;
          }
        }
        if (app && state !== "loading") break;
      }
      const target = app ?? page.mainFrame();
      // every logo has had its chance to load
      await target.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))))).catch(() => {});
      await page.waitForTimeout(300);
      const rows = [];
      if (state === "ready") {
        if (w.isMobile) {
          for (const key of COLUMNS) {
            await target.click(`.dsc-tab[data-tab="${key}"]`);
            await target.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))));
            rows.push(...(await target.evaluate(READ, { scope: ".dsc-phone", column: key })));
          }
          await target.click('.dsc-tab[data-tab="new"]');
        } else for (const key of COLUMNS) rows.push(...(await target.evaluate(READ, { scope: `.dsc-grid .dsc-col[data-col="${key}"]`, column: key })));
      }
      const shot = path.join(shots, `${w.name}-discover.png`);
      await page.screenshot({ path: shot });
      const body = lists ? await lists.json().catch(() => null) : null;
      const served = new Map();
      for (const rs of Object.values(body?.lists ?? {})) for (const r of Array.isArray(rs) ? rs : []) if (r && typeof r.token === "string") served.set(r.token, { launchpad: r.launchpad ?? null, chain: r.chain });
      for (const r of rows) r.served = served.get(r.addr) ?? null;
      rec.loads.push({ width: w.name, path: new URL(target.url()).pathname, state, lists: lists ? { url: lists.url(), status: lists.status() } : null, rows, shot });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  rec.shots = shots;
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await collect({ url: opt("--url", `${APP_HOST}/discover`), shots: opt("--shots", undefined) });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`screenshots: ${rec.shots}`);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
