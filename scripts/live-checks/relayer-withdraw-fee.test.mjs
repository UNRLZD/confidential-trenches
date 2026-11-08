// node --test scripts/live-checks/relayer-withdraw-fee.test.mjs: the live check replays recorded runs
// (relayer-withdraw-fee.answers.json), each judged against the release's relayers as relay.ts writes them. good:
// HELPER_HOST on 8 Nov, quoting mainnet and testnet for the release's pairs, and the check's own device reads: PASS.
// bad_other_relayer: a helper (apps/helper on a test machine, 2 Nov) naming another relayer and fee recipient: FAIL.
// bad_rate: that run with the mainnet fee given as a rate ("0.0005", what a percentage relayer would answer): FAIL.
// Made from the good run: another relayer, a fee over the device's fee_max, a closed window, a missing field, another
// token quoted: each FAIL.
// The check's copy of the device's fee_max is held to the device's own figures (wallet src/withdraw/feemax.ts
// withdrawFeeMax, read 2026-11-02 at these inputs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deviceFeeMax, judge, OTHER, read, RELEASE_RELAYER, TOKENS } from "./relayer-withdraw-fee.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "relayer-withdraw-fee.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const withBody = (run, network, f) => ({ ...run, reads: run.reads.map((x) => (x.asked === TOKENS[network] ? { ...x, body: JSON.stringify(f(JSON.parse(x.body))) } : x)) });

test("the release's relayers are relay.ts's pairs: mainnet 4519129d and fees.unrlzd.near, testnet VT-T02's R and F", () => {
  const relay = readFileSync(path.join(HERE, "../../packages/wallet/src/withdraw/relay.ts"), "utf8");
  assert.deepEqual(RELEASE_RELAYER.mainnet, { relayer_account: "4519129d35447942d92ef046ffa52af0430fb06b95b59936d7173290a6972756", fee_recipient: "fees.unrlzd.near" });
  for (const n of ["mainnet", "testnet"]) for (const id of Object.values(RELEASE_RELAYER[n])) assert.ok(relay.includes(`"${id}"`), `${n}: ${id} is written in relay.ts`);
  assert.equal(RELEASE_RELAYER.testnet.relayer_account, "r-2b700409.bf-vt-20261102t071444.testnet"); // gitleaks:allow (a public account id)
  assert.ok(Object.isFrozen(RELEASE_RELAYER));
});

test("recorded good run: both networks quoted in the kit's shape, from the release's relayer, at or under the device's fee_max: PASS", () => {
  const r = judge(A.good, RELEASE_RELAYER);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const n of ["mainnet", "testnet"]) assert.ok(r.lines.some((l) => l.startsWith(`ok  [${n}] relay_fee `) && l.includes("<= the device's fee_max")), n);
});

test("recorded bad_other_relayer: a helper naming another relayer and fee recipient on both networks: FAIL", () => {
  const r = judge(A.bad_other_relayer, RELEASE_RELAYER);
  assert.equal(r.ok, false);
  assert.deepEqual(
    bad(r).map((l) => l.slice(0, 30)),
    ["BAD [mainnet] relayer_account ", "BAD [testnet] relayer_account "],
    bad(r).join("\n"),
  );
});

test("recorded bad run: the mainnet fee given as a rate (\"0.0005\"): FAIL", () => {
  const r = judge(A.bad_rate, RELEASE_RELAYER);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes('BAD [mainnet] relay_fee "0.0005": an absolute amount in base units, a u128 decimal'), bad(r).join("\n"));
});

test("made from the good run: another relayer, a fee over fee_max, a closed window, a missing field, another token quoted, no relayer given: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(withBody(g, "mainnet", (b) => ({ ...b, fee_recipient: "thief.near" })), RELEASE_RELAYER).ok, false);
  const max = deviceFeeMax(Object.fromEntries(Object.entries(g.device.testnet).filter(([k]) => k !== "height").map(([k, v]) => [k, BigInt(v)])));
  assert.equal(judge(withBody(g, "testnet", (b) => ({ ...b, relay_fee: (max + 1n).toString() })), RELEASE_RELAYER).ok, false);
  assert.equal(judge(withBody(g, "testnet", (b) => ({ ...b, relay_fee: max.toString() })), RELEASE_RELAYER).ok, true, "a fee at fee_max is the device's to take");
  assert.equal(judge(withBody(g, "mainnet", (b) => ({ ...b, valid_until_block: Number(g.device.mainnet.height) - 1 })), RELEASE_RELAYER).ok, false);
  assert.equal(judge(withBody(g, "mainnet", ({ g_w, ...b }) => b), RELEASE_RELAYER).ok, false);
  assert.equal(judge({ ...g, reads: g.reads.map((x) => (x.asked === OTHER ? { ...x, status: 200 } : x)) }, RELEASE_RELAYER).ok, false);
  assert.equal(judge(g, { mainnet: null, testnet: RELEASE_RELAYER.testnet }).ok, false);
  assert.ok(judge(g, { mainnet: null, testnet: RELEASE_RELAYER.testnet }).lines.includes("BAD [mainnet] the release's relayer: relay.ts names none on mainnet"));
  assert.equal(judge(withBody(g, "mainnet", (b) => ({ ...b, relayer_account: "9747fa11a4de38cecc3b9086239633a2164a81c8e7b03a39bd3f1522438717d6" })), RELEASE_RELAYER).ok, false, "the throwaway relayer");
  assert.equal(judge({ ...g, device: { ...g.device, testnet: { error: "finals more than 30 apart" } } }, RELEASE_RELAYER).ok, false);
});

test("the check's copy of the device's fee_max equals the device's figures", () => {
  const at = (gasPrice, poolToken, poolNear, registerDeposit) => deviceFeeMax({ gasPrice, poolToken, poolNear, registerDeposit });
  assert.equal(at(100_000_000n, 1_023_068_829_135n, 247_370_119_496_778_966_130_420_997_292n, 1_250_000_000_000_000_000_000n), 438_172n);
  assert.equal(at(10_000_000_000n, 250_000_000_000n, 5_000_000_000_000_000_000_000_000_000n, 0n), 344_972_500n);
  assert.equal(at(123_456_789n, 50_000_000_000_000n, 10n ** 30n, 1_250_000_000_000_000_000_000n), 6_102_439n);
});

test("read() asks the three tokens with Origin APP_HOST (replayed helper; device reads stubbed down)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/withdraw/fee") {
      asked.push(u.searchParams.get("token"));
      assert.equal(init.headers.origin, "https://ct-app.unrealized.trade");
      const r = A.good.reads.find((x) => x.asked === u.searchParams.get("token"));
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
    throw new Error("no RPC in this test");
  };
  const run = await read("https://ct-api.unrealized.trade", fetchFn);
  assert.deepEqual(asked, [TOKENS.mainnet, TOKENS.testnet, OTHER]);
  assert.ok(run.device.mainnet.error && run.device.testnet.error);
  assert.equal(judge(run, RELEASE_RELAYER).ok, false, "no device reads, no pass");
});
