// node --test src/env-check.test.ts: the pool senders' settings check that deploy/redeploy.sh runs before a swap refuses
// every network set only in part (the deploy of 2026-11-04 had POOL_EVM_SENDER_KEY_BASE_SEPOLIA alone, and both
// redeploys left a new helper that never got ready), takes a whole set, and names variables, never values.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { checkPoolEnv } from "./env-check.ts";
import { POOL_EVM_ENV, POOL_EVM_SELL_ENV } from "./pool/evm.ts";
import { POOL_SOLANA_ENV } from "./pool/solana.ts";

// test values only: no key here holds or moves anything
const EVM = ["0x" + "ab".repeat(20), "0x" + "11".repeat(32), "10000000000000", "0x" + "cd".repeat(20), "https://a.example,https://b.example"];
const SOL = ["11111111111111111111111111111111", "not-a-key-test-value", "5000", "https://a.example,https://b.example"];
const subsets = (n: number) => Array.from({ length: (1 << n) - 1 }, (_, m) => [...Array(n).keys()].filter((i) => (m + 1) & (1 << i)));
const refusal = (env: Record<string, string>) => {
  try {
    checkPoolEnv(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

test("an EVM network with only some of its names set is refused, naming one of its variables and no value; the address, key and RPCs together are taken, the fee (unset or the kit's floor) and the fee recipient optional", () => {
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    for (const set of subsets(names.length)) {
      const env = Object.fromEntries(set.map((i) => [names[i]!, EVM[i]!]));
      const whole = [0, 1, 4].every((i) => set.includes(i));
      const why = refusal(env);
      if (whole) assert.equal(why, null, `${network} ${set.join(",")}`);
      else {
        assert.ok(why !== null, `${network}: ${set.map((i) => names[i]).join(", ")} alone was taken`);
        assert.ok(names.some((n) => why.includes(n)), why);
        for (const v of EVM) assert.ok(!why.includes(v), `a value in: ${why}`);
      }
    }
    assert.ok(refusal({ [POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV]]: "0x" + "22".repeat(32) })?.includes(POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV]), `${network}: a sell key alone`);
  }
});

// (the Solana reader's refusal of a missing fee payer key, "fee payer key: not 64 bytes", names no variable; it is refused all the same)
test("a Solana cluster with only some of its names set is refused, with no value in the refusal", () => {
  for (const [cluster, names] of Object.entries(POOL_SOLANA_ENV)) {
    for (const set of subsets(names.length).filter((s) => s.length < names.length)) {
      const why = refusal(Object.fromEntries(set.map((i) => [names[i]!, SOL[i]!])));
      assert.ok(why !== null, `${cluster}: ${set.map((i) => names[i]).join(", ")} alone was taken`);
      for (const v of SOL) assert.ok(!why.includes(v), `a value in: ${why}`);
    }
  }
});

test("node src/env-check.ts exits 2 on the deploy's half set (a sender key alone), naming its network's variable and never the key; 0 on a whole set", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(import.meta.dirname, "env-check.ts")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  const names = POOL_EVM_ENV["base-sepolia"];
  const half = run({ [names[1]]: EVM[1]! });
  assert.equal(half.status, 2, half.stdout + half.stderr);
  assert.match(half.stderr, /POOL_EVM_[A-Z_]+_BASE_SEPOLIA/);
  assert.ok(!(half.stdout + half.stderr).includes(EVM[1]!.slice(2)), "the key was printed");
  const whole = run(Object.fromEntries(names.map((n, i) => [n, EVM[i]!])));
  assert.equal(whole.status, 0, whole.stdout + whole.stderr);
});
