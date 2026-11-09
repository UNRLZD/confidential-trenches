// node --test scripts/live-checks/verify-pools.test.mjs: the live check replays its recorded runs
// (verify-pools.answers.json, whose notes say how each was made): good, the terminal build in the harness reading the
// mainnet pools live: PASS; bad, the same with an upgrade authority planted in the Solana programdata's answer: FAIL on
// the Solana row alone. The other bad answers are the good one with one fact changed. And the release's pool pins are
// the deploy records' as they are in this checkout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, judge, pinsProblems, recordPins } from "./verify-pools.mjs";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { consoleLine } from "./console-errors.mjs";

const A = JSON.parse(readFileSync(new URL("./verify-pools.answers.json", import.meta.url), "utf8"));
const bad = (r) => judge(r).lines.filter((l) => l.startsWith("BAD"));
const mutate = (f) => {
  const r = structuredClone(A.good);
  f(r);
  return r;
};

test("recorded good answer: every pool row ok, read by the page on its pair, its explorers linked: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const w of ["phone", "desktop"]) for (const c of CHAINS) assert.ok(r.lines.some((l) => l.startsWith(`ok  ${w} /verify ${c}: row ok`)), `${w} ${c}`);
});

test("recorded bad answer: a planted upgrade authority turns the Solana row red: FAIL on that row alone", () => {
  assert.equal(judge(A.bad).ok, false);
  assert.deepEqual(bad(A.bad), ["BAD phone /verify solana: row danger; authority danger, poolCode ok", "BAD desktop /verify solana: row danger; authority danger, poolCode ok"]);
});

test("a pool read through the helper, an RPC of the pair not asked or not 200, a CSP violation: FAIL", () => {
  const helper = mutate((r) => r.runs[0].requests.push({ url: "https://ct-api.unrealized.trade/v1/rpc/solana", method: "POST", status: 200, phase: "open" }));
  assert.deepEqual(bad(helper), ["BAD phone /verify: no pool read through the helper: /v1/rpc/solana"]);
  const unasked = mutate((r) => (r.runs[1].requests = r.runs[1].requests.filter((x) => !x.url.startsWith("https://robinhood.drpc.org"))));
  assert.match(bad(unasked).join("\n"), /desktop \/verify robinhood: this page read robinhood\.drpc\.org 0 time\(s\), not all 200/);
  const refused = mutate((r) => r.runs[0].requests.filter((x) => x.url.startsWith("https://solana.api.pocket.network")).forEach((x) => (x.status = 403)));
  assert.match(bad(refused).join("\n"), /phone \/verify solana: this page read .* solana\.api\.pocket\.network 1 time\(s\), not all 200/);
  const csp = mutate((r) => r.runs[1].violations.push({ directive: "connect-src", blocked: "https://solana.api.pocket.network/" }));
  assert.deepEqual(bad(csp), ["BAD desktop /verify: CSP connect-src https://solana.api.pocket.network/"]);
});

test("a row amber or red, another RPC named, an explorer link off, the rows never drawn: FAIL", () => {
  const amber = mutate((r) => Object.assign(r.runs[0].pools.rows.base, { status: "warn" }, { checks: { ...r.runs[0].pools.rows.base.checks, owner: { status: "warn", word: "RPCs disagree" } } }));
  assert.deepEqual(bad(amber), ["BAD phone /verify base: row warn; owner warn (RPCs disagree), proxy ok, poolCode ok"]);
  const other = mutate((r) => (r.runs[1].pools.rows.solana.rpcs[1] = "solana-rpc.example.org"));
  assert.match(bad(other).join("\n"), /desktop \/verify solana: the row names solana-rpc\.publicnode\.com and solana-rpc\.example\.org/);
  const link = mutate((r) => (r.runs[0].pools.rows.robinhood.links[1] = "https://hoodscan.co/address/0x0"));
  assert.match(bad(link).join("\n"), /phone \/verify robinhood: explorer links/);
  const never = mutate((r) => (r.runs[1].pools = { state: "loading", rows: {} }));
  assert.match(bad(never).join("\n"), /desktop \/verify: the pool rows stayed loading/);
});

test("pins: release.ts's pools are the deploy records' (mainnet), none on testnet; a pin off by one: FAIL", () => {
  const pins = (net) => Object.fromEntries(CHAINS.map((c) => [c, VERIFY_RELEASES[net].pools[c]?.pin ?? null]));
  assert.deepEqual(pinsProblems("mainnet", pins("mainnet"), recordPins("mainnet")), []);
  assert.deepEqual(pinsProblems("testnet", pins("testnet"), recordPins("testnet")), []);
  const rec = recordPins("mainnet");
  assert.equal(rec.base.codeHash, "0xcac5a62a0ac95b9dd1323c57a2561fe3eb56292c82c5d3a5390c95e522ff786d");
  assert.equal(rec.robinhood.codeHash, "0x4052383ebda1543cc4e9d8f51a03cdc631f4562d763c60508ef870189f8747c7");
  const off = mutate((r) => (r.release.base.pin.address = "0xaa080e74ec99cf5c684548c77ca145edfcf899ce"));
  assert.match(bad(off).join("\n"), /release\.ts base address 0xaa080e74ec99cf5c684548c77ca145edfcf899ce, the record 0xaa080e74ec99cf5c684548c77ca145edfcf899cf/);
  const sha = mutate((r) => (r.release.solana.pin.codeSha256 = "0".repeat(64)));
  assert.match(bad(sha).join("\n"), /release\.ts solana codeSha256 0{64}, the record c86fc7fc/);
  const extra = mutate((r) => (r.records.robinhood = null));
  assert.match(bad(extra).join("\n"), /release\.ts names a robinhood pool on mainnet, but no deploy record exists/);
});

test("no pool named: every row must be Unverified and no pool RPC asked", () => {
  const none = mutate((r) => {
    r.release = { solana: null, base: null, robinhood: null };
    r.records = { solana: null, base: null, robinhood: null };
  });
  // the recorded rows are green: a network with no pool named must draw none of them as read
  assert.match(bad(none).join("\n"), /phone \/verify solana: no pool named: row ok/);
});

test("planted on the good answer: a down pool RPC's preflight error is let through when the page shows its row amber, never when it shows ok (card app-shell-rpc-outage-judge)", () => {
  const solana = new URL(VERIFY_RELEASES.mainnet.pools.solana.rpcs[0]).origin;
  const cors = consoleLine(`Access to fetch at '${solana}/' from origin 'https://ct-app.unrealized.trade' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.`, "https://ct-app.unrealized.trade/verify");
  const line = (r) => judge(r).lines.find((l) => l.includes("phone /verify: ") && /no console error|console /.test(l));
  const plant = (errors, dom) => line(mutate((r) => Object.assign(r.runs[0], { errors, dom })));
  const dom = (solanaRow) => ({ verify: { state: "read", code: "ok", funds: "ok", pools: { solana: solanaRow, base: "ok", robinhood: "ok" } }, footer: null });
  assert.equal(plant([cors], dom("warn")), `ok  phone /verify: no CSP violation, no console error; RPC down, shown: ${solana.replace("https://", "")}`);
  assert.match(plant([cors], dom("ok")), /^BAD phone \/verify: console Access to fetch .*\[.* is a release RPC, not shown Unverified: solana ok\]$/);
  assert.match(plant([cors]), /not shown Unverified: solana not drawn\]$/);
  assert.match(plant([cors, "Uncaught boom"], dom("warn")), /^BAD phone \/verify: console Uncaught boom$/);
});

test("planted on the good answer: an amber pool row and its RPC's failed reads pass only beside a shown outage that this open's own reads bear out (card app-shell-rpc-outage-judge)", () => {
  const rpcs = VERIFY_RELEASES.mainnet.pools.solana.rpcs;
  const first = new URL(rpcs[0]).origin;
  const load = (origin, status) => consoleLine(`Failed to load resource: the server responded with a status of ${status} ()`, `${origin}/`);
  const dom = (solana) => ({ verify: { state: "read", code: "ok", funds: "ok", pools: { solana, base: "ok", robinhood: "ok" } }, footer: null });
  const run = ({ errors = [load(first, 503)], d = dom("warn"), checks, status = 503, failure, only = false, origin = first, row = "warn" } = {}) =>
    bad(mutate((r) => {
      const x = r.runs[0];
      x.errors = errors;
      x.dom = d;
      const s = x.pools.rows.solana;
      s.status = row;
      for (const k of Object.keys(s.checks)) s.checks[k] = checks?.[k] ?? { status: "warn", word: "Unverified" };
      const reads = x.requests.filter((q) => q.method === "POST" && q.url.startsWith(origin));
      for (const q of only ? reads.slice(0, 1) : reads) {
        q.status = status;
        if (failure) q.failure = failure;
      }
    }));
  // the shown outage: the row amber, every check Unverified, every read of the first RPC failed: nothing fails
  assert.deepEqual(run(), []);
  assert.deepEqual(run({ status: 429, errors: [load(first, 429)] }), []);
  // no answer: passes with the browser's failure text, fails with none, fails when the page aborted the read itself
  assert.deepEqual(run({ status: null, failure: "net::ERR_FAILED" }), []);
  assert.match(run({ status: null }).join("\n"), /phone \/verify solana: row warn/);
  assert.match(run({ status: null, failure: "net::ERR_ABORTED" }).join("\n"), /phone \/verify solana: row warn/);
  // (c) every check Unverified with the RPC's one read answering 200 and a failed load of it in the console
  assert.match(run({ status: 200 }).join("\n"), /phone \/verify solana: row warn/);
  // a check that still read ok beside an Unverified one passes when the RPC's read failed; with the read answering 200 it fails
  const mixed = A.good.runs[0].pools.rows.solana.checks;
  const oneOk = { [Object.keys(mixed)[0]]: { status: "ok", word: null } };
  assert.deepEqual(run({ checks: oneOk }), []);
  assert.match(run({ checks: oneOk, status: 200 }).join("\n"), /phone \/verify solana: row warn/);
  // the same amber row with no failed load, or with the page's DOM showing the row ok, is an unexplained warn
  assert.match(run({ errors: [] }).join("\n"), /phone \/verify solana: row warn/);
  assert.match(run({ d: dom("ok") }).join("\n"), /console Failed to load resource/);
  // an amber row where every check is ok, RPCs disagree or a check is red is no outage
  assert.match(run({ checks: Object.fromEntries(Object.keys(mixed).map((k) => [k, { status: "ok", word: null }])) }).join("\n"), /phone \/verify solana: row warn/);
  assert.match(run({ checks: Object.fromEntries(Object.keys(mixed).map((k) => [k, { status: "warn", word: "RPCs disagree" }])) }).join("\n"), /phone \/verify solana: row warn/);
  assert.match(run({ row: "danger", d: dom("danger") }).join("\n"), /phone \/verify solana: row danger/);
  // a 4xx other than 429 on the down RPC's reads, or a non-200 read of the RPC not shown down, fails
  assert.match(run({ status: 403 }).join("\n"), /phone \/verify solana: row warn|phone \/verify solana: this page read .* not all 200/);
  assert.match(run({ origin: new URL(rpcs[1]).origin, status: 500 }).join("\n"), /phone \/verify solana: this page read .* not all 200/);
  // a page error beside the outage still fails; an app script printing Chrome's preflight words from its own file is no preflight line
  assert.match(run({ errors: [load(first, 503), "Uncaught boom"] }).join("\n"), /phone \/verify: console Uncaught boom$/);
  const words = `Access to fetch at '${first}/' from origin 'https://ct-app.unrealized.trade' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.`;
  assert.match(run({ errors: [consoleLine(words, "https://ct-app.unrealized.trade/assets/index-abc.js")] }).join("\n"), /console Access to fetch/);
});
