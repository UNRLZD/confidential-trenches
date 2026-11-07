// A network whose release names no vault signs no deposit call (src/rules/deposit.ts, refused "vault"). Every network
// names its vault now (mainnet the v1 record's, card vault-mainnet-deploy), so a load hook gives this process a kit
// networks.ts whose mainnet vault is null, frozen as the real one is, before the rule loads.
//   node --test test/rules-deposit-no-vault.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const NETWORKS_URL = new URL("../../kit/src/near/networks.ts", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url !== NETWORKS_URL) return next(url, context);
    // the real module under another address (the hook passes it through), its mainnet with no vault, frozen
    const real = JSON.stringify(`${NETWORKS_URL}?real`);
    const source = `import { NEAR_NETWORKS as REAL } from ${real};
export * from ${real};
export const NEAR_NETWORKS = Object.freeze({ ...REAL, mainnet: Object.freeze({ ...REAL.mainnet, vault: null }) });
`;
    return { format: "module", source, shortCircuit: true };
  },
});
const { checkDepositCall, DepositRuleRefused } = await import("../src/rules/deposit.ts");
const { NEAR_NETWORKS } = await import("../../kit/src/near/networks.ts");
const { RELEASE_BIND_URL } = await import("../../wallet/src/deposit/delegate.ts");
if (NEAR_NETWORKS.mainnet.vault !== null) throw new Error("rules-deposit-no-vault.test.ts: networks.ts was loaded before the hook");

test("no deposit call is signed on a network whose release names no vault", () => {
  const signer = { id: "ab".repeat(32), publicKey: new Uint8Array(32).fill(0xab) };
  const ctx = { network: "mainnet" as const, signer, note: { precommitment: 1n, amount: 1n }, reads: [] as never, route: RELEASE_BIND_URL };
  assert.throws(() => checkDepositCall(new Uint8Array(0), ctx), (e: unknown) => e instanceof DepositRuleRefused && e.code === "not_allowed" && e.rule === "vault");
});
