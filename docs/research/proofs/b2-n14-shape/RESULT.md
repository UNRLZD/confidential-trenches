# B2: the NEAR replacement N-14 (06c §5.1, §7 item 6)

Status 2026-10-22 19:15Z (from `date -u`): **done. The shape works: PROVEN in a sandbox on the code mainnet runs, 22 of
22 checks PASS.** A `Transfer(1 yocto)` G → G on the stored tx's key and nonce makes the stored tx dead once it lands,
but it races the original rather than replacing it, and it costs more than 06c assumes. Prep lane PR1 (merge note M190
(12), read B2). No mainnet or testnet tx: the only mainnet calls are three reads (§1).

## Verdict

1. **It works.** Once R (the replacement) lands at nonce n on (G, k), the original A at nonce n is refused with
   `InvalidNonce {tx_nonce: n, ak_nonce: n}` and can never land (T1, T4). Exactly one of A and R lands, never both
   (T2, 8 of 8 rounds).
2. **It races the original. It does not override it.** NEAR's pool has no same-nonce replacement or fee bump. Both txs
   go into the pool, which dedupes by hash only. The chunk producer takes one tx per (account, key) and drops the other
   without telling anyone. In the sandbox's single pool, the tx inserted *later* won every time (A then R: R landed
   4 of 4; R then A: A landed 4 of 4), because the pool sorts equal nonces stably and pops from the end (§2 row 3).
   Mainnet has a separate pool on each chunk producer, so which tx wins depends on where each one sits.
3. **The loser's sender gets no error.** `send_tx` accepted both txs in every T2 round. The loser only shows up as
   `UNKNOWN_TRANSACTION` on a lookup. If A has already been applied at the RPC's head, R is refused at once with
   `InvalidNonce` (T5).
4. **Full-access keys only.** R signed by a function-call key is refused with `RequiresFullAccess` (T3). That is not
   a problem here: G's slot keys k0 and k1 are both full access (06c line 75, the key table at line 417, and N-1).
5. **Cost.** R costs **8.3499 Tgas = 0.0008349895375 N** at today's mainnet gas price (1e8 yN/gas). Most of that comes
   from the receiver: a `Transfer` to a 64-hex implicit account always pays the `create_account` and
   `add_full_access_key` fees, even when the account exists, and `create_account`'s execution fee has been 7.2 Tgas
   since protocol 85. Before the refund, the signer pays about **0.0076 N**, because the receipt's gas is bought at
   `min_gas_purchase_price` 1e9 yN/gas. The surplus is then refunded (§2 rows 8-9).

**What the adapter needs (input for CO; 06c is not edited by this lane):**
- (a) After R is sent, look up **both** hashes on two providers. A is `dead` when R is final on both. A has `landed`
  when A is found, even after R was sent; R's `InvalidNonce`, or R not found, means look for A. 06c's A4 (b) rule
  covers the silent loser: the key's nonce at `final` is ≥ n while neither provider has the tx.
- (b) Stop resending A's bytes (CNG-05's 2 s resend) once R is sent, and resend R instead. In one pool, a later
  insert wins, so a resent A can beat R (T2).
- (c) Cost bound for N-14: **0.000835 N** final and **0.0076 N** upfront. A cheaper shape with the same effect is a tx
  with **no actions**, G → G, at the same nonce. Both the runtime and the RPC accept it, it lands, and A is then
  `InvalidNonce` (T4). It costs **0.2161 Tgas = 0.0000216119 N** (39× less) and about **0.000119 N** upfront. The
  choice of shape is CO's.

## 1. What mainnet runs (keyless reads, 2026-10-22)

| Request | Response |
|---|---|
| 19:03:12Z `POST https://rpc.mainnet.near.org` `{"method":"status"}` | `version` 2.13.4, `commit` `44f7ae6cd7ef08bab604e20a473bf77e35d4c993`, `protocol_version` 86, `latest_protocol_version` 86, head 221,131,693 |
| 19:14:22Z `{"method":"gas_price","params":[null]}` | `gas_price` `100000000` |
| 19:14:22Z `{"method":"EXPERIMENTAL_genesis_config"}` | `transaction_validity_period` 86400 (genesis `min_gas_price` 1e9, the 2020 value; the live price is 1e8, above) |

## 2. The source (nearcore at mainnet's commit `44f7ae6cd7ef08bab604e20a473bf77e35d4c993`, tag 2.13.4)

Links are `https://github.com/near/nearcore/blob/44f7ae6cd7ef08bab604e20a473bf77e35d4c993/<path>#L<line>`.

| # | Fact | Where |
|---|---|---|
| 1 | Nonce rule (`NonceMode::Monotonic`, every regular tx): refused when `tx_nonce <= current_nonce` → `InvalidNonce`; refused when `tx_nonce >= block_height × 10^6` → `NonceTooLarge`. Gaps are allowed, so any later nonce also kills A, but only the same nonce makes A and R exclusive | `runtime/runtime/src/verifier.rs:219-235` |
| 2 | The pool dedupes by tx hash only (`Duplicate`) and groups txs by (signer, public key). Two different txs at one nonce both go in | `chain/pool/src/lib.rs:27`, `:93-94`, `:119-122` |
| 3 | When a group is read, its txs are sorted by nonce with `sort_by_key(Reverse(nonce))`, a stable sort, and `next()` pops from the end. Among equal nonces, the tx inserted last comes out first | `chain/pool/src/lib.rs:257`; `chain/pool/src/types.rs:34` |
| 4 | Chunk preparation takes one tx per group per pass ("Take one transaction from this group, no more"). The next tx at the same nonce then fails verification against the updated nonce and is discarded, not returned to the pool | `chain/chain/src/runtime/mod.rs:1019-1024`, `:1104-1135` |
| 5 | The RPC checks a tx against the head's state before it enters the pool (validity period, then `can_verify_and_charge_tx` with nonce and balance). The nonce upper bound is skipped there (`block_height: None`). A duplicate hash answers as a valid tx | `chain/client/src/rpc_handler.rs:164-172`, `:247-259`, `:268-270`; `chain/chain/src/runtime/mod.rs:754-773` |
| 6 | A function-call key may sign only a single `FunctionCall` with zero deposit. Anything else → `RequiresFullAccess` | `runtime/runtime/src/verifier.rs:167-180`, `:359-361` |
| 7 | A tx with no actions passes validation: there is a maximum (`max_actions_per_receipt` 100) and no minimum | `runtime/runtime/src/action_validation.rs:62-74` |
| 8 | A `Transfer` to a `NearImplicitAccount` adds the `create_account` and `add_full_access_key` fees to both send and exec, whether or not the account exists. Since protocol 85, `create_account` is send 0.5 Tgas and exec 7.2 Tgas (was 3.85 / 3.85), plus `account_creation_charge` 0.007 N, which is charged only when an account is actually created | `core/parameters/src/cost.rs:722-777` (`:738`, `:767`); `core/parameters/res/runtime_configs/85.yaml:16-27`, `:43`; `runtime/runtime/src/lib.rs:1242-1246` |
| 9 | Gas for the receipt is bought at `max(gas_price, min_gas_purchase_price)` (1e9) and the price difference is refunded after it burns | `runtime/runtime/src/config.rs:458-468`; `parameters.snap`: `min_gas_purchase_price 1_000_000_000` |

NEAR docs (`near/docs` at `4200100094696005fdffcd4c179952326451b6b7`):
- `docs/protocol/transactions/transaction-anatomy.mdx:27-31`: a tx is accepted only if its nonce is in
  `[(current_nonce_of_access_key + 1) .. (block_height * 10^6)]`, and the key's nonce becomes the included tx's nonce.
- `docs/protocol/accounts-contracts/access-keys.mdx:22`, `:32`: function-call keys cannot attach NEAR or transfer it.
- `docs/integrations/transaction-lifecycle.mdx:34-42`: every validating node keeps its own pool; the pool iterator
  takes txs with increasing nonces per access key; being admitted to a pool does not guarantee inclusion.

## 3. The sandbox run

`n14.mjs` runs near-sandbox 2.13.4 (the same `commit` as mainnet, `protocol_version` 86, `min_gas_price` 1e8). Genesis
gets G, the 64-hex implicit account of a fresh key k0, with 100 N, and `bob.near`. k0 then adds k1 (FullAccess) and
kf (a function-call key on `bob.near`) to G in one tx, the N-1 shape. A = `Transfer(0.01 N)` G → `bob.near` on k1,
the stored original. R = N-14 = `Transfer(1 yocto)` G → G on the same key and nonce. Every key is made in the run,
held in memory and gone at the end. Command: `HEAVY_REMOTE=0 scripts/heavy.sh b2-n14 -- proofs/b2-n14-shape/run.sh`.
The PC box was tried first (`HEAVY_REMOTE=1`, 19:09:18Z) and refused: `<build box> does not answer`. ssh reached the
host over Tailscale but got `Connection reset by peer` on port 22. The run took slot 2 of the Mac queue, 19:12:57Z to
19:13:18Z, on Darwin arm64 with node v24.22.1. Records: `results/run-2026-10-22T19-12-57Z.txt` (the output) and
`results/sandbox-2026-10-22T19-12-57-372Z.json` (every answer). Sandbox block time was about 129 ms and its
`transaction_validity_period` 100, which no case depends on.

| Case | Requests | Result |
|---|---|---|
| T1 sequential | A signed at n = 48000001 and held; `send_tx` R `wait_until: FINAL`; then `send_tx` A | R lands. k1's nonce at `final` = n. A refused: `{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"ak_nonce":48000001,"tx_nonce":48000001}}}}`. `EXPERIMENTAL_tx_status` A: `UNKNOWN_TRANSACTION`. `bob.near` unchanged |
| T1 cost | R's outcomes and `view_account` G before and after (3 blocks after `final`) | tx 824,947,687,500 gas (`82494768750000000000` yN); receipt 7,524,947,687,500 gas (`752494768750000000000` yN); a refund receipt, gas listed 7,524,947,687,500 at 0 yN. G's balance delta **−0.000834989537500000000000 N** = the tokens burnt (the 1 yocto stays in G) |
| T2 race | 8 rounds; A and R at a new nonce each round, both sent with `wait_until: NONE` back to back (0-1 ms each), before either lands; lookups 5 blocks after the nonce moved | Every send accepted (no error). A first → R landed in 4 of 4 (n 48000002-05); R first → A landed in 4 of 4 (n 48000006-09). The other one: `UNKNOWN_TRANSACTION` in 8 of 8 |
| T3 | R signed by kf | Refused: `{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}` |
| T4 no actions | E = a tx with `actions: []`, G → G at n = 48000010, A held at n; `send_tx` E `FINAL`, then A | E lands: tx 108,059,500,000 gas + receipt 108,059,500,000 gas, **−0.000021611900000000000000 N**. A then refused: `InvalidNonce {ak_nonce: 48000010, tx_nonce: 48000010}` |
| T5 original first | A at n = 48000011 lands (`FINAL`), then R at n | R refused at once: `InvalidNonce {ak_nonce: 48000011, tx_nonce: 48000011}`; R `UNKNOWN_TRANSACTION` |

The sandbox's gas figures equal the source's: R's send = receipt creation 0.10806 + transfer 0.11512 +
`create_account` 0.5 + `add_full_access_key` 0.10177 = 0.82495 Tgas; its execution = 0.10806 + 0.11512 + 7.2 + 0.10177
= 7.52495 Tgas. The empty tx's send and execution are 0.10806 Tgas each (receipt creation only).

**Limits of this run.** It has one node, one shard and one pool. "The later insert wins" is per pool; on mainnet, A and
R can sit in different chunk producers' pools, so either one can win. The cost figures are at gas price 1e8; the
upfront figures are computed from row 9 and were not read from the sandbox.

## 4. Reproduce

```
cd proofs/b2-n14-shape && npm ci            # near-api-js 7.3.1, as proofs/b1-dao
HEAVY_REMOTE=1 scripts/heavy.sh b2-n14 -- proofs/b2-n14-shape/run.sh     # from the repo root; HEAVY_REMOTE=0 for the Mac
```
