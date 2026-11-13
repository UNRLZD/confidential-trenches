// Every edge of the EVM pool deposit (test/pool-deposit-evm.test.ts) on SIGN_HOST's own Base mainnet (its L1 fee read and
// bound, as on Base Sepolia), card evm-deposit-on-mainnet: the mainnet page (`testnet: false`) with the network's own pin, chain id
// and resend wait. A lost send sent again at its own nonce, a dead send rebuilt, a deposit under the ladder, a refusal, a
// reload mid-way, two asks at once, a fee over the cap: each as that file holds it, here on this network.
//   node --test test/pool-deposit-evm-base-mainnet.test.ts      (from packages/signpage)
(globalThis as { __ctEvmDepositNet?: string }).__ctEvmDepositNet = "base";
await import("./pool-deposit-evm.test.ts");
