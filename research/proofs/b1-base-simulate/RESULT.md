# B1: `eth_simulateV1` on the Base RPCs paper 06c names

Run by prep lane PR1 on 2026-10-22 from 19:01:03Z (from `date -u`), for merge note M190 (12). Input: 06c §1.3 row
"Base | Second provider" (`base.gateway.tenderly.co`, `base.drpc.org`: "`eth_simulateV1` support on them: UNKNOWN (§7
item 10)") and PF-16 (`eth_simulateV1` on `pending` at `mainnet.base.org`; "the second provider UNKNOWN"). One keyless call
per provider; the same body to all four Base RPCs 06c names.

**Verdict: `base.drpc.org` and `base-rpc.publicnode.com` support it, in 06c's shape (`pending`, `traceTransfers: true`,
a state override). `base.gateway.tenderly.co` does not serve it keyless (429 while its own counter shows 20 left; `eth_call`
answers), and Tenderly's docs say `traceTransfers` is not supported there even with a key.** So the second Base
simulation provider is `base.drpc.org` or `base-rpc.publicnode.com`, not Tenderly.

## Request (`sim.mjs`, no dependencies, `node sim.mjs`)

```json
{"jsonrpc":"2.0","id":1,"method":"eth_simulateV1","params":[{"blockStateCalls":[{"stateOverrides":{"0x5afe000000000000000000000000000000000b1b":{"balance":"0xde0b6b3a7640000"}},"calls":[{"from":"0x5afe000000000000000000000000000000000b1b","to":"0x4200000000000000000000000000000000000006","value":"0x1","data":"0xd0e30db0"}]}],"traceTransfers":true,"validation":false},"pending"]}
```

A synthetic sender funded by the override wraps 1 wei into Base WETH (`deposit()`). A full answer has the call at status
`0x1` with two logs: the synthetic ETH transfer that `traceTransfers` adds (address `0xeeee…eeee`, topic `Transfer`
`0xddf252ad…`) and WETH's `Deposit` (`0xe1fffcc4…`). Nothing is broadcast.

## Responses (`results/2026-10-22T19-01-03-246Z-pending.json`)

| Provider (06c) | HTTP | ms | Answer | Verdict |
|---|---|---|---|---|
| `mainnet.base.org` (PF-16 first) | 200 | 509 | status `0x1`, block `0x3280047`, both logs | SUPPORTED |
| `base.gateway.tenderly.co` (second) | 429 | 466 | `{"code":-32005,"message":"rate limit exceeded"}` | NOT SERVED keyless |
| `base.drpc.org` (second) | 200 | 517 | status `0x1`, block `0x3280043`, both logs | SUPPORTED |
| `base-rpc.publicnode.com` (§1.3, `proofs/evm-safe-lag`) | 200 | 524 | status `0x1`, block `0x3280047`, both logs | SUPPORTED |

Tenderly follow-ups, 19:01:11Z-19:01:30Z (curl, keyless): `eth_blockNumber` HTTP 200 (`0x328004a`; headers
`x-tdly-limit: 20`); the same `eth_simulateV1` body again HTTP 429 -32005 with `x-tdly-remaining: 20`; the same body on
`latest` HTTP 429 -32005; `eth_call` (WETH `totalSupply()`) HTTP 200. So the refusal is for this method keyless, not a
spent budget.

Tenderly's docs, read 2026-10-22 ~19:08Z, https://docs.tenderly.co/node-rpc/guides/eth-simulatev1.md: Base is not on
the unsupported-network list; "`traceTransfers` is not supported" (setting it true returns "traceTransfers flag is not
supported"); "`validation` is not supported"; the examples use `https://mainnet.gateway.tenderly.co/$TENDERLY_NODE_ACCESS_KEY`.
06c's call needs `traceTransfers: true` (§4.10, PF-16), so a Tenderly key would not help.

## Limits of this read

One call per provider at one moment. 06c §1.3 already records `base.drpc.org` free refusing batches over 3 and
answering "Public endpoint rate limit" (x1x2 §9 item 6), so its rate under load is not shown here. publicnode had one
long `safe` lag outlier in the 24 h watch (`proofs/evm-safe-lag`), which does not bear on simulation.
