// node --test scripts/live-checks/helper-bind-relayer-mainnet.test.mjs: the live check replays recorded runs
// (helper-bind-relayer-mainnet.answers.json). good: apps/helper at this card's branch (c04a490b) run with node
// src/server.ts on the deploy/.env apps/helper/deploy/bind-relayer-key.sh wrote on a temp server (its stub docker
// running this machine's node; a fresh unfunded key), mainnet-v1.json planted as the vault this branch's image carries
// (MAINNET_VAULT, mainnet-test.json's while no mainnet-v1.json exists), read with --commit c04a490b: PASS.
// bad_deployed: the deployed helper (main af75100a, release 93, 7 Nov 15:27Z) read with --commit af75100a, no bind
// field and no mainnet carry: FAIL. Made from the good run: another commit or none asked, a pin that is not the record's,
// no mainnet carry, the gas account the vault or not an account (the shape before review FIX 1 among them), a 503,
// another origin, a body over 1 KB: each FAIL.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, loadPin, loadRecord } from "./helper-bind-relayer-mainnet.mjs";
import { MAINNET_VAULT } from "../../apps/helper/src/withdraw/send.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-bind-relayer-mainnet.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withBind = (run, f) => {
  const body = JSON.parse(run.body);
  body.bind = f(structuredClone(body.bind));
  return { ...run, body: JSON.stringify(body) };
};

test("recorded good run: health lists the mainnet carry's implicit gas account at the commit asked, whose pin is the record's vault: PASS", () => {
  const g = judge(A.good);
  assert.equal(g.ok, true, g.lines.join("\n"));
  assert.ok(g.lines.some((l) => /^ok {2}the mainnet gas account: [0-9a-f]{64} \(implicit/.test(l)), g.lines.join("\n"));
  assert.ok(Buffer.byteLength(A.good.body) <= 1024);
});

test("recorded bad run: the deployed helper before this card lists no bind carry: FAIL", () => {
  const d = judge(A.bad_deployed);
  assert.equal(d.ok, false);
  assert.deepEqual(bad(d), [
    "BAD health lists the bind carries: no bind field (a helper before this card)",
    "BAD mainnet deposits carried: no (BIND_*_MAINNET not set: run apps/helper/deploy/bind-relayer-key.sh, then redeploy)",
  ]);
});

test("made from the good run: each break of the carry, the commit, the pin or the answer FAILs", () => {
  const g = A.good;
  const vault = g.record.account_id;
  const fails = {
    "testnet only": withBind(g, (b) => ({ testnet: b.mainnet })),
    "none carried": withBind(g, () => ({})),
    "the gas account is the vault": withBind(g, () => ({ mainnet: vault })),
    "the gas account is intents.near": withBind(g, () => ({ mainnet: "intents.near" })),
    "the gas account is no account id": withBind(g, () => ({ mainnet: "Not An Account" })),
    "the shape before review FIX 1 (an object with the vault)": withBind(g, (b) => ({ mainnet: { account: b.mainnet, vault } })),
    "bind is a list": withBind(g, (b) => [b.mainnet]),
    "a 503": { ...g, status: 503 },
    "no commit header": { ...g, headers: { ...g.headers, "x-helper-commit": null } },
    "another commit deployed than the one asked": { ...g, commit: "0".repeat(40) },
    "no commit asked": { ...g, commit: "" },
    "the commit's pin is not the record's vault": { ...g, pin: `x${vault}` },
    "no pin read": { ...g, pin: null },
    "another origin": { ...g, headers: { ...g.headers, "access-control-allow-origin": "https://example.com" } },
    "a body over 1 KB": withBind(g, (b) => ({ ...b, pad: "x".repeat(1024) })),
    "not JSON": { ...g, body: "<html>" },
  };
  for (const [name, run] of Object.entries(fails)) assert.equal(judge(run).ok, false, name);
  // the good run judged against another record (a deploy whose vault is not the one the commit pins)
  assert.equal(judge(g, { account_id: "vault.confidential.unrlzd.near" }).ok, false);
});

test("the pin is read from this checkout's apps/helper/src/withdraw/send.ts, as the helper's start holds it", () => {
  assert.equal(loadPin(), MAINNET_VAULT);
  const dir = mkdtempSync(path.join(tmpdir(), "bind-pin-"));
  const f = path.join(dir, "send.ts");
  writeFileSync(f, 'export const MAINNET_VAULT = "vault.confidential.unrlzd.near";\n');
  assert.equal(loadPin(f), "vault.confidential.unrlzd.near");
  for (const t of ["", '// export const MAINNET_VAULT = "a.near";\n', 'export const MAINNET_VAULT = process.env.X;\n']) {
    writeFileSync(f, t);
    assert.equal(loadPin(f), null, JSON.stringify(t));
  }
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
