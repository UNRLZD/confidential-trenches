# EVM `safe` and `finalized` lag (Base, Robinhood)

Run by CO on 2026-10-21 from 05:16:54Z (from `date -u`) for 15 samples, 20 s apart (about 5 min). The reads are keyless: `eth_getBlockByNumber` for
`latest`, `safe` and `finalized` on two public providers per chain. The lag is the block timestamp of `latest` minus that of
`safe` (or `finalized`). The raw rows are in `results/2026-10-21T05-17Z.txt`. Reproduce: `node lag.mjs 15 20000`.

| Chain | Provider | `safe` lag, s: min / median / max | `finalized` lag, s: min / median / max |
|---|---|---|---|
| Base | mainnet.base.org | 20 / 42 / 68 | 870 / 1,022 / 1,222 |
| Base | base-rpc.publicnode.com | 64 / 98 / 126 | 958 / 1,246 / 1,442 |
| Robinhood | rpc.mainnet.chain.robinhood.com | 493 / 646 / 821 | 843 / 996 / 1,260 |
| Robinhood | robinhood-rpc.publicnode.com | 450 / 603 / 778 | 800 / 953 / 1,217 |

A tx is at `safe` on two providers once the slower provider's `safe` head passes its block. In this sample that is
about 100 s on Base (at most about 2 min) and about 11 min on Robinhood (at most about 14 min). These numbers come
from one 5-minute sample; they are not a long-run distribution. Robinhood's earlier figure, ≈ 576 s (CHN §2.1), sits
inside this range.

## 24 h watch (2026-10-21 14:28Z to 2026-10-22 15:34Z)

`node lag.mjs 1440 60000`, one read per provider per minute, keyless public RPCs; `results/2026-10-21T14-28Z-24h.txt`
(n = 1,438-1,440 per provider, 0 error rows). Summary lines as the script printed them:

| Chain | Provider | `safe` lag, s: min / median / max | `finalized` lag, s: min / median / max |
|---|---|---|---|
| Base | mainnet.base.org | 8 / 34 / 74 | 816 / 1,046 / 2,348 |
| Base | base-rpc.publicnode.com | 54 / 86 / 2,002 | 778 / 1,172 / 6,580 |
| Robinhood | rpc.mainnet.chain.robinhood.com | 419 / 631 / 862 | 800 / 1,014 / 1,233 |
| Robinhood | robinhood-rpc.publicnode.com | 398 / 610 / 829 | 782 / 993 / 1,210 |

Robinhood's longest two-provider `safe` lag (the slower provider at each minute; CO, 15:45Z) is **862 s**, so X24 by
its rule (04 X24: that lag + 43 s + 1 min, rounded up to the minute) is 965 s → **17 min** (was 16 min from the
5-minute sample's 821 s). Base's publicnode had one outlier of 2,002 s `safe` and 6,580 s `finalized`; Base's other
provider stayed at ≤ 74 s `safe`.
