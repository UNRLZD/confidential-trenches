// node --test scripts/live-checks/verify-row-survives-one-provider.test.mjs: the live check replays recorded answers
// (verify-row-survives-one-provider.answers.json):
//   good: card solana-lists-drop-the-dead-provider's tree and build in the harness on a Mac, 26 Nov (the list's third
//         Tatum's keyless gateway, in Solana Vibe Station's place): the probe found all three Solana hosts answering,
//         publicnode refused on the phone and Pocket on the desktop, the Solana row ok on the two others: PASS;
//   before: card verify-check-plants-on-a-live-operator's good run of 13 Nov, its third Solana Vibe Station: on today's
//         list the row reads a host the list no longer names: FAIL;
//   bad:  the live APP_HOST on 12 Nov 23:45Z (its fixed Solana pair), the same refusals: the row Unverified with only the
//         planted host down: FAIL;
//   runner_lost_second: the good tree and build with Pocket also refusing the phone's page (as GitHub's runner did in
//         live run 43449871228): two of three down, the row warns: INCONCLUSIVE naming Pocket, never PASS. Recorded on
//         13 Nov, it replays with its third host named as today's list names it (LOST: the same page's walk).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERIFY_RELEASES } from "../../apps/terminal/src/screens/verify/release.ts";
import { noAnswerHosts } from "../ci/live-rerun.mjs";
import { EXIT } from "./provider-answer.mjs";
import { judge, plantsOf, probe } from "./verify-row-survives-one-provider.mjs";

const A = JSON.parse(readFileSync(new URL("./verify-row-survives-one-provider.answers.json", import.meta.url), "utf8"));
const bad = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const SOL = VERIFY_RELEASES.mainnet.pools.solana;
const POCKET = "solana.api.pocket.network";
// runner_lost_second, its third host Solana Vibe Station renamed to the list's third of today (card
// solana-lists-drop-the-dead-provider): the walk is the same page's, only the third's host changed
const LOST = JSON.parse(JSON.stringify(A.runner_lost_second).replaceAll("public.rpc.solanavibestation.com", "solana-mainnet.gateway.tatum.io"));

test("the refusals: the phone the first host that answered, the desktop the second", () => {
  assert.deepEqual(plantsOf(SOL.rpcs), { phone: "solana-rpc.publicnode.com", desktop: POCKET });
  assert.deepEqual(plantsOf([SOL.rpcs[0], SOL.rpcs[2]]), { phone: "solana-rpc.publicnode.com", desktop: "solana-mainnet.gateway.tatum.io" });
  assert.deepEqual(A.good.plants, plantsOf(SOL.rpcs));
  assert.ok(A.good.probe.hosts.every((x) => x.answered));
});

test("the probe sends the page's read with its Origin and names a host that refuses it as a no-answer", async () => {
  const asked = [];
  const read = async (url, method, params, opts) => {
    asked.push({ url, method, params, opts });
    if (url.includes("pocket")) return { noAnswer: `${POCKET} HTTP 400: not JSON ()`, status: 400, acao: "*" };
    return { result: { value: [{}, {}] }, status: 200, acao: "*" };
  };
  const p = await probe(SOL.rpcs, SOL.pin, { read });
  assert.deepEqual(asked.map((a) => a.method), ["getMultipleAccounts", "getMultipleAccounts", "getMultipleAccounts"]);
  assert.deepEqual(asked[0].params, [[SOL.pin.program, SOL.pin.programdata], { encoding: "base64", commitment: "finalized" }]);
  assert.equal(asked[0].opts.headers.origin, "https://ct-app.unrealized.trade");
  assert.deepEqual(p.hosts.map((x) => x.answered), [true, false, true]);
  assert.equal(p.hosts[1].why, `${POCKET} HTTP 400: not JSON ()`);
});

test("recorded good answer: the Solana row ok on the two hosts that answered, the refused one walked past: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.filter((l) => l.startsWith("BAD")).join("\n"));
  assert.equal(r.ok, true);
  const on = (w, hosts, refused) => r.lines.some((l) => [hosts, [...hosts].reverse()].some((h) => l === `ok  ${w} /verify solana: row ok, read on ${h.join(" and ")}, with ${refused} refusing`));
  assert.ok(on("phone", [POCKET, "solana-mainnet.gateway.tatum.io"], "solana-rpc.publicnode.com"), r.lines.join("\n"));
  assert.ok(on("desktop", ["solana-rpc.publicnode.com", "solana-mainnet.gateway.tatum.io"], POCKET), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^ok  desktop \/verify: the page asked solana\.api\.pocket\.network [1-9]\d* time\(s\), answered 400, want the planted 400$/.test(l)));
});

test("recorded bad answer: the live fixed pair, only the planted host refused: the row Unverified: FAIL", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  const b = bad(A.bad);
  assert.ok(b.some((l) => /^BAD desktop \/verify solana: row warn, read on /.test(l)), b.join("\n"));
  assert.ok(b.some((l) => /^BAD phone \/verify solana: row warn, read on /.test(l)), b.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("INCONCLUSIVE")));
});

test("recorded runner_lost_second answer: Pocket refused the phone's page too: INCONCLUSIVE naming it, never PASS", () => {
  const r = judge(LOST);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(r.ok, false);
  assert.equal(EXIT[r.verdict], 3);
  assert.ok(bad(LOST).some((l) => l.startsWith("BAD phone /verify solana: row warn")));
  assert.ok(r.lines.includes(`--  phone /verify: ${POCKET} HTTP 400: refused the page's read from this runner, not planted`), r.lines.join("\n"));
  // live-rerun names the silent host in its notice
  assert.deepEqual(noAnswerHosts(r.lines.join("\n")), [POCKET]);
});

test("planted: a row that warns with only its planted host down fails, whatever else the page did", () => {
  // the good run with the phone's row warning: one host down, FAIL
  const warn = clone(A.good);
  for (const r of warn.runs) if (r.width === "phone") r.pools.rows.solana.status = "warn";
  assert.equal(judge(warn).verdict, "FAIL");
  // the outage run with Pocket's 400 turned into a 200: the page itself gave up the third read (net::ERR_ABORTED is
  // its own abort, never a provider's word): FAIL
  const aborted = clone(LOST);
  for (const r of aborted.runs) for (const x of r.requests) if (r.width === "phone" && x.url.includes(POCKET)) x.status = 200;
  assert.equal(judge(aborted).verdict, "FAIL", judge(aborted).lines.join("\n"));
  // the outage run with a wrong answer elsewhere (the Base row): FAIL, the outage excuses only Solana's lines
  const other = clone(LOST);
  for (const r of other.runs) if (r.width === "phone") r.pools.rows.base.status = "warn";
  assert.equal(judge(other).verdict, "FAIL");
});

test("planted: a probe that found fewer than three answering is INCONCLUSIVE before any page, naming the silent hosts", () => {
  const two = { check: "verify-row-survives-one-provider", list: SOL.rpcs, plants: null, probe: { at: "t", hosts: [{ host: "solana-rpc.publicnode.com", answered: true }, { host: POCKET, answered: false, why: `${POCKET} HTTP 400: empty body` }, { host: "solana-mainnet.gateway.tatum.io", answered: true }] } };
  const r = judge(two);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.deepEqual(noAnswerHosts(r.lines.join("\n")), [POCKET]);
  // a planted host the probe did not find answering is refused
  const off = clone(A.good);
  off.probe.hosts[1] = { host: POCKET, answered: false, why: `${POCKET} HTTP 400: empty body` };
  off.probe.hosts.push({ host: "x.example.org", answered: true }, { host: "y.example.org", answered: true });
  assert.ok(bad(off).some((l) => l.startsWith("BAD each planted host answered the runner's probe")));
  // no probe recorded: FAIL
  const none = clone(A.good);
  delete none.probe;
  assert.equal(judge(none).verdict, "FAIL");
});

test("planted on the good answer: the row naming the refused host, no refusal made, or one host refused on both widths: FAIL", () => {
  const onRefused = clone(A.good);
  for (const r of onRefused.runs) if (r.width === "desktop") r.pools.rows.solana.rpcs = [POCKET, "solana-mainnet.gateway.tatum.io"];
  assert.ok(bad(onRefused).some((l) => l.startsWith(`BAD desktop /verify solana: row ok, read on ${POCKET}`)));
  const unasked = clone(A.good);
  for (const r of unasked.runs) r.requests = r.requests.filter((x) => !(x.method === "POST" && x.url.startsWith(`https://${unasked.plants[r.width]}`)));
  assert.ok(bad(unasked).some((l) => /the page asked solana-rpc\.publicnode\.com 0 time\(s\), want the planted 400/.test(l)));
  const same = clone(A.good);
  same.plants = { phone: "solana-rpc.publicnode.com", desktop: "solana-rpc.publicnode.com" };
  assert.ok(bad(same).some((l) => l.startsWith("BAD the run refused")));
});

test("(card solana-lists-drop-the-dead-provider) recorded before answer: the 13 Nov build reading Solana Vibe Station fails on today's list", () => {
  assert.ok(!SOL.rpcs.some((u) => u.includes("solanavibestation")) && SOL.rpcs.includes("https://solana-mainnet.gateway.tatum.io"));
  const r = judge(A.before);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(A.before).some((l) => /is a release RPC, a 4xx, not walked past/.test(l)), r.lines.join("\n"));
});
