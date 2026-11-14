// The agent: a Node program that is its own user of Blindfill. It serves a tiny page on localhost that loads
// @blindfill/kit in popup mode, opens the signing page's /connect, and taps Allow and each Confirm itself. Before each
// Confirm it reads the sheet and taps only when no amount on it is above --max (guard.mjs). One straight run: fund,
// deposit, buy, sell, withdraw, each a kit request; each step's answer and transactions are printed and appended to
// the record file.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { build } from "rolldown";
import { launchBrowser } from "../../scripts/browsers.mjs";
import { confirmOk } from "./guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = "http://localhost:4793";
export const SIGN = "https://confidential.unrealized.trade";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the signing page takes a tap only after the user's own first move on a sheet, as for a person
const BEAT_MS = 800;

/** The agent's folder: its words (mode 600) and its record. */
export function home(dir = path.join(homedir(), ".blindfill-agent")) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return { dir, words: path.join(dir, "words"), record: path.join(dir, "record.jsonl") };
}

/** The agent's 12 words: made once, kept in `file` at mode 600, never printed. */
export function words(file) {
  if (!existsSync(file)) writeFileSync(file, generateMnemonic(wordlist, 128) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

const txsOf = (txs) => (txs ?? []).map((t) => t.hash ?? t.id ?? JSON.stringify(t)).join(" ");

/**
 * One session: the browser, the page, the popup, connected and signed in with the words. `hooks.context(ctx)` runs on
 * the browser context first (the local test routes the signing page to a local build there).
 */
export async function session({ h, max, say = console.log, hooks = {} }) {
  const code = (await build({ input: path.join(HERE, "page.js"), platform: "browser", write: false, logLevel: "silent", output: { format: "esm" } })).output[0].code;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent</title></head><body><button id="connect">Connect</button><script type="module" src="/page.js"></script></body></html>`;
  const browser = await launchBrowser("chromium");
  const close = async () => browser.close().catch(() => {});
  const until = (label, p) => p.catch((e) => Promise.reject(new Error(`${label}: ${String(e.message).split("\n")[0]}`)));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (hooks.context) await hooks.context(ctx);
    await ctx.route(`${APP}/**`, (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p === "/") return r.fulfill({ status: 200, contentType: "text/html", body: html });
      if (p === "/page.js") return r.fulfill({ status: 200, contentType: "text/javascript", body: code });
      return r.fulfill({ status: 404, body: "" });
    });
    const page = await ctx.newPage();
    await page.goto(`${APP}/`);
    const opened = ctx.waitForEvent("page");
    await page.click("#connect");
    const pop = await opened;
    await until("the connect sheet", pop.waitForFunction(() => document.querySelector("#outside")?.textContent?.startsWith("Connect"), null, { timeout: 60_000 }));
    say(`connect sheet: ${await pop.evaluate(() => document.querySelector("#outside")?.firstElementChild?.textContent ?? "")}`);
    await pop.waitForTimeout(BEAT_MS);
    await pop.locator("#outside button", { hasText: "Allow" }).click();
    await until("the client ready after Allow", page.waitForFunction(() => window.snap?.status === "ready", null, { timeout: 60_000 }));
    const snap = () => page.evaluate(() => window.snap);

    // sign in with the words, typed on the signing page's own words screen
    await page.evaluate(() => window.ask("signin.open", { way: "words", return_key: "signin" }));
    const box = pop.locator('#signin[data-signin="words"] textarea[data-input="words"]');
    await until("the words screen", box.waitFor({ timeout: 60_000 }));
    await box.fill(words(h.words));
    await pop.waitForTimeout(BEAT_MS);
    await pop.locator('#signin[data-signin="words"] button[data-action="next"]').click();
    await until("signed in", page.waitForFunction(() => window.snap?.state?.signed_in === true, null, { timeout: 120_000 }));
    for (let i = 0; i < 3 && !(await pop.evaluate(() => document.querySelector("#screen")?.hidden)); i++) {
      const done = pop.locator('#screen:not([hidden]) button[data-action="cancel"], #screen:not([hidden]) button[data-action="saved"], #screen:not([hidden]) [data-sheet="close"]').first();
      if (!(await done.count())) break;
      await pop.waitForTimeout(BEAT_MS);
      await done.click().catch(() => {});
      await pop.waitForTimeout(BEAT_MS);
    }
    say("signed in");

    // the buy's and the sell's Confirm (#outside): its title, origin, lines and buttons
    const readOutside = () =>
      pop.evaluate(() => {
        const o = document.querySelector("#outside");
        if (!o?.isConnected) return null;
        const dl = o.querySelector("dl");
        const lines = [];
        if (dl) for (let i = 0; i + 1 < dl.children.length; i += 2) lines.push([dl.children[i].textContent ?? "", dl.children[i + 1].textContent ?? ""]);
        return { title: o.children[0]?.textContent ?? "", origin: o.children[1]?.textContent ?? "", lines, buttons: [...o.querySelectorAll("button")].map((b) => b.textContent ?? "") };
      });

    /** Asks `kind` and waits for its answer, tapping the Confirm the page shows meanwhile when --max allows it. */
    async function ask(kind, params, timeoutMs = 300_000) {
      const id = await page.evaluate(([k, p]) => window.ask(k, p), [kind, params]);
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const got = await page.evaluate((i) => window.outcomes[i] ?? null, id);
        if (got) return { id, ...got };
        const sheet = await readOutside().catch(() => null);
        if (sheet?.buttons.includes("Confirm")) {
          say(`confirm ${kind}: ${sheet.title} ${sheet.origin}; ${sheet.lines.map(([k, v]) => `${k} ${v}`).join(", ")}`);
          const v = confirmOk(sheet, { max });
          await pop.waitForTimeout(BEAT_MS);
          if (!v.ok) {
            await pop.locator("#outside button", { hasText: "Cancel" }).click();
            throw new Error(`not confirmed: ${v.why}`);
          }
          await pop.locator("#outside button", { hasText: "Confirm" }).click();
        }
        await sleep(500);
      }
      throw new Error(`${kind}: no answer in ${timeoutMs / 1000} s`);
    }

    /** The page's own withdraw Confirm, drawn after withdraw.open answers: tapped once offered, when --max allows it. */
    async function confirmWithdraw(balance, timeoutMs = 120_000) {
      await until("the withdraw Confirm", pop.waitForSelector('#screen:not([hidden]) #signin [data-withdraw="form"][data-given="app"]', { timeout: 30_000 }));
      const go = pop.locator('#screen #signin button[data-action="withdraw"]');
      const read = () =>
        pop.evaluate(() => {
          const s = document.querySelector("#screen #signin");
          const v = Object.fromEntries([...(s?.querySelectorAll("[data-value]") ?? [])].map((e) => [e.dataset.value, e.textContent ?? ""]));
          return { origin: s?.firstElementChild?.textContent ?? "", to: v.to ?? "", amount: v.amount ?? "" };
        });
      const end = Date.now() + timeoutMs;
      let offered = false;
      while (!(offered = await go.evaluate((b) => !b.disabled).catch(() => false)) && Date.now() < end) await sleep(1_000);
      const w = await read();
      say(`confirm withdraw.open: ${w.origin}; To ${w.to}, Amount ${w.amount}`);
      const v = confirmOk({ lines: [["Amount", w.amount]] }, { max, balance });
      await pop.waitForTimeout(BEAT_MS);
      if (!offered || !v.ok) {
        await pop.locator('#screen #signin button[data-action="cancel"]').click().catch(() => {});
        throw new Error(`not confirmed: ${offered ? v.why : "the page did not offer its Confirm"}`);
      }
      await go.click();
    }
    return { ask, confirmWithdraw, snap, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Waits until the op `pick` finds in the page's state reaches a stage of `final`; prints each stage. */
async function landed(s, pick, final, say, label, ms = 1_800_000) {
  const end = Date.now() + ms;
  let seen = "";
  while (Date.now() < end) {
    const op = pick((await s.snap())?.state?.ops ?? []);
    if (op && op.stage !== seen) say(`${label}: ${(seen = op.stage)} ${txsOf(op.txs)}`);
    if (op && final.includes(op.stage)) return op;
    await sleep(2_000);
  }
  throw new Error(`${label}: not landed in ${ms / 1000} s`);
}

/** The five steps, in order, on one session. Each is exported so the local test can run every one. */
export const steps = {
  /** The deposit address for `amount` USDC on NEAR (the page's minimum when none is given). */
  async fund(s, { amount, max, say, note }) {
    const assets = await s.ask("deposit.assets", {});
    if (!assets.ok) throw new Error(`deposit.assets: ${assets.error.code}`);
    const usdc = assets.result.assets.find((a) => a.chain === "near" && a.symbol === "USDC");
    if (!usdc) throw new Error("no USDC on NEAR in the deposit list");
    const q = await s.ask("deposit.quote", { origin_asset: usdc.origin_asset, amount: amount ?? usdc.min });
    if (!q.ok) throw new Error(`deposit.quote: ${q.error.code}`);
    note("fund", q.result);
    say(`send ${q.result.amount_in} USDC on NEAR (${usdc.origin_asset}) to ${q.result.deposit_address} before ${q.result.deadline}; the least it takes is ${usdc.min} USDC`);
    return q.result.deposit_address;
  },
  /** Waits until the deposit sent to `address` is in the vault. */
  async deposit(s, { address, say, note }, ms = 3_600_000) {
    const end = Date.now() + ms;
    for (let last = ""; Date.now() < end; await sleep(15_000)) {
      const c = await s.ask("deposit.confirm", { deposit_address: address });
      if (!c.ok) throw new Error(`deposit.confirm: ${c.error.code}`);
      if (c.result.stage !== last) say(`deposit: ${(last = c.result.stage)} ${txsOf(c.result.txs)}`);
      if (last === "done") return note("deposit", c.result);
      if (["refunded", "failed", "short", "expired"].includes(last)) throw new Error(`deposit: ${last}`);
    }
    throw new Error("deposit: not in the vault in time");
  },
  /** Buys `token` on NEAR with `amount` USDC, then sells all of it; each waits for its fill. */
  async trade(s, side, { token, amount, slippageBps, say, note }) {
    const params = side === "buy" ? { chain: "near", token, amount: String(amount), slippage_bps: slippageBps } : { chain: "near", token, share_bps: 10_000, slippage_bps: slippageBps };
    const a = await s.ask(`pool.${side}`, params);
    if (!a.ok) throw new Error(`pool.${side}: ${a.error.code}`);
    say(`${side}: ${a.result.stage} ${txsOf(a.result.txs)}`);
    const op = ["filled", "part_filled"].includes(a.result.stage) ? a.result : await landed(s, (ops) => ops.find((o) => o.id === a.id), ["filled", "part_filled", "refused", "not_landed"], say, side);
    note(side, op);
    if (!["filled", "part_filled"].includes(op.stage)) throw new Error(`${side}: ${op.stage}`);
  },
  /** Withdraws everything to `to`, behind the page's own Confirm, and waits until it is sent. */
  async withdraw(s, { to, say, note }) {
    const st = (await s.snap())?.state;
    const before = new Set((st?.ops ?? []).filter((o) => o.kind === "withdraw").map((o) => o.id));
    const a = await s.ask("withdraw.open", { return_key: "withdraw", to, max: true });
    if (!a.ok) throw new Error(`withdraw.open: ${a.error.code}`);
    await s.confirmWithdraw(st?.vault_balance);
    const op = await landed(s, (ops) => ops.find((o) => o.kind === "withdraw" && !before.has(o.id)), ["sent", "refunded", "stopped"], say, "withdraw");
    note("withdraw", op);
    if (op.stage !== "sent") throw new Error(`withdraw: ${op.stage}`);
  },
};

/** The one straight run: fund, deposit, buy, sell, withdraw. */
export async function run({ h = home(), token, amount, deposit, max, to, slippageBps = 300, say = console.log, hooks }) {
  const note = (step, fields) => appendFileSync(h.record, JSON.stringify({ at: new Date().toISOString(), step, ...fields }) + "\n", { mode: 0o600 });
  const s = await session({ h, max, say, hooks });
  const o = { token, amount, max, to, slippageBps, say, note };
  try {
    const address = await steps.fund(s, { ...o, amount: deposit });
    await steps.deposit(s, { ...o, address });
    await steps.trade(s, "buy", o);
    await steps.trade(s, "sell", o);
    await steps.withdraw(s, o);
    say(`done; the record is ${h.record}`);
  } finally {
    await s.close();
  }
}
