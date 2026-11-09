// The operator map and its scan: two NEAR RPCs of one operator are one read. Planted cases first, then the real tree.
//   node --test scripts/ci/near-rpc-operators.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW, BUNDLES, NEAR_RPC_OPERATORS, SKIP, fileProblems, isNearRpc, lineProblems, networkOf, operatorOf, scanTree } from "./near-rpc-operators.mjs";
import { RPCS, operatorOf as gateOperatorOf } from "./money-gate.mjs";
import { RPC_OPERATORS } from "./rpc-operators.mjs";
import { WATCH_RPCS } from "../../apps/helper/src/token-status/status.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("near.org's hosts are FastNEAR's; dRPC's are dRPC's; scheme, case and a trailing slash do not matter", () => {
  for (const u of ["https://rpc.mainnet.near.org", "https://archival-rpc.mainnet.near.org", "http://rpc.mainnet.near.org/", "https://RPC.testnet.near.org", "https://archival-rpc.testnet.near.org"])
    assert.equal(operatorOf(u), "fastnear", u);
  assert.equal(operatorOf("https://near.drpc.org/"), "drpc");
  assert.equal(operatorOf("https://near-testnet.drpc.org"), "drpc");
  assert.equal(operatorOf("https://rpc.ankr.com/near"), null);
  assert.equal(operatorOf("not a url"), null);
  for (const [host, { operator, network }] of Object.entries(NEAR_RPC_OPERATORS)) {
    assert.ok(["fastnear", "drpc"].includes(operator), host);
    assert.ok(["mainnet", "testnet"].includes(network), host);
  }
});

test("a NEAR RPC is a URL whose host and path say near and rpc, or one the map holds; nothing else is read", () => {
  for (const u of ["https://near.drpc.org", "https://1rpc.io/near", "https://rpc.ankr.com/near", "https://free.rpc.fastnear.com", "https://near.lava.build", "https://near-rpc.publicnode.com"]) assert.ok(isNearRpc(u), u);
  for (const u of ["https://near.org/packages", "https://nearblocks.io/txns/abc", "https://base.drpc.org", "https://mainnet.base.org", "nope"]) assert.ok(!isNearRpc(u), u);
});

test("planted: the README's loop over FastNEAR and near.org is one operator: refused", () => {
  const p = lineProblems("x\nfor RPC in https://rpc.mainnet.fastnear.com https://rpc.mainnet.near.org; do\n", "README.md");
  assert.deepEqual(p, ["README.md:2: rpc.mainnet.fastnear.com, rpc.mainnet.near.org are one operator (fastnear): two reads there are one read"]);
});

test("planted: a two-URL list of FastNEAR's and near.org's archival hosts is refused, on either network", () => {
  assert.equal(lineProblems('const RPCS = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];', "a.mjs").length, 1);
  assert.equal(lineProblems("near: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],", "a.mjs").length, 1);
  assert.equal(lineProblems("[`https://near.drpc.org`, `https://near.drpc.org/`]", "a.mjs").length, 0, "one URL twice is one URL, not a list");
});

test("FastNEAR with dRPC is two operators: passes", () => {
  assert.deepEqual(lineProblems('["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]', "a.mjs"), []);
  assert.deepEqual(lineProblems("for RPC in https://rpc.mainnet.fastnear.com https://near.drpc.org; do", "README.md"), []);
  assert.deepEqual(lineProblems('["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org"]', "a.mjs"), []);
});

// Review round 1: each of these passed the line scan at 4c1eeb2.
test("planted: one operator's pair in every shape is refused: across lines, any case or scheme, bare, keyed, commented, with a port", () => {
  const cases = {
    multiline: 'const RPCS = [\n  "https://rpc.mainnet.fastnear.com",\n  "https://rpc.mainnet.near.org",\n];',
    multilineObject: "const R = {\n  a: 'https://archival-rpc.testnet.fastnear.com',\n  b: 'https://archival-rpc.testnet.near.org',\n};",
    statement: "const A =\n  pick('https://rpc.mainnet.fastnear.com') ||\n  pick('https://rpc.mainnet.near.org');",
    upperScheme: 'const A = ["HTTPS://rpc.mainnet.fastnear.com", "HTTPS://RPC.MAINNET.NEAR.ORG"];',
    bareHosts: 'const HOSTS = ["rpc.mainnet.fastnear.com", "rpc.mainnet.near.org"].map((h) => "https://" + h);',
    wss: 'const A = ["wss://rpc.mainnet.fastnear.com", "wss://rpc.mainnet.near.org"];',
    keyedOtherwise: 'const R = { fastnear: "https://rpc.mainnet.fastnear.com", backup: "https://rpc.mainnet.near.org" };',
    keyedByOperator: '    fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],',
    commentLabel: 'const pair = ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"]; // fastnear: two reads',
    port: 'const A = ["https://rpc.mainnet.fastnear.com:443", "https://rpc.mainnet.near.org:443"];',
    escaped: "new RegExp(`ok on https://archival-rpc\\\\.mainnet\\\\.fastnear\\\\.com, ok on https://archival-rpc\\\\.mainnet\\\\.near\\\\.org`)",
  };
  for (const [k, v] of Object.entries(cases)) assert.match(lineProblems(v, "x.mjs").join("\n"), /are one operator \(fastnear\)/, k);
});

test("planted: a NEAR RPC host built from a template, or on another port, is refused", () => {
  assert.equal(lineProblems("const urls = [`https://rpc.${net}.fastnear.com`, `https://rpc.${net}.near.org`];", "x.mjs").length, 2);
  assert.match(lineProblems("const u = `archival-rpc.${n}.near.org`;", "x.mjs").join(), /built from a template/);
  assert.match(lineProblems('const A = "https://rpc.mainnet.near.org:8443";', "x.mjs").join(), /rpc\.mainnet\.near\.org:8443 is a NEAR RPC host the operator map does not hold/);
  assert.deepEqual(lineProblems("const u = `https://${host}`;", "x.mjs"), [], "a host from a variable is the map's own loop, not a template host");
});

test("a big fixture of long hex runs is scanned in linear time, and a template host in it is still refused", () => {
  // TEMPLATE's leading run rescanned each hex run from every character: a 1.9 MB quote fixture took 35 s, the tree
  // 443 s, past the gitleaks job's 10 minutes (main a70ea92b's push CI, 9 Nov 04:36Z)
  const hex = `{"data": "0x${"ab12".repeat(50_000)}"}\n`; // one 200 KB run: the quadratic scan took over 5 s on it
  const started = performance.now();
  assert.deepEqual(lineProblems(hex, "fixture.json"), []);
  assert.match(lineProblems(`${hex}const u = \`archival-rpc.\${n}.near.org\`;\n`, "x.mjs").join(), /built from a template/, "a file that holds a template host is still read whole");
  assert.ok(performance.now() - started < 5_000, `two 200 KB hex runs took ${Math.round(performance.now() - started)} ms`);
});

test("the allow marker on a host's line passes one operator's alternatives; on another line, or another word, it does not", () => {
  assert.deepEqual(lineProblems(`    fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"], // ${ALLOW} (alternatives)`, "a.ts"), []);
  assert.equal(lineProblems(`// ${ALLOW}\nconst P = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];`, "a.ts").length, 1);
  assert.equal(lineProblems('const P = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]; // one operator', "a.ts").length, 1);
});

// Review round 2: each of these passed the scan at dc14699.
test("planted: the marker clears a unit only when every host line in it is marked; a marked line hides no pair next to it", () => {
  const M = `// ${ALLOW}`;
  const sibling = ["const cfg = {", `  fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"], ${M}`, '  readA: "https://archival-rpc.testnet.fastnear.com",', '  readB: "https://archival-rpc.testnet.near.org",', "};"].join("\n");
  assert.match(lineProblems(sibling, "x.ts").join("\n"), /are one operator \(fastnear\)/);
  const noSemicolons = [`export const N = { fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"] } ${M}`, 'const A = "https://archival-rpc.testnet.fastnear.com"', 'const B = "https://archival-rpc.testnet.near.org"'].join("\n");
  assert.match(lineProblems(noSemicolons, "x.ts").join("\n"), /are one operator \(fastnear\)/);
  const allMarked = ["const P = [", `  "https://test.rpc.fastnear.com", ${M}`, `  "https://rpc.testnet.near.org", ${M}`, "];"].join("\n");
  assert.deepEqual(lineProblems(allMarked, "x.ts"), []);
});

test("planted: a YAML list with one URL per item, and a command split with a trailing backslash, are units: refused", () => {
  const yaml = ["rpcs:", "  - https://rpc.mainnet.fastnear.com", "  - https://rpc.mainnet.near.org"].join("\n");
  assert.match(lineProblems(yaml, "x.yml").join("\n"), /are one operator \(fastnear\)/);
  const nested = ["rpcs:", "  - name: a", "    url: https://archival-rpc.testnet.fastnear.com", "", "  - name: b", "    url: https://archival-rpc.testnet.near.org", "other: 1"].join("\n");
  assert.match(lineProblems(nested, "x.yaml").join("\n"), /are one operator \(fastnear\)/);
  const sh = ["for RPC in \\", "  https://rpc.mainnet.fastnear.com \\", "  https://rpc.mainnet.near.org; do"].join("\n");
  for (const f of ["x.sh", "README.md"]) assert.match(lineProblems(sh, f).join("\n"), /are one operator \(fastnear\)/, f);
  // two operators, or two lists, pass
  assert.deepEqual(lineProblems(["rpcs:", "  - https://rpc.mainnet.fastnear.com", "  - https://near.drpc.org"].join("\n"), "x.yml"), []);
  assert.deepEqual(lineProblems(["a:", "  - https://rpc.mainnet.fastnear.com", "  - https://near.drpc.org", "b:", "  - https://rpc.mainnet.near.org", "  - https://near.drpc.org"].join("\n"), "x.yml"), []);
  assert.deepEqual(lineProblems(["curl https://rpc.mainnet.fastnear.com \\", "  -d '{}'", "curl https://rpc.mainnet.near.org"].join("\n"), "x.sh"), []);
});

test("a mainnet host and a testnet host of one operator are no pair; a unit with both operators passes", () => {
  assert.deepEqual(lineProblems('const D = ["https://near.drpc.org", "https://near-testnet.drpc.org"];', "a.mjs"), []);
  assert.deepEqual(lineProblems('const R = {\n  a: "https://rpc.mainnet.fastnear.com",\n  b: "https://rpc.mainnet.near.org",\n  c: "https://near.drpc.org",\n};', "a.mjs"), []);
  assert.deepEqual(lineProblems("near.org's pages (https://near.org/blog, https://docs.near.org) and intents.near are not RPCs", "a.md"), []);
});

test("every file the scan skips says why", () => {
  for (const [f, why] of Object.entries(SKIP)) assert.ok(typeof why === "string" && why.length > 10, f);
  for (const [f, why] of Object.entries(BUNDLES)) assert.ok(typeof why === "string" && why.length > 10, f);
});

test("planted: a listed bundle's pair, its marker minified away, passes; its unmapped host is refused; elsewhere both are refused", () => {
  const pair = "fastnear:[`https://test.rpc.fastnear.com`,`https://rpc.testnet.near.org`],drpc:`https://near-testnet.drpc.org`";
  const stray = "const a=[`https://rpc.ankr.com/near`]";
  const bundle = Object.keys(BUNDLES)[0];
  assert.deepEqual(fileProblems(pair, bundle), []);
  assert.equal(fileProblems(stray, bundle).length, 1);
  assert.match(fileProblems(pair, "packages/signpage/src/x.ts").join("\n"), /are one operator \(fastnear\)/);
  assert.match(fileProblems(pair, "packages/signpage/public/other.js").join("\n"), /are one operator \(fastnear\)/);
});

test("planted: a NEAR RPC the map does not hold is refused, alone or in a list", () => {
  assert.deepEqual(lineProblems('const A = "https://rpc.ankr.com/near";', "a.mjs"), ["a.mjs:1: https://rpc.ankr.com/near is a NEAR RPC the operator map does not hold (scripts/ci/near-rpc-operators.mjs)"]);
  assert.equal(lineProblems('["https://rpc.mainnet.fastnear.com", "https://1rpc.io/near"]', "a.mjs").length, 1);
});

test("the money gate's NEAR lists each name two operators of their own network, all in the map", () => {
  for (const [chain, network] of [["near", "mainnet"], ["near-testnet", "testnet"]]) {
    const ops = RPCS[chain].map(operatorOf);
    assert.ok(!ops.includes(null), `${chain}: ${RPCS[chain]}`);
    assert.equal(new Set(ops).size, 2, `${chain}: ${RPCS[chain]}`);
    for (const u of RPCS[chain]) assert.equal(networkOf(u), network, u);
  }
});

test("every host in the money gate's RPCS is in an operator map, and each chain lists two operators", () => {
  for (const [chain, urls] of Object.entries(RPCS)) {
    for (const u of urls) {
      const host = new URL(u).host;
      const mapped = chain.startsWith("near") ? Object.hasOwn(NEAR_RPC_OPERATORS, host) : Object.hasOwn(RPC_OPERATORS[chain] ?? {}, host);
      assert.ok(mapped, `${chain}: ${u}`);
      assert.notEqual(gateOperatorOf(chain, u), u, `${chain}: ${u} is its own operator`);
    }
    assert.ok(new Set(urls.map((u) => gateOperatorOf(chain, u))).size >= 2, chain);
  }
});

test("the helper's two token-status defaults are two operators, mainnet both", () => {
  const urls = WATCH_RPCS.map((r) => r.fallback);
  assert.equal(new Set(urls.map(operatorOf)).size, 2, urls.join(", "));
  for (const u of urls) assert.equal(networkOf(u), "mainnet", u);
});

test("the real tree: every NEAR RPC host is in the map and no unit pairs one operator", () => {
  assert.deepEqual(scanTree(ROOT), []);
});
