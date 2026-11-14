# FD-S-15: treasury headroom on its shard (48 h read)

Status 2026-10-20 16:27Z: **done, read-only.** One run of `headroom.mjs`, 16:03:27Z to 16:27:17Z, record
`results/headroom-2026-10-20T16-03-27-724Z.json` (the log `results/run.log` stays local; `*.log` is ignored). Keyless sources only; 42 HTTP 429s, each
backed off.

**Pass line:** a measured headroom figure and the hour of peak use, compared with the scale review's estimate of
about 19 settlements a second at 5k.

## 1. Answer

- **Peak hour: 2026-10-20 14:00-15:00Z**, 1,095 treasury txs (0.30 a second). 15:00Z was next with 1,075.
- **The treasury's shard is almost empty.** `intents.near` is on shard 7 (protocol 86, 10 shards, chunk gas limit
  1,000 Tgas). In the peak hour the shard used **23.4 Tgas a chunk at p95 (2.3% of the limit)**, 6.4 at p50, 40.5 at
  most. The heaviest of the 136 blocks read used 75.9 Tgas (7.6%), at 2026-10-20 15:56:13Z.
- **Measured headroom: about 84 more settlements a second** at the peak hour's p95 load (976.6 Tgas free a chunk
  × 1.643 chunks a second ÷ 19.1 Tgas a settlement). At the heaviest block read, 79.5 a second.
- **The scale review's 19.4 settlements a second at 5k** would add 225.6 Tgas a chunk: **23% of the free gas at
  peak**, about a 4.3× margin. Gas on this shard does not limit the 5k design.
- No delayed or buffered receipt gas in any block read (congestion 0 throughout).

## 2. Numbers

| Measure | Value | Source |
|---|---|---|
| Treasury txs in 48 h | 24,357 (46 whole hours) | FastNEAR tx index, 122 pages |
| Busiest block by treasury txs | 220,642,701 with 7 (2026-10-19 10:05Z) | index |
| Gas per treasury tx (n = 200 from the peak hour, all `execute_intents`) | p50 6.08, p95 8.19, max 10.43 Tgas | `POST /v0/transactions`, receipts' `gas_burnt` |
| Gas per settlement (n = 16 pairs: the treasury transfer tx plus the receiver's withdrawal tx) | p50 19.10, p95 39.22 Tgas | same |
| Shard 7 gas a chunk, peak hour (60 blocks) | p50 6.41, p95 23.35, max 40.45 Tgas | neardata blocks |
| Shard 7 gas a chunk, top 30 treasury blocks | p50 28.49, p95 75.83, max 75.89 Tgas | neardata |
| Shard 7 gas a chunk, one block an hour (46) | p50 9.94, p95 23.51, max 34.84 Tgas | neardata |
| Receipts on shard 7 a chunk, peak hour | p50 4, max 9 (whole block: p50 38, max 111) | neardata |
| `intents.near`'s share of shard 7 gas in the blocks read | 89% | neardata |
| Block time in the peak hour | 0.609 s (1.643 a second) | neardata header timestamps |

Method: a chunk's gas is the sum of `gas_burnt` of every tx and receipt outcome in shard 7 of block h. The chunk header
at h+1 must report the same `gas_used`. **Second provider: 10 of 10 equal.** Five blocks came from
`archival-rpc.mainnet.near.org` (`rpc.mainnet.near.org` answers 422 for blocks past its garbage-collection window),
and five from `rpc.mainnet.near.org`.

## 3. Limits of this read

- **Sampled, not every block:** 136 of about 280,000 blocks in 48 h. The sample includes the top 30 treasury blocks
  and 60 from the peak hour. A short burst between samples can be higher.
- **Gas, not compute:** NEAR also caps compute per chunk. Where an operation's compute cost is above its gas cost, the
  margin is lower than shown. This read measured gas only.
- **The shard is shared:** 89% of its gas is already `intents.near`. If all of NEAR Intents grows with us, the free
  share falls. The congestion config (`reject_tx_congestion_threshold` 0.8) refuses new txs well before the hard limit.
- **The FAR side cannot be read:** confidential transfers inside FAR are not public. This read covers the public
  settlement on `intents.near` only.
- **06:00-09:00Z on 2026-10-20 is very low:** 17, 2, 6 and 54 treasury txs, against 279 at 05:00Z and 704 at 10:00Z.
  This is either a lull in the treasury's use or a gap in the tx index. UNKNOWN which. The 24 h M12 run
  (`proofs/m12-hood`) counts treasury txs per hour as well and will show whether it repeats.
- Settlements are counted as the heavier public shape (transfer plus withdrawal). A deposit or a return is one
  treasury tx (6.1 Tgas p50), so it costs about a third as much.

## 4. Sources (all keyless, read 2026-10-20 16:03-16:27Z)

- `https://tx.main.fastnear.com/v0/account` and `/v0/transactions`: treasury txs and receipts (172 calls).
- `https://mainnet.neardata.xyz/v0/block/<height>`: 136 whole blocks (178 calls).
- `https://rpc.mainnet.near.org` `EXPERIMENTAL_protocol_config` (shard layout, chunk gas limit, congestion config) and
  `block` at h+1; `https://archival-rpc.mainnet.near.org` for the older blocks (41 RPC calls).
- The estimate compared: `docs/research/future-direction-scale.md` §4 and FD-S-15 (19.4 settlements a second at 5k).
