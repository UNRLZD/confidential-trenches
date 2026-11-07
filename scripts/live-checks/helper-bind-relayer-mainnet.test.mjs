// node --test scripts/live-checks/helper-bind-relayer-mainnet.test.mjs: the live check replays recorded runs
// (helper-bind-relayer-mainnet.answers.json). good: apps/helper at this card's branch (e2e35323) run with node
// src/server.ts on the deploy/.env apps/helper/deploy/bind-relayer-key.sh wrote on a temp server (its stub docker
// running this machine's node; a fresh unfunded key), mainnet-v1.json planted as mainnet-test.json's vault, the vault
// this branch's image carries (MAINNET_VAULT) while no mainnet-v1.json exists: PASS. bad_deployed: the deployed helper
// (main 46b16ca4, 7 Nov 14:12Z), no bind field and no mainnet carry: FAIL. Made from the good run: another vault, no
// mainnet carry, a gas account that is the vault, a 503, no commit, another origin, a body over 1 KB: each FAIL.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, loadRecord } from "./helper-bind-relayer-mainnet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-bind-relayer-mainnet.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withBind = (run, f) => {
  const body = JSON.parse(run.body);
  body.bind = f(structuredClone(body.bind));
  return { ...run, body: JSON.stringify(body) };
};

test("recorded good run: health lists the mainnet carry, the record's vault and an implicit gas account: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.some((l) => /^ok {2}the mainnet gas account: [0-9a-f]{64} \(implicit/.test(l)), g.lines.join("\n"));
});

test("recorded bad run: the deployed helper before this card lists no bind carry: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), [
    "BAD health lists the bind carries: no bind field (a helper before this card)",
    "BAD mainnet deposits carried: no (BIND_*_MAINNET not set: run apps/helper/deploy/bind-relayer-key.sh, then redeploy)",
  ]);
});

test("made from the good run: each break of the carry or the answer FAILs", () => {
  const g = A.good;
  const vault = g.record.account_id;
  const fails = {
    "another vault": withBind(g, (b) => ({ mainnet: { ...b.mainnet, vault: `x${vault}` } })),
    "testnet only": withBind(g, (b) => ({ testnet: b.mainnet })),
    "none carried": withBind(g, () => ({})),
    "the gas account is the vault": withBind(g, (b) => ({ mainnet: { ...b.mainnet, account: vault } })),
    "the gas account is intents.near": withBind(g, (b) => ({ mainnet: { ...b.mainnet, account: "intents.near" } })),
    "the gas account is no account id": withBind(g, (b) => ({ mainnet: { ...b.mainnet, account: "Not An Account" } })),
    "bind is a list": withBind(g, (b) => [b.mainnet]),
    "a 503": { ...g, status: 503 },
    "no commit": { ...g, headers: { ...g.headers, "x-helper-commit": null } },
    "another origin": { ...g, headers: { ...g.headers, "access-control-allow-origin": "https://example.com" } },
    "a body over 1 KB": withBind(g, (b) => ({ ...b, pad: "x".repeat(1024) })),
    "not JSON": { ...g, body: "<html>" },
  };
  for (const [name, run] of Object.entries(fails)) assert.equal(judge(run).ok, false, name);
  // the good run judged against another record (a deploy whose vault is not the one the helper carries)
  assert.equal(judge(g, { account_id: "vault.confidential.unrlzd.near" }).ok, false);
});

test("the record: mainnet-v1.json only, never mainnet-test.json; absent, it stops with the reason", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bind-lc-"));
  assert.throws(() => loadRecord(path.join(dir, "mainnet-v1.json")), /the mainnet vault is not deployed/);
  const f = path.join(dir, "mainnet-v1.json");
  writeFileSync(f, JSON.stringify({ network: "testnet", account_id: "vault.x.testnet" }));
  assert.throws(() => loadRecord(f), /names no mainnet vault/);
  writeFileSync(f, JSON.stringify({ network: "mainnet", account_id: "vault.confidential.unrlzd.near", scope: "1" }));
  assert.deepEqual(loadRecord(f), { account_id: "vault.confidential.unrlzd.near" });
});
