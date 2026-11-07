// node --test src/env-check.test.ts: the pool senders' settings check that deploy/redeploy.sh runs before a swap refuses
// every network set only in part (the deploy of 2026-11-04 had POOL_EVM_SENDER_KEY_BASE_SEPOLIA alone, and both
// redeploys left a new helper that never got ready), takes a whole set, and names variables, never values.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { evmPoolVenues } from "@blindfill/kit";
import { checkPoolEnv } from "./env-check.ts";
import { evmPoolSendersFromEnv, POOL_EVM_ENV, POOL_EVM_SELL_ENV } from "./pool/evm.ts";
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

test("an EVM network with only some of its names set is refused, naming one of its variables and no value; the address and key are taken with the RPCs, or with the RPCs unset where the kit lists the network's fee pair (card evm-quote-warm-round fold 8), and refused naming the RPCs where it lists none; the fee (unset or the kit's floor) and the fee recipient optional", () => {
  const kit = evmPoolVenues();
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    const v = kit[network as keyof typeof kit];
    // the same network with no fee pair in the kit: only its RPCs, set, read the past blocks
    const { feeProviders: _, ...bare } = v!;
    for (const [venues, paired] of [[kit, v?.feeProviders !== undefined], [{ ...kit, [network]: bare }, false]] as const) {
      for (const set of subsets(names.length)) {
        const env = Object.fromEntries(set.map((i) => [names[i]!, EVM[i]!]));
        const keyed = [0, 1].every((i) => set.includes(i));
        const whole = keyed && (set.includes(4) || paired);
        const why = (() => {
          try {
            evmPoolSendersFromEnv(env, venues);
            return null;
          } catch (e) {
            return (e as Error).message;
          }
        })();
        if (whole) assert.equal(why, null, `${network} ${set.join(",")}${paired ? " (the kit's fee pair)" : ""}`);
        else {
          assert.ok(why !== null, `${network}: ${set.map((i) => names[i]).join(", ")} alone was taken${paired ? "" : " with no fee pair in the kit"}`);
          // the address and key set, the RPCs not and no fee pair: the refusal names the RPCs
          if (keyed) assert.ok(why.includes(names[4]), why);
          else assert.ok(names.some((n) => why.includes(n)), why);
          for (const x of EVM) assert.ok(!why.includes(x), `a value in: ${why}`);
        }
      }
    }
    // every network the senders run on has the kit's fee pair today (packages/kit/src/trade/evm/buy-unpinned.ts), so the
    // deploy's own check, which reads the kit's list, takes the address and key alone
    assert.ok(v?.feeProviders !== undefined, `${network}: no fee pair in the kit`);
    assert.equal(refusal({ [names[0]]: EVM[0]!, [names[1]]: EVM[1]! }), null, `${network}: the address and key alone`);
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

// card robinhood-mainnet-rpcs fold B: a POOL_EVM_RPCS_<NETWORK> the host sets passes the same two-operator check as the
// kit's pool list (an operator: the host's last two labels, an IP its address): two URLs of one operator are one
// provider's word, and the start refuses them with the reason, naming the variable and the operator, never a URL's
// path or query (a key may sit there).
test("fold B: POOL_EVM_RPCS_* of two URLs of one operator is refused at the start, naming the variable and the operator; two operators, and the kit's fee pairs, are taken", () => {
  const env = (rpcs: string) => ({ POOL_EVM_ADDRESS_ROBINHOOD: EVM[0]!, POOL_EVM_SENDER_KEY_ROBINHOOD: EVM[1]!, POOL_EVM_RPCS_ROBINHOOD: rpcs });
  for (const rpcs of ["https://rpc.mainnet.chain.robinhood.com,https://rpc.testnet.chain.robinhood.com/v2/s3cr3tKEY", "https://a.robinhood.com,https://b.robinhood.com", "http://127.0.0.1:1,http://127.0.0.1:2"]) {
    const why = refusal(env(rpcs));
    assert.ok(why !== null, `${rpcs}: taken`);
    assert.match(why, /^POOL_EVM_RPCS_ROBINHOOD must be two RPC URLs of two operators: both are (robinhood\.com|127\.0\.0\.1)$/, why);
    assert.ok(!why.includes("s3cr3tKEY"), why);
  }
  assert.equal(refusal(env("https://rpc.mainnet.chain.robinhood.com,https://robinhood.api.pocket.network")), null);
  // unset: the kit's fee pair, of two operators on every network
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) assert.equal(refusal({ [names[0]]: EVM[0]!, [names[1]]: EVM[1]! }), null, network);
});

// review L-2 and L-3 (op-edges): the start's operator is the kit's one rule (evmRpcOperator), so no spelling of one
// operator passes as two, no text that is not a URL passes at all, and one URL written twice is one URL
test("L-2/L-3: POOL_EVM_RPCS_* of one operator however written, a CNAME of the other, or Pocket's words twice is refused; a non-URL is refused naming no key; a trailing slash is the same URL", () => {
  const env = (rpcs: string) => ({ POOL_EVM_ADDRESS_ROBINHOOD: EVM[0]!, POOL_EVM_SENDER_KEY_ROBINHOOD: EVM[1]!, POOL_EVM_RPCS_ROBINHOOD: rpcs });
  const one: [string, string][] = [
    ["https://rpc.mainnet.chain.robinhood.com.,https://robinhood.com", "robinhood.com"],
    ["https://a.robinhood.com.,https://b.robinhood.com", "robinhood.com"],
    ["https://RPC.Mainnet.Chain.Robinhood.COM,https://x.robinhood.com", "robinhood.com"],
    ["https://user:s3cr3t@a.robinhood.com/v2/KEY?k=1,https://b.robinhood.com", "robinhood.com"],
    ["https://rpc.mainnet.chain.robinhood.com,https://customer-origin.offchainlabs.com", "robinhood.com"],
    ["https://robinhood.api.pocket.network,https://rpc.degenprotocol.io", "pocket.network"],
    ["https://rpc.foo.co.uk,https://rpc.bar.co.uk", "co.uk"],
    ["http://127.0.0.1:1,http://127.1:2", "127.0.0.1"],
    ["http://2130706433:1,http://127.0.0.1:2", "127.0.0.1"],
    ["http://[::ffff:127.0.0.1]:1,http://127.0.0.1:2", "127.0.0.1"],
    ["http://[::1]:1,http://[0:0:0:0:0:0:0:1]:2", "[::1]"],
    ["http://localhost:1,http://localhost:2", "localhost"],
  ];
  for (const [rpcs, op] of one) {
    const why = refusal(env(rpcs));
    assert.equal(why, `POOL_EVM_RPCS_ROBINHOOD must be two RPC URLs of two operators: both are ${op}`, rpcs);
  }
  for (const rpcs of ["not a url/KEY,also not/KEY2", "robinhood.com,https://x.robinhood.com/KEY", "ws://a.example/s3cr3t,https://b.example"]) {
    const why = refusal(env(rpcs));
    assert.equal(why, "POOL_EVM_RPCS_ROBINHOOD must be two http or https URLs", rpcs);
  }
  assert.equal(refusal(env("https://robinhood.drpc.org/,https://robinhood.drpc.org")), "POOL_EVM_RPCS_ROBINHOOD must be two different RPC URLs");
  assert.equal(refusal(env("https://robinhood.drpc.org/,https://rpc.mainnet.chain.robinhood.com/")), null);
});
