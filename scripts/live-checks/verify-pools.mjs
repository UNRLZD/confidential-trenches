#!/usr/bin/env node
// Live check of card verify-pools: Verify shows each pool's no-key reads, read on the visitor's own device. Headless
// Chromium opens APP_HOST/verify at 390 x 844 (phone) and 1440 x 900 (desktop), finds the terminal's frame inside
// SIGN_HOST's shell, waits for the pool rows to leave loading, opens each and reads:
//   - the release's pool pins (apps/terminal/src/screens/verify/release.ts) are the deploy records': on mainnet the
//     Solana program, programdata, code length and sha256 of contracts/pool-solana/deployments/mainnet.json, each EVM
//     pool the PrivacyPoolSimple of contracts/pool-evm/deployments/<chain>.json, its code hash the keccak256 of that
//     address's eth_getCode in pool-evm-deploy-mainnet.answers.json (the deploy's read-back) on both of its RPCs; on a
//     network with no pool record (testnet) no pool is named;
//   - with a pool named: its row and every check ok (Solana: no upgrade authority, the code's sha256 the pin; Base and
//     Robinhood: no owner, no EIP-1967 slot, the code's keccak256 the pin), the two RPCs it names the release's pair,
//     this page asked each of them itself (a POST from the terminal's frame) and each answered 200, and the row links
//     its two explorers at the pinned address;
//   - with no pool named: every check Unverified and no request to a pool RPC;
//   - no pool read went through the helper (no request from the frame to its /v1/rpc/ paths while the panel read);
//   - no CSP violation and no console error in the terminal's frame.
// A screenshot of each width with every pool row open is kept.
// After: app --network {network}
//   node scripts/live-checks/verify-pools.mjs [--network mainnet|testnet] [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST/verify as it is served (--network: the network its build names; mainnet when not given)
//   node scripts/live-checks/verify-pools.mjs --harness [--build <dir>] [--network mainnet|testnet] [--plant authority] ...
//     a local build on the hosts' real names (app-verify-mount.mjs harnessRoute: app-in-shell's stand-in shell), the
//     release's NEAR and pool RPCs real, reached over the network; --plant authority rewrites the Solana programdata's
//     answer to name an upgrade authority, so the run records the red row (the test's bad answer)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import "../net-window.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { APP_HOST, harnessRoute, recorded, watch, WIDTHS } from "./app-verify-mount.mjs";
import { downNote, downStatus, footerEvidence, outages, verifyEvidence } from "./rpc-outage.mjs";

const KEY = "verify-pools";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PATH = "/verify";
export const CHAINS = ["solana", "base", "robinhood"];
export const CHECKS = { solana: ["authority", "poolCode"], base: ["owner", "proxy", "poolCode"], robinhood: ["owner", "proxy", "poolCode"] };
export const HELPER = "https://ct-api.unrealized.trade";
const READY_MS = 20_000;
const READ_MS = 30_000;

// @noble/hashes from the helper's own dependencies, as pool-evm-deploy.mjs loads it (a static name, so check:imports reads it)
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { keccak_256 } = req("@noble/hashes/sha3.js");
const keccak = (hex) => `0x${Buffer.from(keccak_256(Buffer.from(hex.slice(2), "hex"))).toString("hex")}`;

// ------------------------------------------------------------------------------------------------ the pins
export const SOL_RECORD = path.join(REPO, "contracts/pool-solana/deployments/mainnet.json");
export const evmRecordPath = (chain) => path.join(REPO, "contracts/pool-evm/deployments", `${chain}.json`);
export const EVM_READBACK = path.join(REPO, "scripts/live-checks/pool-evm-deploy-mainnet.answers.json");

/** What the deploy records say each mainnet pool's pins are; null on a network with no pool record. */
export function recordPins(network) {
  if (network !== "mainnet") return { solana: null, base: null, robinhood: null };
  const s = JSON.parse(readFileSync(SOL_RECORD, "utf8"));
  const readback = JSON.parse(readFileSync(EVM_READBACK, "utf8")).good;
  const evm = (chain) => {
    if (!existsSync(evmRecordPath(chain))) return null;
    const address = JSON.parse(readFileSync(evmRecordPath(chain), "utf8")).contracts.PrivacyPoolSimple.address.toLowerCase();
    // the code hash both of the read-back's RPCs gave for the address, or null when they gave none or two
    const hashes = new Set(readback.filter((a) => a.method === "eth_getCode" && String(a.params[0]).toLowerCase() === address && typeof a.json?.result === "string").map((a) => keccak(a.json.result)));
    const urls = new Set(readback.filter((a) => a.method === "eth_getCode" && String(a.params[0]).toLowerCase() === address).map((a) => a.url));
    return { address, codeHash: hashes.size === 1 && urls.size >= 2 ? [...hashes][0] : null };
  };
  return {
    solana: { program: s.program_id, programdata: s.programdata, codeLen: Number(s.so_len), codeSha256: s.so_sha256 },
    base: evm("base"),
    robinhood: evm("robinhood"),
  };
}

/** Problems between release.ts's pool pins (each chain's `pin`, or null) and the records'; none when they agree. */
export function pinsProblems(network, pins, records) {
  const out = [];
  for (const c of CHAINS) {
    const [p, r] = [pins?.[c] ?? null, records[c]];
    if (r === null) {
      if (p !== null) out.push(`release.ts names a ${c} pool on ${network}, but no deploy record exists`);
      continue;
    }
    if (p === null) {
      out.push(`a deploy record names the ${c} pool on ${network}, but release.ts names none`);
      continue;
    }
    for (const k of Object.keys(r)) if (r[k] === null || p[k] !== r[k]) out.push(`release.ts ${c} ${k} ${p[k]}, the record ${r[k]}`);
    for (const k of Object.keys(p)) if (!(k in r)) out.push(`release.ts ${c} ${k} is in no record`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the verdict
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u);
  }
};
export const EXPLORERS = {
  solana: (a) => [`https://solscan.io/account/${a}`, `https://explorer.solana.com/address/${a}`],
  base: (a) => [`https://basescan.org/address/${a}`, `https://base.blockscout.com/address/${a}`],
  robinhood: (a) => [`https://robinhoodchain.blockscout.com/address/${a}`, `https://hoodscan.co/address/${a}`],
};
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const addressOf = (c, pin) => (c === "solana" ? pin.program : pin.address);

function judgeRow(say, n, c, row, release, reqs, shown = new Set()) {
  const named = release[c] ?? null;
  if (!row) return say(false, `${n} ${c}: no pool row`);
  const checks = row.checks ?? {};
  const want = CHECKS[c];
  const poolPosts = (reqs ?? []).filter((x) => x.method === "POST" && x.phase === "open" && (named?.rpcs ?? []).some((u) => host(u) === host(x.url)));
  if (!named) {
    const unv = want.every((k) => checks[k]?.status === "warn" && checks[k]?.word === "Unverified") && Object.keys(checks).length === want.length;
    say(row.status === "warn" && unv && row.rpcs.length === 0, `${n} ${c}: no pool named: row ${row.status}, ${want.map((k) => `${k} ${checks[k]?.status ?? "none"}`).join(", ")}, RPCs ${row.rpcs.join(" ") || "none"}`);
    return;
  }
  // a pool RPC down that the page shows (rpc-outage.mjs: its failed load let through by this chain's row amber in the same
  // load) draws the row amber with its checks ok or Unverified, at least one Unverified; any other warn, "RPCs disagree"
  // or danger fails as before (card app-shell-rpc-outage-judge)
  const isDown = named.rpcs.some((u) => shown.has(originOf(u)));
  const keys = Object.keys(checks).length === want.length && want.every((k) => k in checks);
  const allOk = want.every((k) => checks[k]?.status === "ok" && !checks[k]?.word) && keys;
  const unverified = (k) => checks[k]?.status === "warn" && checks[k]?.word === "Unverified";
  const downOk = isDown && keys && row.status === "warn" && want.every((k) => unverified(k) || (checks[k]?.status === "ok" && !checks[k]?.word)) && want.some(unverified);
  say(isDown ? downOk : row.status === "ok" && allOk, `${n} ${c}: row ${row.status}; ${want.map((k) => `${k} ${checks[k]?.status ?? "none"}${checks[k]?.word ? ` (${checks[k].word})` : ""}`).join(", ")}`);
  const pair = named.rpcs.map(host);
  say(row.rpcs.length === 2 && row.rpcs.every((r, i) => r === pair[i]), `${n} ${c}: the row names ${row.rpcs.join(" and ") || "no RPC"}, want ${pair.join(" and ")}`);
  const asked = named.rpcs.map((u) => {
    const q = poolPosts.filter((x) => host(x.url) === host(u));
    // a read of an RPC the page shows down answers 5xx, 429 or nothing; a 4xx is no outage and fails
    return { u, n: q.length, ok: q.length > 0 && q.every((x) => x.status === 200 || (shown.has(originOf(u)) && downStatus(x.status))) };
  });
  say(asked.every((a) => a.ok), `${n} ${c}: this page read ${asked.map((a) => `${host(a.u)} ${a.n} time(s)${a.ok ? ", all 200" : ", not all 200"}`).join(" and ")}`);
  const links = EXPLORERS[c](addressOf(c, named.pin));
  say(JSON.stringify(row.links) === JSON.stringify(links), `${n} ${c}: explorer links ${JSON.stringify(row.links ?? [])}${JSON.stringify(row.links) === JSON.stringify(links) ? "" : `, want ${JSON.stringify(links)}`}`);
}

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const release = rec.release ?? null;
  const pinErr = release === null || rec.records === undefined ? ["the run recorded no release pins or deploy records"] : pinsProblems(rec.network, Object.fromEntries(CHAINS.map((c) => [c, release[c]?.pin ?? null])), rec.records);
  say(pinErr.length === 0, `pool pins on ${rec.network}: ${pinErr.length ? pinErr.join("; ") : CHAINS.map((c) => `${c} ${release[c] ? addressOf(c, release[c].pin) : "none"}`).join(", ")}, as the deploy records`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = `${r.width} ${PATH}`;
    if (!r.pools || r.pools.state !== "read") {
      say(false, `${n}: the pool rows ${r.pools ? `stayed ${r.pools.state}` : "were not drawn"} (${r.frame ?? "no frame"})`);
      continue;
    }
    // what the page shows of a down RPC, from this run's console errors and the DOM (rpc-outage.mjs)
    const { kept, down, verifyDown } = outages(r.errors ?? [], r.dom?.verify, rec.network, r.dom?.footer);
    const shown = new Set(verifyDown);
    for (const c of CHAINS) judgeRow(say, n, c, r.pools.rows[c], release ?? {}, r.requests, shown);
    const viaHelper = (r.requests ?? []).filter((x) => x.phase === "open" && x.url.startsWith(`${HELPER}/v1/rpc/`));
    say(viaHelper.length === 0, `${n}: no pool read through the helper${viaHelper.length ? `: ${viaHelper.map((x) => new URL(x.url).pathname).join(", ")}` : ""}`);
    // a down RPC the page shows is no error (rpc-outage.mjs, card app-shell-rpc-outage-judge): the same judgment as app-shell's
    const errs = [...(r.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...kept.map((e) => `console ${e}`)];
    say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : `no CSP violation, no console error${downNote(down)}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const INIT = ({ app }) => {
  if (location.origin !== app || window.top === window) return;
  window.__ctViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
};

const READ_POOLS = () => {
  const box = document.querySelector(".vpools");
  if (!box) return null;
  const rows = {};
  for (const s of box.querySelectorAll("[data-pool]")) {
    rows[s.dataset.pool] = {
      status: s.dataset.status,
      checks: Object.fromEntries([...s.querySelectorAll("[data-check]")].map((e) => [e.dataset.check, { status: e.dataset.status, word: e.querySelector(".st")?.textContent ?? null }])),
      rpcs: [...s.querySelectorAll(".rpcline")].map((e) => e.textContent),
      links: [...s.querySelectorAll("a[data-explorer]")].map((e) => e.getAttribute("href")),
    };
  }
  return { state: box.dataset.pools, rows };
};

async function appFrame(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(APP_HOST));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne({ browser, w, shots, route }) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, frame: null, pools: null, requests: [], violations: [], errors: [] };
  try {
    if (route) await ctx.route("**/*", route);
    await ctx.addInitScript(INIT, { app: APP_HOST });
    const page = await ctx.newPage();
    let phase = "open";
    const byReq = new Map();
    page.on("request", (q) => {
      if (q.frame().url().startsWith(APP_HOST) && q.frame() !== page.mainFrame()) {
        const e = { url: q.url(), method: q.method(), status: null, phase };
        byReq.set(q, e);
        run.requests.push(e);
      }
    });
    page.on("response", (res) => {
      const e = byReq.get(res.request());
      if (e) e.status = res.status();
    });
    watch(page, run.errors);
    await page.goto(APP_HOST + PATH, { waitUntil: "commit" });
    const f = await appFrame(page);
    if (!f) return run;
    run.frame = f.url();
    await f.waitForSelector(".vpools[data-pools='read']", { timeout: READ_MS }).catch(() => {});
    phase = "after";
    for (const c of CHAINS) await f.click(`[data-control="verify-pool-${c}"]`, { timeout: 2_000 }).catch(() => {});
    run.pools = await f.evaluate(READ_POOLS);
    // what the page shows of the RPCs it read, for judge()'s outages(): the panel's rows once its reads end, the footer
    run.dom = { verify: await verifyEvidence(f), footer: await footerEvidence(f) };
    if (shots) {
      await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}.png`) });
      await f.evaluate(() => document.querySelector(".vbody")?.scrollTo(0, 1e6));
      await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}-end.png`) });
    }
    run.violations = await f.evaluate(() => window.__ctViolations ?? []);
    return run;
  } finally {
    await ctx.close();
  }
}

/** The pool pins of the release as a record keeps them: each chain's pair and pin, or null. */
const releaseOf = (pools) => Object.fromEntries(CHAINS.map((c) => [c, pools[c] ? { rpcs: [...pools[c].rpcs], pin: { ...pools[c].pin } } : null]));

export async function collect({ shots, route = null, network, source }) {
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  if (!release) throw new Error(`network takes ${Object.keys(VERIFY_RELEASES).join(", ")}`);
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne({ browser, w, shots, route }));
    return { check: KEY, at: new Date().toISOString(), source, network, release: releaseOf(release.pools), records: recordPins(network), browser: browser.version(), runs };
  } finally {
    await browser.close();
  }
}

/** A route that answers the Solana programdata read with an upgrade authority named (the bad recording's plant). */
const plantAuthority = (pass) => async (route) => {
  const body = route.request().postData() ?? "";
  if (!body.includes('"getMultipleAccounts"')) return pass(route);
  const res = await route.fetch();
  const j = await res.json();
  const v = j?.result?.value?.[1];
  if (v?.data?.[0]) {
    const b = Buffer.from(v.data[0], "base64");
    b[12] = 1;
    b.fill(7, 13, 45);
    v.data[0] = b.toString("base64");
  }
  return route.fulfill({ response: res, body: JSON.stringify(j) });
};

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const harness = args.includes("--harness");
  const network = opt("--network") ?? "mainnet";
  const plant = opt("--plant");
  if (plant !== undefined && (plant !== "authority" || !harness)) throw new Error("--plant takes authority, with --harness only");
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  if (!release) throw new Error(`--network takes ${Object.keys(VERIFY_RELEASES).join(", ")}`);
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const poolRpcs = CHAINS.flatMap((c) => release.pools[c]?.rpcs ?? []);
  const pass = (route) => route.continue();
  const route = harness ? await harnessRoute(build, [...release.rpcs, ...poolRpcs], plant ? plantAuthority(pass) : pass) : null;
  const source = harness ? `harness, terminal build, the release's ${network} NEAR and pool RPCs live${plant ? `, Solana ${plant} planted` : ""}` : `live ${APP_HOST}`;
  const rec = await collect({ shots, route, network, source });
  const record = opt("--record");
  // each URL's token query written as <mint> (app-verify-mount.mjs recorded), so no long base58 reads as a key
  if (record) writeFileSync(record, recorded(rec));
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
