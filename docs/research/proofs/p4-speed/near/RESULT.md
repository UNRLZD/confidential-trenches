# P4 speed proof, NEAR

Status on 2026-10-20 01:32Z: **self mode PASSES on mainnet when the fill is detected the way the product will detect
it**: the ghost's balance polled at `optimistic` every 200 ms on a read RPC. 20 of 20 round trips: buy p50 3.87 s /
p95 4.30 s, sell p50 3.75 s / p95 4.18 s (§8). At `final` it misses 5 s (polled p95 5.5-5.7 s). Sends went through
DeltaRPC (free, no key); the free FastNEAR endpoint refused them (`-429`). Float mode: 2 runs, optimistic 4.8-6.2 s,
misses (§7); the plan uses self mode on NEAR. Testnet: the whole live code path, 12 runs per mode, plus sweeps (§3).
Update 02:20Z: a fresh ghost swaps on **Rhea DCL with no DCL registration** (1 round trip on a nearlytrade token,
polled buy 4.1 s, sell 3.3 s; §9). One open edge there: a DCL payout to a ghost not yet registered on the token;
§9.2 measures that race on all 44 live buys, and money matrix v1.3 DN-24 closes it (sandbox on the real 2.3.15
code, §10).

| Question | Answer |
|---|---|
| Route | Rhea classic **instant swap** (`wrap.near.ft_transfer_call` → `v2.ref-finance.near`) with **`swap_out_recipient`**. The quote is one `get_return` view on the pool (`--route direct`, default). The Intear router (`--route intear`) is wired and validated hop by hop |
| Filled | All receipts of the swap tx done with no failure, then the ghost's token balance read back (sell: token 0 and the proceeds credited). Two clocks: **final** (`wait_until: FINAL`, reads at `final`), which the pass is judged on, and **optimistic** (`EXECUTED_OPTIMISTIC`, reads at `optimistic`). **Polled** (the pass line since §8): the ghost's balance at `optimistic` polled every 200 ms on the read RPC, as the product detects a fill |
| Testnet result (606 ms blocks, the same as mainnet's 582 ms) | final p50 **5.9–7.0 s**, optimistic p50 **4.4–5.5 s** (table §4) |
| Mainnet projection | final ~5.3–6.5 s, **misses 5 s**; optimistic ~3.9–5.0 s, **passes** for self mode, borderline for float sells |
| Weakest steps | send → INCLUDED (~1.5 s, ≈2.5 blocks), then the 4–5 block receipt chain (~2.4–2.9 s), then finality (~1.6 s) |
| Token | `nene-2250.meme-cooking.near` (meme.cooking launchpad), Rhea pool **8943**: SIMPLE_POOL NENE/wNEAR, fee 0.1%, ~355 wNEAR deep. Pool ids only grow and there were 8,937 pools on 2026-10-10 (UNRLZD external-facts C6), so this pool is less than 10 days old |
| Size | 0.3 NEAR per buy (~$1.49 at $4.95) |

## 1. Transaction shapes

### Mode `float` (app capital fronts the buy; the ghost never holds NEAR)

| Step | Signer (key) / payer | Tx | Clock |
|---|---|---|---|
| Setup | float k0 | `AddKey(k1)` once; `wrap.near` `[storage_deposit, near_deposit]` | once |
| Buy, tx A | float **k0** / float | `TOKEN.storage_deposit({account_id: ghost, registration_only: true})`, 0.00125 N, 10 Tgas | **click path, in parallel** |
| Buy, tx B | float **k1** / float | `wrap.near.ft_transfer_call({receiver_id: v2.ref-finance.near, amount, msg: {actions: [{pool_id: 8943, token_in: wrap.near, amount_in, token_out: TOKEN, min_amount_out}], swap_out_recipient: ghost, skip_unwrap_near: true, skip_degen_price_sync: true}})`, 1 yocto, 100 Tgas | **click path, in parallel** |
| Arm | float k0 / float | `Transfer(1 yocto)` → ghost. This creates the implicit account with its full-access key; then read the key's nonce | off the click path (could run in parallel with the buy on a third key) |
| Sell | ghost signs a **NEP-366 delegate action**; float **k1** relays and pays | inner: `TOKEN.ft_transfer_call({receiver_id: Rhea, amount: balance, msg: {actions: […TOKEN → wrap.near], swap_out_recipient: float, skip_unwrap_near: true}})`, 1 yocto, 100 Tgas; `max_block_height` = head + 600. Outer: float → ghost `[SignedDelegate]` | **click path** |

### Mode `self` (the ghost holds its own NEAR and signs everything; no float co-signer, no meta-tx)

| Step | Signer (key) / payer | Tx | Clock |
|---|---|---|---|
| Pre-fund | float → ghost | `Transfer(amount + 0.2 N)` creates the ghost's implicit account. In production this is a NEAR Intents withdrawal to the ghost; then ghost k0 `AddKey(k1)` | off the clock |
| Buy, tx A | ghost **k0** / ghost | `TOKEN.storage_deposit` (self), 0.00125 N | **click path, in parallel** |
| Buy, tx B | ghost **k1** / ghost | `wrap.near` `[storage_deposit(registration_only), near_deposit(amount), ft_transfer_call(Rhea, amount, msg without a recipient)]` | **click path, in parallel** |
| Sell | ghost k0 / ghost | `TOKEN.ft_transfer_call(Rhea, balance, msg without a recipient)`, so the wNEAR goes back to the ghost | **click path** |
| Teardown | ghost k0 | `wrap.near.near_withdraw(all)`, then `DeleteAccount(beneficiary: float)` | off the clock |

### Why these shapes work (each fact from a real read)

- **Rhea classic accepts `swap_out_recipient`.**
  - The live contract `v2.ref-finance.near` has code hash `25eNFdfK76NUEZn4cDgq1xQYKjxKCuzgXmPB3SHBRW4Y` (1.9.20, UNRLZD external-facts C1). Its wasm, read with `view_code` at block 220,712,514 on free.rpc.fastnear.com, contains the strings `swap_out_recipient`, `skip_unwrap_near`, `claim_lostfound`, `get_lostfound_token` and "client_echo and swap_out_recipient cannot have value at the same time".
  - Source (mirror `DevOfCredit/ref-contracts` b444323f, 1.9.18):
    - `token_receiver.rs:20-45`: the `Execute` msg fields.
    - `:144`: the output goes to `swap_out_recipient.unwrap_or(sender_id)`.
    - `action.rs:9-22`: the `SwapAction` fields.
  - Testnet `ref-finance-101.testnet` (code `AEAm8sQ5…`) has the same strings, and the 12 testnet runs used it for real.
- **Failed payouts go to lostfound.** If the ghost is not yet registered on the token, Rhea's payout fails and the tokens are credited to the ghost's Rhea **lostfound** (`account_deposit.rs:481-532`). The ghost can claim them with `claim_lostfound` (`account_lostfound.rs:52`). `--sweep` claims them.
  - The race (tx A against tx B's payout three receipts later) was never lost in 12 testnet runs: tx A finished executing at ~2.0–2.7 s, the payout at ~3.4–4.6 s.
- **The ghost account comes into being on a transfer.** A transfer to a 64-hex id creates the implicit account with a full-access key derived from the id, nonce = `block_height × 10^6` (nearcore 9ded02a2 `runtime/runtime/src/actions.rs:221-256`).
  - The creator pays `account_creation_charge` **0.007 N** out of the creating receipt's gas price surplus (`core/parameters/res/runtime_configs/85.yaml:43`, `runtime/runtime/src/lib.rs:1359-1395`).
  - Accounts of 770 bytes or less need no balance for storage (`runtime/runtime/src/verifier.rs:25`). A ghost with 1 yocto is valid.
- **Delegate actions put the cost on the relayer.** The relayer pays the delegate action's gas and its 1 yocto deposit; the sender's key nonce must be higher and becomes the delegate's nonce (UNRLZD external-facts O5; nearcore `actions.rs:480-520`). The inner receipt's `signer_id` is the relayer (NEP-366; external-facts Q4).
  - So the float-mode ghost needs **only to exist with its key**, never a balance.
  - The relayed sell passed 6 times out of 6 on testnet.
- **wrap.near storage and auto-registration.** wrap.near storage is 0.00125 N (external-facts B1). `near_deposit` auto-registers (core-contracts `w_near.rs:13-29`), but self mode sends an explicit `storage_deposit` in the same receipt: the same shape the Intear router returns, and it works whatever the deployed wrap code does.
- **Two keys allow the parallel buy.** Each tx has its own access key nonce, so tx A and tx B can be sent together.

## 2. Dry run on mainnet (`node run.mjs --dry`, 2026-10-19 22:13Z, `results/2026-10-19T22-13-47-723Z-dry.json`)

| Item | Value |
|---|---|
| RTT to free.rpc.fastnear.com | p50 95 ms (from Vietnam) |
| Block time | 582 ms (average of the last 100 headers). The optimistic head is 2 blocks ahead of final |
| Gas price | 1e8 yocto/gas |
| Direct quote (`get_return`, 1 view) | 89–154 ms. 0.3 N → 116,837 NENE (min 113,332 at 3%); min out sells back for 0.2899 wNEAR |
| Intear router | 943 ms (cold), 388, 254 ms. Same output, single pool 8943 |
| Preconditions (views) | ghost not registered on the token (`storage_balance_of` null), Rhea lostfound 0, ghost account absent, float not yet created |
| Signing (throwaway keys, all 7 txs) | 0.4–2.2 ms. Sizes: storage 395 B, float swap 701 B, create 295 B, **delegate sell 974 B**, self swap 730 B, self sell 627 B |
| Receipt depth of real swaps of this token (FastNEAR tx API) | single-pool `wrap.near` swaps: Rhea at +2 blocks, **payout to the trader at +3**, last receipt at +4 (`8FJ97J4s…`, `7KguW42a…`, `2mwpqYDg…`, `BG4A8XHA…` in `…21-45-07…-dry.json`) |
| Fixed costs per ghost | create 0.007 N (both modes) · token storage 0.00125 N · self mode wrap storage 0.00125 N |

Dry mode never signs with a real key. Every tx is built for real and signed with random throwaway keys to time signing and measure size.

## 3. Testnet runs (real txs, throwaway keys, `--rehearse`)

Setup: `ref-finance-101.testnet` pool **2131** = `mev-33.factory.v9.meme-cooking.testnet`/`wrap.testnet` (a meme.cooking token, fee 0.1%), 0.3 N per buy. The float was funded from a faucet account created through `helper.testnet.near.org`; all of it was swept back. Testnet blocks are 606 ms; testnet RPC RTT from this Mac is ~265 ms (mainnet: 95 ms).

Every run passed end to end in both modes. Each step completed:
- the parallel buy;
- the arm or the self setup;
- the delegate sell (float) or own sell (self);
- the self teardown via `DeleteAccount`;
- `--sweep --live`, which claimed and sold leftovers, closed the ghosts and returned the float.

**Bugs the testnet runs found (all fixed):**
- **Query errors arrive in two shapes.** Missing keys or accounts come back as `result.error`, not an RPC error, so the float's second key was never added.
- **Self mode ran out of balance at 0.05 N headroom.** A self-mode ghost needs ~0.12 N of headroom because gas is prepaid at the pessimistic price (`NotEnoughBalance`); the headroom is now 0.2 N, refunded.
- **The exact-amount teardown transfer failed `NotEnoughBalance`.** It was replaced by `DeleteAccount`. The refund that follows a delete fails harmlessly, since its account is gone.
- **Transient send errors were final.** They now fall back to a lookup by hash.

## 4. Latency, measured on testnet (ms after the click; p50 / p95)

Files: `results/2026-10-19T22-00-02-512Z-rehearse.json` and `…22-03-19-024Z…`; 6 runs per mode and side. Sells' `visFinalPoll` comes from `22-03` only, after the poll was made to wait for the proceeds.

| Mode, side | quote | send→INCLUDED | all receipts executed | **opt** | balance seen at final (300 ms poll) | FINAL outcome | **final** |
|---|---|---|---|---|---|---|---|
| float buy | 271 / 291 | 2005 / 5530 | 4467 / 8291 | **4725 / 8544** | 5205 / 8574 | 6080 / 10019 | **6490 / 10279** |
| float sell (delegate) | 269 / 290 | 1749 / 1975 | 5135 / 5808 | **5455 / 6103** | 6001 / 6229 | 6617 / 7060 | **7003 / 7770** |
| self buy | 273 / 301 | 1756 / 2227 | 4120 / 4643 | **4368 / 5230** | 4689 / 5791 | 5935 / 6493 | **6250 / 6767** |
| self sell | 271 / 282 | 1820 / 2083 | 4260 / 4605 | **4589 / 4909** | 5014 / 5550 | 6088 / 7052 | **6346 / 7383** |

Notes on the table:
- The float buy p95 is one outlier: INCLUDED took 5.5 s once.
- Sending through `rpc.testnet.near.org` instead of FastNEAR made INCLUDED take **4.9 s** (p50) and the final click→filled **12.6 s** (`…22-04-58…`). **The send RPC is the biggest lever.**

### Budget per step and the weakest step

| Step | Testnet | Mainnet projection | Comment |
|---|---|---|---|
| Quote | ~270 ms (1 RTT) | ~100 ms | direct `get_return` |
| Build + sign | 3–5 ms | 3–5 ms | ed25519. The delegate adds one more signature |
| Send → INCLUDED | ~1.5 s after signing | ~1.4 s | **weakest**: RPC forwarding plus waiting for a chunk, ≈2.5 blocks |
| Receipts → executed | buy 4 blocks, self sell 4, **float sell 5** (the delegate hop) | 2.3–2.9 s | Rhea +2, payout +3, callback +4, matching the mainnet samples |
| Read-back | 1 RTT | ~100 ms | |
| FINAL | +1.6–1.9 s after executed | ~+1.2–1.7 s | finality lag of 2 blocks plus the long-poll's return |

**Mainnet projection.** Take the testnet numbers and remove ~3 RTT differences (~0.5 s); block times are equal:
- optimistic: self ~3.9–4.1 s, float buy ~4.2 s, float sell ~5.0 s (p50);
- final: ~5.8–6.5 s (p50).

The dry-run formula (`--dry`) gives a lower bound: final 5.3–5.9 s.

**Verdict to expect from `--live`:**
- On the strict definition (FINAL outcome + balance at final), **NEAR misses p95 ≤ 5 s** in both modes.
- On the optimistic definition, **self mode passes**; float mode buys pass and float sells sit on the line.

The ghost's balance is final one block before the tx's last receipt (the "balance seen at final" column), which is ~0.5–1 s earlier.

## 5. Live run (run on 2026-10-19 by Claude under plan §11.11; results in §7)

**Funding.** Fund the float `87ea8fb0343f98d7ef9bd08bcd4e241c8b15821b46a91788b24c5f3ea12a6b6c` with **2.5 NEAR**, from the hackathon funder `951a5eab7965eb95c3aae56d5da9535c21b9fa70da1105b93f4bc220703bfb33` (not yet funded) or from P1's NEAR out-leg.
- The run checks for ~1.7 N up front.
- 40 round trips cost ~0.5 N (~$2.5): per run 0.007 create + 0.00125–0.0025 storage + ~0.0035 gas + ~0.2% pool fees.

```sh
cd ~/Downloads/confidential-trenches/proofs/p4-speed/near && npm ci --silent && node run.mjs --live --runs 20 2>&1 | tee results/live-$(date +%s).log
```

Then return everything (claims lostfound, sells leftovers, unwraps, closes the ghosts, sends the float's NEAR to the funder):

```sh
cd ~/Downloads/confidential-trenches/proofs/p4-speed/near && node run.mjs --sweep 951a5eab7965eb95c3aae56d5da9535c21b9fa70da1105b93f4bc220703bfb33 --live
```

**How the run behaves:**
- It runs float mode, then self mode, 20 runs each, with a fresh ghost per run.
- It stops a mode after 3 failures in a row.
- It writes `results/<ts>-live.json`: every step per run, plus final and optimistic p50/p95 per mode and side, judged against p95 ≤ 5 s.
- Options: `--route intear`, `--send-rpc <url>`, `--poll-ms 0`.

## 6. Open risks

1. **Strict finality misses 5 s.** The receipt chain (4–5 blocks) plus finality (2 blocks) plus inclusion (~2.5 blocks) is ~9 blocks ≈ 5.2 s before any RTT. No route on Rhea classic is shorter than `ft_transfer_call` (4 receipts). Ways to recover:
   - count "filled" at the payout receipt's finality (one block earlier);
   - send through a faster RPC or straight to validators;
   - use self mode for sells (no delegate hop).
2. **Inclusion depends on the RPC.** It took 1.5–2 s on FastNEAR and ~5 s on rpc.testnet.near.org. The free FastNEAR endpoint is IP-limited and shared with the owner. The live run makes ~20 calls per trade, including a 300 ms final-balance poll.
3. **Storage race.** If tx B's payout ever lands before tx A's registration, the tokens sit in the ghost's Rhea lostfound until claimed (`--sweep` claims them). This never happened in 12 testnet runs.
4. **Float mode: arm before sell.** Creating the ghost (`Transfer` 1 yocto, ~3.7–4.8 s to FINAL) must land before a sell can be relayed. A sell clicked within ~4 s of the buy would wait for it.
   - In production, send the create in parallel with the buy on a third float key.
5. **Self-mode capital.** Each ghost locks ~0.2 N of gas headroom beyond the trade while it trades (refunded). Each ghost also strands 0.0025 N of storage on the token and wrap, plus 0.007 N creation, in both modes.
6. **Intear sees the trader.** `--route intear` sends `trader_account_id` (the float or ghost) to a third party. The default `direct` route uses only RPC views.
7. **Mainnet Rhea code** is cited by wasm strings plus 1.9.18 source. The live code hash is 1.9.20, whose source was not read.

## 7. Mainnet live attempts (run by Claude under plan §11.11, 2026-10-19 23:16Z–00:08Z)

| Attempt | RPCs (reads / sends) | Result | Record |
|---|---|---|---|
| 1, 23:16Z, 2 runs per mode | FastNEAR free / FastNEAR free | 4 of 4 failed on `-429` (4–8 retries each) | `…23-17-30-770Z-live.json` |
| 2, 23:54Z, 2 runs per mode | dRPC / FastNEAR free | **float 2 of 2 filled, 0 throttled**; self 2 of 2 failed on `-429` during setup | `…23-56-24-589Z-live.json` |
| 3, 00:00Z, self only | dRPC / ZAN | did not start: the float was short while the failed self ghosts held their pre-funds | `live-sample-zan-*.log` |

**Float mode on mainnet (attempt 2), ms after the click:**

| Run | Side | quote | send → INCLUDED | executed (`EXECUTED_OPTIMISTIC`) | **opt** (balance seen) | FINAL | **final** (balance at final) |
|---|---|---|---|---|---|---|---|
| 1 | buy | 259 | 3405 | 5802 | **6217** | 7603 | **7826** |
| 1 | sell | 278 | 1710 | 5534 | **5793** | 6936 | **7286** |
| 2 | buy | 294 | 2062 | 4500 | **4821** | 6393 | **6657** |
| 2 | sell | 238 | 1594 | 4737 | **5078** | 6299 | **6631** |

- Reads went to dRPC (p50 ~275 ms from this Mac, against FastNEAR's ~150 ms), so the balance columns carry ~0.1 s
  more read latency than a FastNEAR read would.
- **Where the time goes:** send → INCLUDED 1.6–3.4 s (projection 1.4 s), then the receipt chain 2.4–3.8 s (4 blocks
  for a buy, 5 for the delegate sell), then finality ~1.6–1.8 s. The projection of §4 (optimistic ~4.2 s float buy,
  ~5.0 s float sell) was ~0.6–2 s too low because inclusion was slower than on testnet.
- **Check:** the 6 txs (2 × storage + swap, 2 × delegate sell) re-read on `rpc.mainnet.near.org`
  (`EXPERIMENTAL_tx_status`): all FINAL, SuccessValue, 0 failed receipts; each swap and sell has its Rhea transfer and
  swap logs.
- **Verdict so far:** NEAR misses p95 ≤ 5 s even at optimistic in float mode (n = 2 per side; not a p95). Self mode
  (no delegate hop on the sell, no float co-signer) is projected ~0.4–0.8 s faster and is still unmeasured on mainnet.
- **What would move NEAR under 5 s at optimistic:** a keyed RPC (inclusion is the biggest and most variable step),
  sending the same signed tx to two RPCs at once, self-mode sells, and a quote made before the click (§6 item 1). The
  receipt chain of Rhea classic (4–5 blocks, ~2.4–2.9 s) is a floor no RPC changes.

**Money.** Attempt 1 left ghost#1 `5ae348de…` holding 114,030 NENE, sold in the last sweep (0.2994 wNEAR). Every
ghost is closed or empty; the float keeps 0.01 N; the rest went back to the funder `951a5eab…` (sweeps `85wHj3Bk…`,
`ZagWgrc4…`, `5BTewCfT…`). Net cost of all three attempts and the sweeps: **~0.104 N (~$0.52)**.

## 8. Self mode on mainnet (2026-10-20 00:50Z-01:27Z, run by Claude under plan §11.11)

Reads on dRPC (`near.drpc.org`). Sends and tx-status waits on DeltaRPC (`nearinner.deltarpc.com`, free, no key). Token,
pool and size as above. A fresh ghost each run, pre-funded off the clock by the float, deleted at teardown.

| Run | Record (`results/`) | n | Fill detected by | Buy p50 / p95 (ms) | Sell p50 / p95 (ms) |
|---|---|---|---|---|---|
| A, 00:50Z | `2026-10-20T00-51-31-374Z-live.json` | 2 | the send RPC's `EXECUTED_OPTIMISTIC` answer, then a balance read | 4550, 4935 | 4936, 4698 |
| B, 00:58Z | `2026-10-20T01-09-49-556Z-live.json` | 20 | same as A | 4796 / 7528, FAIL | 4602 / 5034, FAIL |
| C, 01:16Z | `2026-10-20T01-27-04-776Z-live.json` | 20 | **the balance polled at `optimistic` every 200 ms** (`--poll-opt-ms`) | **3870 / 4295, PASS** (max 4328) | **3745 / 4177, PASS** (max 4385) |

- **Why B missed and C passed.** Both runs took the same chain path. B waited for the send RPC to answer; that answer
  lags the chain. In C the polled balance showed the fill 0.85 s (p50) before the send RPC's answer arrived. Run C #3:
  the balance showed the buy at 4295 ms; the send RPC reported INCLUDED only at 5062 ms.
- **Run C at `final`:** the balance polled at `final` (300 ms) showed buys at p50 5033 / p95 5456 ms and sells at
  5029 / 5660 ms. Misses 5 s by ~0.5 s: finality is ~2 blocks after execution.
- **Run C steps (buy, p50 / p95):** quote 248 / 315 ms, signed 250 / 317 ms after the click. The send RPC's own clocks:
  INCLUDED answer 2081 / 4564 ms; receipt chain after it 2355 / 2551 ms.
- **Product rule:** detect a NEAR fill by polling (or streaming) the ghost's balance at `optimistic` on a read RPC.
  Never wait on the send RPC's answer. Sending the same signed tx to two RPCs should cut inclusion tails (not measured).
- **Check:** every tx re-read on `rpc.mainnet.near.org` (`EXPERIMENTAL_tx_status`, real `signer_id`): A 6/6, B 60/60,
  C 60/60 FINAL with 0 failed receipts. 0 throttled sends.

**Money.** Float deltas: A 0.031541 N, B 0.315376 N, C 0.315433 N, about 0.0158 N (~$0.076) a round trip: gas for
5 txs, the two 0.00125 N storage deposits each ghost strands (§6 item 5), the pool fee and price impact. The three
funding transfers burnt 0.000835 N each. All 42 ghosts were deleted with their NEAR back in the float. Sweeps
`65qmT4or…` and `JDpXmTZZ…`: FINAL, no failure. The float keeps 0.01 N; the funder `951a5eab…` holds 4.145564 N
(01:32Z), which reconciles with the transfers and their gas. Spent tonight: **~0.666 N (~$3.22 at $4.83, CoinGecko
2026-10-20 01:32Z)**; all NEAR P4 runs: ~0.770 N (~$3.72).


## 9. Rhea DCL from an unregistered ghost (2026-10-20 02:17Z, run by Claude under plan §11.11)

The question (coverage paper Q1): can a fresh ghost swap on Rhea DCL (`dclv2.ref-labs.near`, `get_metadata.version`
2.3.15) without the 0.5 N DCL registration? UNRLZD fact D5 had it only from a sandbox on 2.3.13.

**Answer: yes.** One self-mode round trip, `--route dcl`, 0.1 N, token `neair.nearlytrade.near` (nearlytrade, global
contract `8GXVnFTx…`, `get_tax` buy 100 / sell 100 bps on `dclv2.ref-labs.near`), pool
`neair.nearlytrade.near|wrap.near|10000` (`get_pool`: Running, whitelist null). Record
`results/2026-10-20T02-17-44-421Z-live.json`.

| Tx | Hash | Actions | Receipts |
|---|---|---|---|
| Buy, storage | `5WnJ4H2n…` | `neair.storage_deposit` (registration only, 0.00125 N) | executed at block 220,740,961 |
| Buy, swap | `5tVe3uee…` | `wrap.storage_deposit` + `near_deposit` + `ft_transfer_call` to dclv2, msg `Swap{pool_ids, output_token, min_output_amount}` | wrap 220,740,961 → dclv2 `ft_on_transfer` 220,740,962 → `neair.ft_transfer` to the ghost 220,740,963 → `callback_post_withdraw_asset` → `ft_resolve_transfer` |
| Sell | `4u5D3hk7…` | `neair.ft_transfer_call` to dclv2, msg `Swap{…, output_token: wrap.near}` | dclv2 `ft_on_transfer` → `wrap.ft_transfer` to the ghost → callback → `ft_resolve_transfer` |

- **No DCL registration.** No tx touched `dclv2.ref-labs.near` storage. `storage_balance_of(ghost)` on dclv2 = null after
  the run. Both swaps paid the ghost directly.
- **Amounts.** Buy: quote 95,743.38 NEAIR, got 94,785.94 (99.0%: the token's 1% buy tax, taken in the DCL → ghost
  transfer). Sell: all 94,785.94 sent, dclv2 received 93,838.08 (1% sell tax), paid 0.096060 wNEAR = 99.0% of the
  quote. Round trip 0.1 → 0.096060 N: 3.94% = two 1% pool fees + two 1% taxes. `get_pool`/`quote` do not include the tax.
- **Speed (one run, ms after the click).** Buy: quote 252, signed 256, polled optimistic **4136**, final 6385.
  Sell: quote 239, signed 241, polled optimistic **3252**, final 5974. In line with the classic runs in §8 (n = 1).
- **Check.** All 3 txs re-read on `rpc.mainnet.near.org` (`EXPERIMENTAL_tx_status`, signer = the ghost): FINAL, 0
  failed receipts. The ghost was deleted (`view_account`: UNKNOWN_ACCOUNT). Sweep `NF9izUDS…`: FINAL, no failure.
- **Money.** The funder sent 0.45 N (`5jg8bt4o…`) and got 0.429717 N back. Funder 4.145563 → 4.124446 N: **0.021117 N
  (~$0.10)** all in (gas, the two 0.00125 N storage deposits, fees, taxes).

**Open edge (not tested): the output transfer to a ghost not yet registered on the token.** The token
`storage_deposit` and the swap go in parallel. Here both landed in block 220,740,960, and the registration ran two
blocks before DCL's transfer to the ghost. If the registration lands later, DCL's transfer fails. Rhea classic then
keeps the tokens in `lostfound` (claimable, §1). DCL is closed source (UNRLZD D6): what `callback_post_withdraw_asset`
does with a failed transfer to an unregistered account is UNKNOWN. Recorded for the money matrix; test it in a
sandbox on the 2.3.15 wasm before the product uses DCL.

Update 02:30Z: UNRLZD's sandbox on the real v2.3.13 wasm answers it: an unregistered account's undelivered output goes
to DCL's lostfound, which only the DCL owner can release (UNRLZD `docs/contract-spec.md:91`, audit brief T5b). So the
product never sends the swap before the registration has executed (money matrix v1.2 DN-24). Revised 03:15Z (§9.2,
v1.3 DN-24): G registers on DCL when armed, so a failed payout stays its own, and the pair stays parallel.

### 9.1 A Hoot token (2026-10-20 02:31Z)

Same command on `tap.v2-launchpad.justhoot.near` (Hoot v2 launchpad, global contract `kS1z69vk…`, no `get_tax` view),
pool `tap.v2-launchpad.justhoot.near|wrap.near|10000` (Running, whitelist null). Record
`results/2026-10-20T02-31-14-923Z-live.json`.

| Tx | Hash | Result |
|---|---|---|
| Buy, storage | `8QaVa8pk…` | registration executed at block 220,742,337 |
| Buy, swap | `8QL6Lt7b…` | wrap 220,742,337 → dclv2 220,742,338 → token payout to the ghost 220,742,339 |
| Sell | `5QJhGpxJ…` | dclv2 swap, wNEAR to the ghost, then the token's `transfer_fee_settled` |

- **No DCL registration** again: dclv2 `storage_balance_of(ghost)` = null; the ghost was deleted (UNKNOWN_ACCOUNT).
- **Speed (n = 1, polled optimistic):** buy **3942 ms**, sell **4133 ms**. The send RPC's own EXECUTED_OPTIMISTIC answer
  for the buy came at 8539 ms, 4.6 s after the balance showed the fill: one more case for the §8 product rule.
- **Hoot charges a transfer fee on pool transfers.** Buy: DCL paid out 94,724.35 TAP; the ghost got 92,735.14 and
  1,989.21 went to the token contract (memo `transfer_fee`). Sell: 1,947.44 was held from the ghost's transfer
  (`transfer_fee_held`, then `transfer_fee_settled`). That is 2.1% each way. The rate is per token in
  `get_config.transfer_fee_pips`: TAP 21,000 (2.1%), `wehooo.v2-launchpad.justhoot.near` 10,000 (1%), v1 token
  `bon-8adaf6.launchpad.justhoot.near` 1,000 (0.1%) (block ~220,742,530). The v2 wasm (220,951 bytes, read with
  `view_global_contract_code` at block 220,742,506) exports `set_transfer_fee`, so the rate can change after launch
  (who may call it: UNKNOWN). The DCL `quote` view does not include it. Product: read the rate (nearlytrade
  `get_tax`, Hoot `get_config.transfer_fee_pips`) at the quote, size `min_out` after it, and show it (journeys J4.F17,
  J19). Round trip 0.1 → 0.093938 N: 6.1% = two 1% pool fees + two 2.1% transfer fees.
- **Check:** 3/3 txs FINAL on `rpc.mainnet.near.org` with 0 failed receipts; funding `3yJpQEoJ…` and sweep `APzYSp21…`
  FINAL, no failure.
- **Money:** funder 4.124446 → 4.100782 N: **0.023664 N (~$0.11)**. Both DCL runs: 0.044781 N (~$0.22).

### 9.2 The registration race, measured on every live self buy (2026-10-20 03:06Z)

All 44 live self-mode buys (records `…00-51-31…` 2, `…01-09-49…` 20, `…01-27-04…` 20 on Rhea classic; `…02-17-44…` and
`…02-31-14…` 1 each on DCL) sent the token `storage_deposit` (key k0) and the swap (key k1) in parallel. For each, read
with `EXPERIMENTAL_tx_status` and `block` on `rpc.mainnet.near.org` / `near.drpc.org`: the block of each tx, the block
where the registration executed on the token, and the block of the token's payout to the ghost.

| Margin: payout block − registration block | 0 | 1 | 2 | 3 | 6 |
|---|---|---|---|---|---|
| Buys | 1 | 1 | 33 | 8 | 1 |

- The margin is 2 − (registration tx block − swap tx block) in every row: the registration executes one block after its
  tx, the payout three blocks after the swap tx (wrap → Rhea → token).
- In 2 of 44 the registration tx landed after the swap tx: by 1 block (run C #0, margin 1) and by 2 blocks (run B #10:
  registration tx 220,733,493, swap tx 220,733,491; both receipts executed on the token in block 220,733,494, the
  registration first). A registration tx 3 or more blocks behind the swap tx loses the race.
- No buy lost it, but the parallel pair is safe only where a lost race stays claimable by the ghost: Rhea classic (the
  ghost's lostfound, §1) and DCL when the ghost is registered on DCL (its own DCL balance, `withdraw_asset`; UNRLZD
  `docs/contract-spec.md:23`, :91, sandbox on v2.3.13). An unregistered ghost's lost race on DCL is locked (owner only).
  Money matrix v1.3 DN-24 decides it.
- Read-only; no tx. The script ran inline (the numbers above are its whole output).

## 10. Where a failed DCL payout goes, on the real 2.3.15 code (sandbox, 2026-10-20 03:27Z)

`dcl-sandbox/` runs the mainnet code in a local sandbox (near-workspaces 0.23, sandbox 2.13.4): `dclv2.ref-labs.near`
(1,075,451 bytes, code hash `8FYiayAin…`, `get_metadata.version` 2.3.15) and `wrap.near` (`DL2f5xmZ…`), both read at
block ~220,747,863 by `fetch-code.mjs`, which checks each against the account's on-chain code hash. The token is
UNRLZD's test token `mock_ft.wasm` (sha256 `f8faa376…`), a plain NEP-141 that refuses transfers to unregistered
accounts. Records: `results/2026-10-20T03-27-25Z-dcl-sandbox.txt` (the run's output) and
`results/2026-10-20T03-27-25Z-dcl-sandbox-code.json` (the code read).
No mainnet tx.

| Step | Result |
|---|---|
| G arms: one batch to dclv2, `storage_deposit{account_id: G, registration_only: true}` 0.5 N + `storage_withdraw{}` 1 yocto | events `init_user_storage` 0.5 N, `withdraw_user_storage` 0.4 N, `remain` 0.1 N; `storage_balance_of(G)` = total 0.1 N, available 0 |
| G buys MEME (1 wNEAR) without a MEME registration | swap event; DCL's payout to G fails; event `lostfound {locked: false, user: G}`; `list_user_assets(G)` = the whole output; G's MEME balance 0 |
| G `storage_unregister` while it holds that asset | refused (receipt failure) |
| G registers on MEME, then `withdraw_asset{token_id}` | `ft_transfer` dclv2 → G of the whole output; G's DCL assets empty |
| G `storage_unregister` | event `unregister_user_storage` 0.1 N to sponsor G; `storage_balance_of(G)` null |
| H buys the same way with no DCL registration (P4-NEAR §9's shape) | event `lostfound {locked: true, user: H}`; `list_user_assets(H)` empty: the output is locked, DCL owner only |

So on 2.3.15, as on 2.3.13 (UNRLZD): a ghost registered on DCL keeps any failed payout and gets it back itself; an
unregistered one loses it. Money matrix v1.3 DN-24 (e) stands on this. A one-off mainnet check (one tiny refused
payout, ~0.02 N) is optional; the session's permission check refused writing that script, so it would need the
owner's OK.
