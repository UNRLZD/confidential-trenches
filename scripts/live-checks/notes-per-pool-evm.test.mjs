// node --test --test-isolation=none scripts/live-checks/notes-per-pool-evm.test.mjs: card notes-per-pool-evm's live
// check, replayed. notes-per-pool-evm.answers.json holds a real run on both testnets (good) and the same answers with
// currentTreeSize one higher on both RPCs (bad). The wallet's own sync runs on the replay: good passes on every chain,
// bad fails on every chain, refused by the pool's own size.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, VIEWS, check, replayer, spoil } from "./notes-per-pool-evm.mjs";

const A = JSON.parse(readFileSync(new URL("./notes-per-pool-evm.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes on both chains, through the sync's every step", async () => {
  assert.deepEqual(Object.keys(A.good).sort(), Object.keys(CHAINS).sort());
  for (const name of Object.keys(CHAINS)) {
    const r = await check(name, replayer(A.good[name]), { wait: false });
    assert.equal(r.ok, true, `${name}: ${r.lines.join("\n")}`);
    assert.equal(r.lines.length, 6, name);
    assert.match(r.lines[0], new RegExp(`deploy tx ${CHAINS[name].deployTx} in block \\d+`));
    assert.match(r.lines[2], /finalized anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[3], /newest agreed anchor \d+ 0x[0-9a-f]{64} on both/);
    assert.match(r.lines[4], /currentTreeSize 0, .* currentLabelTreeSize 0 at the newest anchor/);
    assert.match(r.lines[5], /no leaf yet/);
  }
  // the run paged through a provider's real range cap (sepolia.base.org: 200 blocks)
  assert.ok(A.good["base-sepolia"].some((e) => e.method === "eth_getLogs" && /limited to a 200 range/.test(e.error ?? "")));
});

test("the recorded bad run (currentTreeSize one higher on both RPCs) fails on both chains, and is the good run but that", async () => {
  const size = Object.keys(VIEWS).find((k) => VIEWS[k] === "currentTreeSize()");
  for (const name of Object.keys(CHAINS)) {
    assert.deepEqual(A.bad[name], spoil(A.good[name]), name);
    const changed = A.bad[name].filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[name][i]));
    assert.ok(changed.length >= 2 && changed.every((e) => e.params[0].data === size), name);
    const r = await check(name, replayer(A.bad[name]), { wait: false });
    assert.equal(r.ok, false, name);
    assert.match(r.lines.at(-1), /the state tree from the logs \(0 leaves\) is not the pool's/);
  }
});

test("a replay with one RPC's answer missing is a failure, never a pass", async () => {
  const log = A.good["robinhood-testnet"];
  const i = log.findIndex((e) => e.method === "eth_call");
  const r = await check("robinhood-testnet", replayer(log.filter((_, j) => j !== i)), { wait: false });
  assert.equal(r.ok, false);
});
