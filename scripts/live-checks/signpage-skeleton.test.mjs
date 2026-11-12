// node --test scripts/live-checks/signpage-skeleton.test.mjs: the live check replays recorded answers
// (signpage-skeleton.answers.json). good: packages/signpage built by deploy.mjs --dry-run and served by the Pages
// runtime of wrangler 4.151.1 (re-recorded on a Linux build machine for card signpage-solana-trade's connect-src, and on a Mac for card page-evm-rpc-csp's,
// deploy.mjs --dry-run's build, 2026-11-07, its pre-card answer kept as beforeEvm: FAIL; and on a Mac for card held-move-forgotten-tx's
// archival RPC, 2026-11-08, the answer before it kept as beforeArchival: FAIL; on a Mac for card wallet-restore-reads-ux's Pocket
// Solana gateway, deploy.mjs --build's build, 2026-11-09, the answer before it kept as beforePocket: FAIL; and on a Mac for card evm-pool-sync-holds' Base bloXroute beside it
// (deploy.mjs --build served by wrangler 4.151.1's pages dev, 2026-11-09), the answer before it kept as beforeHistory: FAIL;
// and on a Mac for card signing-views-open-over-the-app's Permissions-Policy (deploy.mjs --build served by wrangler 4.151.1's
// pages dev, 2026-11-12), the answer before it kept as beforePip: FAIL; SIGN_HOST answered 522 before any deploy, so no served answer existed
// yet): PASS. Card evm-pools-on-mainnet: SIGN_HOST's policy names the mainnets' EVM providers alone, so good is that
// recorded answer with the six testnet EVM providers taken out of its connect-src, as the build's _headers now sets it
// (no served answer of it until the next sign deploy), and the answer before is kept as beforeMainnetOnly: FAIL. The bad answers are that same answer with frame-ancestors taken out of the CSP, and with
// frame-ancestors *: FAIL. Card restore-shows-the-balance-in-seconds: the page's trusted-types names its second policy,
// walk-worker, beside prover-worker, so good is that answer with walk-worker added to trusted-types, as the build's
// _headers now sets it (no served answer of it until the next sign deploy: SIGN_HOST fails this line until then, as it
// did each card above until its deploy), and the answer before is kept as beforeWalk: FAIL on trusted-types alone. predeploy: SIGN_HOST's real 522 before any deploy: FAIL. framed: the live SIGN_HOST before
// card signpage-shell (APP_HOST framed it; no frame-src, no Origin-Agent-Cluster): FAIL. Card near-holdings-restore: the page's connect-src names
// the NEAR FT list (https://api.fastnear.com), so good is that answer with it added after the archival RPCs, as the
// build's _headers now sets it (no served answer of it until the next sign deploy), and the answer before is kept as
// beforeFtList: FAIL on connect-src alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmOrigins, SIGN_CHAINS, venuesOf } from "./page-evm-rpc-csp.mjs";
import { CSP, frameAllowed, HEADERS, judge, POOL_HISTORY, read } from "./signpage-skeleton.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-skeleton.answers.json"), "utf8"));
// every answer recorded before card signing-views-open-over-the-app predates its Permissions-Policy (picture-in-picture
// and fullscreen denied): it fails that line too, and on nothing else that card changed
const PRE_PP = (rec) => `BAD permissions-policy: "${rec.headers["permissions-policy"]}", want "${HEADERS["permissions-policy"]}"`;
const GOOD = ANSWERS.good;
// every answer recorded before card restore-shows-the-balance-in-seconds names prover-worker alone in trusted-types
const PRE_TT = 'BAD CSP trusted-types: "prover-worker", want "prover-worker walk-worker"';
const APP = "https://ct-app.unrealized.trade";
// every answer recorded before card near-holdings-restore lacks the NEAR FT list (https://api.fastnear.com) in connect-src
const PRE_FT = (rec) => {
  const site = rec.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  return `BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${CSP.find(([k]) => k === "connect-src")[1]}"`;
};

const withCsp = (from, to) => {
  const csp = GOOD.headers["content-security-policy"];
  assert.ok(csp.includes(from), from);
  return { ...GOOD, headers: { ...GOOD.headers, "content-security-policy": csp.replace(from, to) } };
};

// a fetch that answers every request with one recorded answer
const replay = (a) => async () => ({ status: a.status, headers: new Headers(a.headers) });

test("recorded good answer: every header equals the policy: PASS", async () => {
  const r = judge(await read(undefined, replay(GOOD)));
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  CSP frame-ancestors: "'none'"`));
  assert.ok(r.lines.includes(`ok  CSP frame-src: "${APP}"`));
  assert.ok(r.lines.includes(`ok  framed from ${APP}: blocked`));
  assert.ok(r.lines.includes('ok  origin-agent-cluster: "?1"'));
  assert.ok(r.lines.includes("ok  framed from https://example.com: blocked"));
  assert.ok(r.lines.includes('ok  integrity-policy: "blocked-destinations=(script)"'));
});

test("recorded bad answer: the good build before card signing-views-open-over-the-app (picture-in-picture and fullscreen not denied): FAIL on the Permissions-Policy alone", () => {
  const r = judge(ANSWERS.beforePip);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [PRE_FT(ANSWERS.beforePip), PRE_TT, PRE_PP(ANSWERS.beforePip)]);
});

test("recorded bad answer: the good build before card restore-shows-the-balance-in-seconds (no walk-worker policy): FAIL on trusted-types alone", () => {
  const r = judge(ANSWERS.beforeWalk);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [PRE_FT(ANSWERS.beforeWalk), PRE_TT]);
});

test("recorded bad answer: the good build before card near-holdings-restore (no NEAR FT list in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforeFtList);
  const site = ANSWERS.beforeFtList.headers["content-security-policy"];
  assert.ok(!site.includes("https://api.fastnear.com"));
  assert.ok(CSP.find(([k]) => k === "connect-src")[1].split(" ").includes("https://api.fastnear.com"));
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [PRE_FT(ANSWERS.beforeFtList)]);
});

test("a trusted-types with a third policy, or 'allow-duplicates', is refused: FAIL", async () => {
  for (const to of ["trusted-types prover-worker walk-worker other", "trusted-types prover-worker walk-worker 'allow-duplicates'", "trusted-types walk-worker"]) {
    const r = judge(await read(undefined, replay(withCsp("trusted-types prover-worker walk-worker", to))));
    assert.equal(r.ok, false, to);
    assert.ok(r.lines.some((l) => l.startsWith("BAD CSP trusted-types:")), to);
  }
});

test("recorded bad answer: a CSP with no frame-ancestors: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp(" frame-ancestors 'none';", ""))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes(`BAD CSP frame-ancestors: none, want "'none'"`), r.lines.join("\n"));
  assert.ok(r.lines.includes("BAD framed from https://example.com: allowed (no frame-ancestors)"));
  assert.ok(r.lines.includes(`BAD framed from ${APP}: allowed (no frame-ancestors)`));
});

test("recorded bad answer: frame-ancestors *: FAIL", async () => {
  const r = judge(await read(undefined, replay(withCsp("frame-ancestors 'none'", "frame-ancestors *"))));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD framed from https://example.com: allowed"), r.lines.join("\n"));
});

test("recorded bad answer: the live SIGN_HOST before the shell (APP_HOST framed it): FAIL on the frame policy, and on the connect-src it predates", () => {
  const r = judge(ANSWERS.framed);
  assert.equal(r.ok, false);
  const site = ANSWERS.framed.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [
    `BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`,
    `BAD CSP frame-src: none, want "${APP}"`,
    `BAD CSP frame-ancestors: "${APP}", want "'none'"`,
    PRE_TT,
    `BAD framed from ${APP}: allowed`,
    'BAD origin-agent-cluster: none, want "?1"',
    PRE_PP(ANSWERS.framed),
  ]);
});

test("recorded bad answer: the good build before card page-evm-rpc-csp (no kit EVM provider in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforeEvm);
  assert.equal(r.ok, false);
  const site = ANSWERS.beforeEvm.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`, PRE_TT, PRE_PP(ANSWERS.beforeEvm)]);
});

test("recorded bad answer: the good build before card held-move-forgotten-tx (no archival RPC in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforeArchival);
  assert.equal(r.ok, false);
  const site = ANSWERS.beforeArchival.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`, PRE_TT, PRE_PP(ANSWERS.beforeArchival)]);
});

test("recorded bad answer: the good build before card evm-pools-on-mainnet (the six testnet EVM providers in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforeMainnetOnly);
  assert.equal(r.ok, false);
  const site = ANSWERS.beforeMainnetOnly.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  for (const h of ["https://base-sepolia-rpc.publicnode.com", "https://robinhood-testnet.drpc.org"]) assert.ok(site.includes(h) && !want.includes(h), h);
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`, PRE_TT, PRE_PP(ANSWERS.beforeMainnetOnly)]);
});

test("recorded bad answer: the good build before card evm-pool-sync-holds (no Base bloXroute in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforeHistory);
  assert.equal(r.ok, false);
  const site = ANSWERS.beforeHistory.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`, PRE_TT, PRE_PP(ANSWERS.beforeHistory)]);
});

test("card evm-pool-sync-holds: every origin of the kit's EVM_POOL_HISTORY is in the pinned connect-src, and POOL_HISTORY is exactly those the kit's venue origins leave out", async () => {
  const { EVM_POOL_HISTORY } = await import("../../packages/kit/src/index.ts");
  const history = [...new Set(Object.values(EVM_POOL_HISTORY).flat().map((u) => new URL(u).origin))];
  assert.ok(history.length >= 2, `the kit's history origins: ${history.join(" ")}`);
  const pinned = CSP.find(([k]) => k === "connect-src")[1].split(" ");
  for (const o of history) assert.equal(pinned.filter((x) => x === o).length, 1, `${o} once in the pinned connect-src`);
  const venues = evmOrigins(venuesOf(SIGN_CHAINS));
  assert.deepEqual(POOL_HISTORY.split(" "), history.filter((o) => !venues.includes(o)));
});

test("recorded bad answer: the good build before card wallet-restore-reads-ux (no Pocket Solana gateway in connect-src): FAIL on connect-src alone", () => {
  const r = judge(ANSWERS.beforePocket);
  assert.equal(r.ok, false);
  const site = ANSWERS.beforePocket.headers["content-security-policy"].split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
  const want = CSP.find(([k]) => k === "connect-src")[1];
  assert.ok(want.includes(" https://solana.api.pocket.network "), "the policy names the restore's second U_X operator");
  assert.deepEqual(r.lines.filter((l) => l.startsWith("BAD")), [`BAD CSP connect-src: "${site.slice("connect-src ".length)}", want "${want}"`, PRE_TT, PRE_PP(ANSWERS.beforePocket)]);
});

test("an origin not on the list beside Pocket's Solana gateway, or in its place, is still refused: FAIL", () => {
  for (const to of [
    "https://solana.api.pocket.network https://solana.api.pocket.network.example.com",
    "https://solana.api.pocket.network https://api.mainnet-beta.solana.com.example.com",
    "https://solana.api.example.network",
    "https://*.pocket.network",
    "https:",
  ]) {
    const r = judge(withCsp("https://solana.api.pocket.network", to));
    assert.equal(r.ok, false, to);
    assert.ok(r.lines.some((l) => l.startsWith("BAD CSP connect-src: ")), `${to}: ${r.lines.join("\n")}`);
  }
});

test("frame-src other than APP_HOST alone, and Origin-Agent-Cluster gone: FAIL", () => {
  for (const to of ["frame-src *", `frame-src ${APP} https://example.com`, "frame-src 'self'"]) {
    const r = judge(withCsp(`frame-src ${APP}`, to));
    assert.equal(r.ok, false, to);
  }
  const { "origin-agent-cluster": _, ...noOac } = GOOD.headers;
  assert.ok(judge({ ...GOOD, headers: noOac }).lines.includes('BAD origin-agent-cluster: none, want "?1"'));
});

test("recorded bad answers: font-src https: and font-src *: FAIL", async () => {
  for (const src of ["https:", "*"]) {
    const r = judge(await read(undefined, replay(withCsp("font-src 'self'", `font-src ${src}`))));
    assert.equal(r.ok, false, src);
    assert.ok(r.lines.includes(`BAD CSP font-src: "${src}", want "'self'"`), r.lines.join("\n"));
  }
  const gone = judge(withCsp(" font-src 'self';", ""));
  assert.ok(gone.lines.includes(`BAD CSP font-src: none, want "'self'"`), gone.lines.join("\n"));
});

test("recorded bad answers: a directive added, Integrity-Policy gone, X-Frame-Options sent, SIGN_HOST's 522: FAIL", async () => {
  const added = judge(withCsp("trusted-types prover-worker", "trusted-types prover-worker; report-uri https://evil.ct.test"));
  assert.ok(added.lines.includes("BAD CSP has no directive beyond the policy's: extra report-uri"), added.lines.join("\n"));
  const { "integrity-policy": _, ...noIp } = GOOD.headers;
  const ip = judge({ ...GOOD, headers: noIp });
  assert.ok(ip.lines.includes('BAD integrity-policy: none, want "blocked-destinations=(script)"'), ip.lines.join("\n"));
  const xfo = judge({ ...GOOD, headers: { ...GOOD.headers, "x-frame-options": "DENY" } });
  assert.ok(xfo.lines.includes('BAD x-frame-options: "DENY", want none'), xfo.lines.join("\n"));
  const two = judge({ ...GOOD, headers: { ...GOOD.headers, "content-security-policy": `${GOOD.headers["content-security-policy"]}, default-src *` } });
  assert.ok(two.lines.includes("BAD CSP is one policy: it holds a comma"), two.lines.join("\n"));
  const pre = judge(ANSWERS.predeploy);
  assert.equal(pre.ok, false);
  assert.equal(pre.lines[0], "BAD GET answers 522");
  assert.ok(pre.lines.includes('BAD x-frame-options: "SAMEORIGIN", want none'));
});

test("frameAllowed reads frame-ancestors source expressions as CSP3 does", () => {
  const ex = "https://example.com";
  assert.equal(frameAllowed([APP], APP), true);
  assert.equal(frameAllowed([APP], ex), false);
  assert.equal(frameAllowed(["'none'"], APP), false);
  assert.equal(frameAllowed(["'self'"], ex), false);
  assert.equal(frameAllowed(["'self'"], "https://confidential.unrealized.trade"), true);
  for (const s of ["*", "https:", "http:", "example.com", "*.com", "https://example.com:443", "http://example.com", "https://example.com/x", "example.com:*"])
    assert.equal(frameAllowed([s], ex), true, s);
  for (const s of ["https://example.com:8443", "*.example.com", "wss:", "https://example.org", "'unsafe-inline'"])
    assert.equal(frameAllowed([s], ex), false, s);
});

test("the CLI on a host that does not answer is an error, exit 2", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "signpage-skeleton.mjs"), "--url", "http://127.0.0.1:9/"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /live-check signpage-skeleton: ERROR: /);
});
