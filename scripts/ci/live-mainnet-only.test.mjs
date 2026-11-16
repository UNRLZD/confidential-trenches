// node --test scripts/ci/live-mainnet-only.test.mjs: the gate that refuses a test network in a listed live check (card
// live-checks-read-mainnet-only). Planted: each way a check reached a test network, in a check with an After line,
// fails; the same text with no After line (Runs: once), or the name in a comment, passes. And the tree's own listed
// checks read the mainnets only.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codeOf, problems, problemsOf, RULES } from "./live-mainnet-only.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const listed = (code, after = "// After: helper") => `#!/usr/bin/env node\n// A check.\n${after}\nimport "../net-window.mjs";\n${code}\n`;
const once = (code) => `#!/usr/bin/env node\n// A check.\n// Runs: once, a module the listed checks share, never run\n${code}\n`;

/** One planted read of a test network for each rule, in the rule's order. */
export const PLANTS = Object.freeze([
  ["the kit's whole EVM list", `import { evmPoolVenues } from "../../packages/kit/src/index.ts";\nfor (const [c, v] of Object.entries(evmPoolVenues())) read(v);`],
  ["the kit's test half", `const v = evmTestnetVenues();`],
  ["the Solana devnet pin", `import { devnetPin } from "./pool-sol-deploy.mjs";\nconst p = devnetPin();`],
  ["the helper's devnet route", "await fetch(`${HELPER}/v1/rpc/solana-devnet`);"],
  ["a test network's provider", `const RPC = "https://sepolia.base.org";`],
  ["a test network's record", `const r = readFileSync("contracts/pool-solana/deployments/devnet.json");`],
  ["a test network's module", `import { check } from "./pool-evm-testnet-run.mjs";`],
  ["a test network as a chain", `for (const n of ["mainnet", "testnet"]) await read(n);`],
  ["a NEAR testnet account", `const near = read("bf-usdc-20261101t022248.testnet");`],
]);

test("each rule has its planted read, and each planted read fails a listed check on that rule", () => {
  assert.equal(PLANTS.length, RULES.length);
  PLANTS.forEach(([name, code], i) => {
    const p = problemsOf("planted", listed(code));
    assert.ok(p.length >= 1, `${name}: no problem`);
    assert.ok(p.some((l) => l.includes(RULES[i][1])), `${name}: ${p.join("\n")}`);
  });
});

test("planted: a test network in an After line's arguments fails, on every host", () => {
  for (const host of ["app", "sign", "helper"])
    for (const args of ["--network testnet", "--pool devnet", "--chain base-sepolia"]) {
      const p = problemsOf("planted", listed("const x = 1;", `// After: ${host} ${args}`));
      assert.equal(p.length, 1, `${host} ${args}: ${p.join("\n")}`);
      assert.match(p[0], /runs on a test network/);
    }
});

test("the same reads in a check no deploy runs (Runs: once), or only in comments, pass", () => {
  for (const [name, code] of PLANTS) assert.deepEqual(problemsOf("once", once(code)), [], name);
  const commented = listed(`// evmPoolVenues() named https://sepolia.base.org and "testnet"\n/* devnetPin() and "base-sepolia" */\nconst a = mainnetVenues();`);
  assert.deepEqual(problemsOf("commented", commented), []);
});

test("a mainnet read passes: mainnetVenues(), mainnet RPCs, the mainnet route, a key that says testnet in words", () => {
  const ok = listed(`import { mainnetVenues } from "./mainnet-venues.mjs";\nconst a = "https://mainnet.base.org";\nawait fetch(\`\${HELPER}/v1/rpc/solana\`);\nconst KEY = "helper-ready-never-waits-on-a-testnet-pool";\nconst x = TESTNET_ONLY.filter((s) => js.includes(s));`);
  assert.deepEqual(problemsOf("ok", ok), []);
});

test("codeOf keeps strings whole, blanks comments, and keeps each line", () => {
  const src = `const u = "https://a.b//c"; // gone\n/* gone\n too */ const k = 1;`;
  const c = codeOf(src);
  assert.equal(c.split("\n").length, src.split("\n").length);
  assert.ok(c.includes('"https://a.b//c"') && !c.includes("gone") && c.includes("const k = 1;"));
});

test("the tree: no listed check, on any host, reads a test network", () => {
  assert.deepEqual(problems(ROOT), []);
});
