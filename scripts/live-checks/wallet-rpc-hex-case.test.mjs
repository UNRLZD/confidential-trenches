// node --test scripts/live-checks/wallet-rpc-hex-case.test.mjs: card wallet-rpc-hex-case's live check, replayed.
// wallet-rpc-hex-case.answers.json holds a real run on Robinhood testnet (good: robinhood-testnet.drpc.org answering
// eth_chainId "0xB626", rpc.testnet.chain.robinhood.com "0xb626") and the same answers with drpc's chain id one higher,
// "0xB627" (bad). The wallet's own check runs on the replay: good passes, bad fails, refused as another chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RPCS, check, replayer, spoil } from "./wallet-rpc-hex-case.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-rpc-hex-case.answers.json", import.meta.url), "utf8"));
const chainIdOf = (log, url) => log.filter((e) => e.url === url && e.method === "eth_chainId").map((e) => e.result);

test("the recorded good run passes: drpc's upper-case \"0xB626\" and the lower-case \"0xb626\" are one chain to the wallet", async () => {
  assert.deepEqual([...new Set(chainIdOf(A.good, RPCS[0]))], ["0xB626"]);
  assert.deepEqual([...new Set(chainIdOf(A.good, RPCS[1]))], ["0xb626"]);
  const r = await check(replayer(A.good), { wait: false });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.lines.slice(0, 2), [
    "robinhood-testnet.drpc.org: eth_chainId \"0xB626\" (upper case), read by the wallet as 46630",
    "rpc.testnet.chain.robinhood.com: eth_chainId \"0xb626\", read by the wallet as 46630",
  ]);
  assert.match(r.lines[2], /^the two RPCs agree: chain 46630 on both, the finalized anchor \d+ 0x[0-9a-f]{64} held on both$/);
});

test("the recorded bad run (drpc's chain id \"0xB627\") fails, refused as another chain, and is the good run but that", async () => {
  assert.deepEqual(A.bad, spoil(A.good));
  const changed = A.bad.filter((e, i) => JSON.stringify(e) !== JSON.stringify(A.good[i]));
  assert.ok(changed.length >= 1 && changed.every((e) => e.url === RPCS[0] && e.method === "eth_chainId" && e.result === "0xB627"));
  const r = await check(replayer(A.bad), { wait: false });
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /rpcs: chain 46631 and 46630, not 46630/);
});

test("a replay with one RPC's chain id missing is a failure, never a pass", async () => {
  const r = await check(replayer(A.good.filter((e) => !(e.url === RPCS[1] && e.method === "eth_chainId"))), { wait: false });
  assert.equal(r.ok, false);
});
