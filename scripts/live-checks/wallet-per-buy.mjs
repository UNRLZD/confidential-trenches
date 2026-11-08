#!/usr/bin/env node
// Live check of card wallet-per-buy: a restore reads every fresh wallet a buy used, at one state each, within the
// public RPCs' limits. It runs the wallet's own restore reads (packages/wallet/scripts/buy-wallets-live.ts: buyWallets
// and the readers the device runs, at HOLDINGS_RPC_LIMIT) for Ws j = 0..3 of the published A.8 test seed
// (packages/wallet/test/vectors/a8.json, the all-zero seed; never any other key), on Solana mainnet and Base, each on
// two RPCs: the helper's /v1/rpc/{chain}, the device's route, and a public RPC device-direct. PASS needs:
//   - every W read on every route, four distinct Ws, j 0 and 1 at the A.8 vector's addresses;
//   - each Solana W's last round (getBalance and both getTokenAccountsByOwner) answered at one slot, and each Base W's
//     balance and token reads at one block;
//   - no HTTP 429 and no other failed answer;
//   - each W's holdings equal on both RPCs.
// It prints, per W, the address, the slot or block and the holdings.
// After: helper
//   node scripts/live-checks/wallet-per-buy.mjs [--helper <origin>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEY = "wallet-per-buy";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HELPER = "https://ct-api.unrealized.trade";
export const CHILD = path.join(REPO, "packages/wallet/scripts/buy-wallets-live.ts");
const A8 = JSON.parse(readFileSync(path.join(REPO, "packages/wallet/test/vectors/a8.json"), "utf8"));
/** The A.8 vector's W for chain c ("sol" or "evm") at j (the vector holds j 0 and 1): what every route must have read. */
const vec = (c, j) => A8.wallets.find((w) => w.c === c && w.l === A8.l && w.j === j)?.address;
const JS = [0, 1, 2, 3];
const ROUTES = [["sol", "helper"], ["sol", "public"], ["base", "helper"], ["base", "public"]];

/** The child's command line: the wallet's reader, with the shared 2000 ms connect window imported first. */
export const childArgs = (helper = HELPER) => ["--import", pathToFileURL(path.join(REPO, "scripts/net-window.mjs")).href, CHILD, "--helper", helper];

const href = (u) => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};
const show = (h) => `native ${h.native}${Object.keys(h.tokens).length ? `, ${Object.entries(h.tokens).map(([k, v]) => `${k} ${v.amount}${v.frozen ? " frozen" : ""}`).join(", ")}` : ""}${h.unreadable.length ? `, unreadable ${h.unreadable.join(" ")}` : ""}`;

/** The check on one recorded run: { readAt, routes: [{ chain, rpc, url, wallets: [{ j, address, holdings }], failed }], calls }. */
export function judge({ routes, calls }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const bad = calls.filter((c) => c.status !== 200);
  say(!calls.some((c) => c.status === 429), `HTTP 429s: ${calls.filter((c) => c.status === 429).length} of ${calls.length} calls`);
  say(bad.length === 0, `failed answers: ${bad.length ? bad.map((c) => `${c.method} ${c.status}`).join(", ") : "none"}`);
  for (const [chain, rpc] of ROUTES) {
    const r = routes.find((x) => x.chain === chain && x.rpc === rpc);
    const tag = `[${chain} ${rpc}]`;
    if (!r) {
      say(false, `${tag} not read`);
      continue;
    }
    say(r.failed.length === 0, `${tag} ${r.url}: ${r.failed.length ? r.failed.map((f) => f.error).join("; ") : "no pool failed"}`);
    const mine = calls.filter((c) => href(c.route) === href(r.url));
    say(new Set(r.wallets.map((w) => w.address)).size === JS.length && r.wallets.length === JS.length, `${tag} ${r.wallets.length} Ws read, ${new Set(r.wallets.map((w) => w.address)).size} distinct`);
    for (const j of JS) {
      const w = r.wallets.find((x) => x.j === j);
      const want = vec(chain === "sol" ? "sol" : "evm", j);
      if (!w) {
        say(false, `${tag} W j=${j} ${want}: not read`);
        continue;
      }
      let at;
      if (chain === "sol") {
        const last = mine.filter((c) => c.owner === w.address).slice(-3);
        const slots = last.map((c) => c.slot);
        const one = last.length === 3 && last.filter((c) => c.method === "getBalance").length === 1 && last.filter((c) => c.method === "getTokenAccountsByOwner").length === 2 && slots.every((s) => Number.isSafeInteger(s) && s === slots[0]);
        at = `slot ${slots.join("/")}`;
        say(one, `${tag} W j=${j} ${w.address}: its last round at one slot (${at})`);
      } else {
        const lo = w.address.toLowerCase();
        const mineW = mine.filter((c) => c.owner?.toLowerCase() === lo);
        const bal = mineW.filter((c) => c.method === "eth_getBalance").at(-1);
        const tok = mineW.filter((c) => c.method === "eth_call").at(-1);
        const one = bal?.at !== undefined && /^0x[0-9a-f]{64}$/i.test(bal.at) && tok?.at === bal.at;
        at = `block ${bal?.at ?? "none"}`;
        say(one, `${tag} W j=${j} ${w.address}: its balance and token reads at one block (${at})`);
      }
      if (want !== undefined) say(w.address.toLowerCase() === want.toLowerCase(), `${tag} W j=${j}: the A.8 vector's address ${want}`);
      lines.push(`    ${chain} ${rpc} j=${j} ${w.address} ${at}: ${show(w.holdings)}`);
    }
  }
  for (const chain of ["sol", "base"]) {
    const [a, b] = ["helper", "public"].map((rpc) => routes.find((x) => x.chain === chain && x.rpc === rpc));
    for (const j of JS) {
      const ha = a?.wallets.find((w) => w.j === j)?.holdings, hb = b?.wallets.find((w) => w.j === j)?.holdings;
      say(ha !== undefined && JSON.stringify(ha) === JSON.stringify(hb), `[${chain}] W j=${j}: the same holdings on both RPCs`);
    }
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

/** Runs the wallet's reader in a child process (scripts may not import the wallet: check:imports) and returns its record. */
export function read(helper = HELPER) {
  const r = spawnSync(process.execPath, childArgs(helper), { cwd: REPO, encoding: "utf8", timeout: 300_000, maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`the wallet's reader exited ${r.status ?? r.signal}: ${String(r.stderr).slice(-400)}`);
  return JSON.parse(r.stdout);
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const run = read(opt("--helper", HELPER));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`times (ms): ${run.routes.map((r) => `${r.chain} ${r.rpc} ${r.ms}`).join(", ")}; limit ${JSON.stringify(run.limit)}`);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${run.readAt})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
