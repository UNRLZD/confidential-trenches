// node --test scripts/live-checks/page-evm-rpc-csp.test.mjs: card page-evm-rpc-csp. The live check replays its recorded
// answers (page-evm-rpc-csp.answers.json). good: this card's branch built by each host's deploy --dry-run
// (apps/terminal/scripts/deploy.mjs, packages/signpage/scripts/deploy.mjs) and served by the Pages runtime of wrangler
// 4.151.1 on a Mac, 2026-11-07: PASS. bad: the live APP_HOST and SIGN_HOST the same day, before the card's deploy
// (neither connect-src names any EVM provider): FAIL. And it holds both committed _headers files to the kit's EVM venue
// lists, read from the kit: a provider the kit adds or swaps in that a page's policy misses fails here, in CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { CSP as APP_PIN } from "./app-host-gate.mjs";
import { connectSrc, evmOrigins, judge, PAGES, read } from "./page-evm-rpc-csp.mjs";
import { CSP as SIGN_PIN } from "./signpage-skeleton.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./page-evm-rpc-csp.answers.json", import.meta.url), "utf8"));
// each page's committed _headers file, read as data from the repo root (as app-in-shell and balances-per-chain read it)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = { app: path.join(REPO, "apps/terminal/public/_headers"), sign: path.join(REPO, "packages/signpage/public/_headers") };
const PINS = { app: APP_PIN, sign: SIGN_PIN };
const text = (page) => readFileSync(FILES[page], "utf8");
// the policy a _headers file's /* rule sets on the page (its first Content-Security-Policy line, the /* rule's)
const cspOf = (t) => /^\/\*\n(?: {2}[^\n]*\n)*? {2}Content-Security-Policy: ([^\n]*)/m.exec(t)?.[1];
const served = (texts) => Object.fromEntries(Object.keys(PAGES).map((p) => [p, { url: PAGES[p], status: 200, csp: cspOf(texts[p]) }]));
const shipped = () => served({ app: text("app"), sign: text("sign") });
const replay = (a) => async () => ({ status: a.status, headers: new Headers(a.csp === null ? {} : { "content-security-policy": a.csp }) });
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the kit's EVM venues: Base, Robinhood and both testnets, every provider an origin with no path, each once", () => {
  const v = evmPoolVenues();
  assert.deepEqual(Object.keys(v), ["base", "robinhood", "base-sepolia", "robinhood-testnet"]);
  const o = evmOrigins();
  assert.equal(new Set(o).size, o.length);
  for (const x of o) assert.equal(new URL(x).origin, x);
  // the quote list, the fee pair, the pool's list and the scan's provider and spares of every chain, each by its origin
  for (const c of Object.keys(v)) {
    const lists = [v[c].providers, v[c].feeProviders, v[c].poolProviders, v[c].scan && [v[c].scan.url], v[c].scan?.spares?.map((s) => s.url)];
    for (const u of lists.flat().filter(Boolean)) assert.ok(o.includes(new URL(u).origin), `${c} ${u}`);
  }
  // a provider whose URL has a path is named by its origin only (Sentio's Base scan spare is /base on rpc.sentio.xyz)
  assert.ok(v.base.scan.spares.some((s) => s.url === "https://rpc.sentio.xyz/base"));
  assert.ok(o.includes("https://rpc.sentio.xyz") && !o.includes("https://rpc.sentio.xyz/base"));
});

test("recorded good answer: both pages' served connect-src name every kit EVM provider: PASS", async () => {
  const a = { app: await read(ANSWERS.good.app.url, replay(ANSWERS.good.app)), sign: await read(ANSWERS.good.sign.url, replay(ANSWERS.good.sign)) };
  const r = judge(a);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  app: connect-src names every kit EVM provider (${evmOrigins().length})`));
  assert.ok(r.lines.includes(`ok  sign: connect-src names every kit EVM provider (${evmOrigins().length})`));
});

test("recorded bad answer: the live hosts before the card name no EVM provider: FAIL on both pages", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const all = evmOrigins().join(" ");
  assert.deepEqual(bads(r), [`BAD app: connect-src names every kit EVM provider: lacks ${all}`, `BAD sign: connect-src names every kit EVM provider: lacks ${all}`]);
  // --host reads one page alone
  assert.deepEqual(bads(judge({ sign: ANSWERS.bad.sign }, evmOrigins(), ["sign"])), [`BAD sign: connect-src names every kit EVM provider: lacks ${all}`]);
});

test("both committed _headers files name every kit EVM provider, and each page's connect-src is its pinned policy's", () => {
  const r = judge(shipped());
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const p of Object.keys(PAGES)) {
    assert.deepEqual(connectSrc(cspOf(text(p))), PINS[p].find(([k]) => k === "connect-src")[1].split(" "), `${p}: _headers and its pin are one policy`);
  }
});

test("planted: any one kit EVM provider taken out of either _headers file: FAIL, naming it", () => {
  for (const p of Object.keys(PAGES)) for (const o of evmOrigins()) {
    const t = text(p);
    assert.equal(t.split(` ${o} `).length + t.split(` ${o};`).length, 3, `${p} names ${o} once`);
    const cut = t.replace(new RegExp(` ${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[ ;])`), "");
    const r = judge(served({ ...{ app: text("app"), sign: text("sign") }, [p]: cut }));
    assert.equal(r.ok, false, `${p} ${o}`);
    assert.deepEqual(bads(r), [`BAD ${p}: connect-src names every kit EVM provider: lacks ${o}`]);
  }
});

test("planted: a provider the kit swaps in that no header names: FAIL on both pages", () => {
  const v = evmPoolVenues();
  const swapped = { ...v, base: { ...v.base, providers: ["https://base.new-rpc.example", ...v.base.providers.slice(1)] } };
  const r = judge(shipped(), evmOrigins(swapped));
  assert.deepEqual(bads(r), ["BAD app: connect-src names every kit EVM provider: lacks https://base.new-rpc.example", "BAD sign: connect-src names every kit EVM provider: lacks https://base.new-rpc.example"]);
});

test("planted: a wildcard in place of the hosts, no connect-src, no policy, two policies, a non-200: FAIL", () => {
  const s = shipped();
  const wild = { ...s, app: { ...s.app, csp: s.app.csp.replace("https://base-rpc.publicnode.com", "https://*.publicnode.com") } };
  assert.ok(bads(judge(wild)).includes("BAD app: connect-src holds no wildcard: https://*.publicnode.com"));
  assert.ok(bads(judge({ ...s, sign: { ...s.sign, csp: s.sign.csp.replace(/connect-src [^;]*;/, "") } })).includes("BAD sign: CSP has no connect-src"));
  assert.ok(bads(judge({ ...s, sign: { ...s.sign, csp: null } })).includes("BAD sign: Content-Security-Policy: none sent"));
  assert.ok(bads(judge({ ...s, app: { ...s.app, csp: `${s.app.csp}, default-src *` } })).includes("BAD app: CSP is one policy: it holds a comma"));
  assert.ok(bads(judge({ ...s, app: { ...s.app, status: 522 } })).includes(`BAD app: GET ${PAGES.app} answers 522`));
  assert.ok(bads(judge({ app: s.app })).includes("BAD sign: no answer"));
});
