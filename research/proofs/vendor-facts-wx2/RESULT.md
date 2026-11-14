# Vendor facts for walkaway exit v2 (lane VF): result

Read on 2026-10-23 between 05:50Z and 06:05Z (from `date -u`), public source only: `gh api .../contents/<path>?ref=<tag>`,
nothing cloned, built or run. It checks assumptions A2, A3 and A5 of `docs/drafts/walkaway-exit-v2.md` §2 (v0.1), which
P4 (§4) depends on. The pinned versions come from the papers: `cdk-mintd` 0.18.2 (06a :1629), `@cashu/cashu-ts` 4.11.0
exactly (06b :725). `docs/facts/` does not exist in this repo. All three tags exist: cdk `v0.18.2` (commit 9f6d3a37),
cashu-ts `v4.11.0` (commit 05f80b72), nearcore `2.13.4`. Mainnet runs nearcore 2.13.4 at protocol 86 (public RPC
`status` and `EXPERIMENTAL_protocol_config` on rpc.mainnet.near.org, read at 05:57:33Z). Each quote is at most
15 words.

| Fact | Verdict |
|---|---|
| A3: CDK signs Σ inputs − `total_spent` − input fee as change when the backend says Paid with `total_spent` 0 | **FAILS** |
| A5: cashu-ts derives NUT-08 blanks from the NUT-13 counter, so a restore finds their change | **HOLDS** |
| A2: one Borsh-encoded VA3 chunk (1,500,000 B) plus its path fits one tx | **HOLDS WITH CONDITION**: raw bytes only. JSON base64 does not fit |

## A3: cashu CDK v0.18.2, melt with Paid and `total_spent` below the quote amount: FAILS

Base URL: `https://github.com/cashubtc/cdk/blob/v0.18.2/`.

| # | What the code does | Quote | File#line |
|---|---|---|---|
| 1 | When the backend says Paid, the only check is on the unit, not on the amount | `Ok(pay) if pay.status == MeltQuoteState::Paid => {` / `if pay.total_spent.unit() != &quote.unit {` | `crates/cdk/src/mint/melt/melt_saga/mod.rs#L838-L839` |
| 2 | The Paid result is saved as the Finalizing handoff before finalization runs | `self.persist_paid_payment(&response).await?;` | `.../melt_saga/mod.rs#L804` |
| 3 | Every Paid path (the saga, a payment event, saga recovery, the startup check) goes through `finalize_melt_quote` → `finalize_melt_core`. That function refuses `total_spent` below the quote amount | `if quote.amount() > total_spent {` … `return Err(Error::IncorrectQuoteAmount);` | `crates/cdk/src/mint/melt/shared.rs#L717`, `#L725` |
| 4 | The check sits before the quote is set to PAID and before the proofs are set to SPENT, so neither change happens | `.update_melt_quote_state(&mut quote, MeltQuoteState::Paid, payment_proof.clone())`; `update_proofs_state(&mut tx, &mut proofs, State::Spent)` | `shared.rs#L779`, `#L813` |
| 5 | A failure after Paid never compensates | `If finalization fails, compensation is NOT executed` | `.../melt_saga/mod.rs#L1158` |
| 6 | The startup check retries on every run and fails the same way each time | `"Failed to finalize Finalizing saga {}: {}. Will retry."` | `crates/cdk/src/mint/start_up_check.rs#L669` |
| 7 | A second check, in TX2, would also fail if #3 were removed | `let payment_fee = match total_spent.checked_sub(&quote.amount()) {` | `shared.rs#L1077` (`checked_sub` underflow is an `Err`: `crates/cashu/src/amount.rs#L533-L540`) |
| 8 | The change formula itself, used once #3 and #7 pass | `.checked_sub(&total_spent)` … `.and_then(\|rem\| rem.checked_sub(&inputs_fee).ok())` | `shared.rs#L498-L501` |
| 9 | Change is split by the keyset's denominations; with too few blanks the largest are signed and the rest is lost | `change_target.split(&fee_and_amounts)?`; `"returned change may be less than the available amount"` | `shared.rs#L540`, `#L542-L549` |
| 10 | Zero change works (no signatures, the melt still finalizes), and so do zero blanks | `"melt has no change to return after payment and input fees"`; `"the wallet supplied no change outputs"` | `shared.rs#L504-L514`, `#L527-L533` |
| 11 | Change signatures are stored by blinded secret, which a NUT-09 restore later finds | `tx.add_blind_signatures(&blinded_secrets, &change_sigs, Some(quote_id.clone()))` | `shared.rs#L588` |
| 12 | Max blanks: `max_outputs`, checked on the melt (default 1000; 06a :2695 sets X17 = 64) | `if outputs_count > self.max_outputs {`; `max_outputs: 1000,` | `crates/cdk/src/mint/melt/mod.rs#L883`; `crates/cdk-mintd/src/config.rs#L1177` |
| 13 | Setup still needs inputs ≥ amount + fee reserve + input fee | `let required_total = quote` (`.amount()` + `fee_reserve` + `inputs_fee`) | `.../melt_saga/mod.rs#L346-L351` |
| 14 | Unpaid or Failed releases the inputs, which is the release P4 is meant to replace | `self.compensate_all().await?;` / `return Err(Error::PaymentFailed);` | `.../melt_saga/mod.rs#L696-L697` |

**What happens to Paid {`total_spent` = 0} on stock 0.18.2:** the melt returns `IncorrectQuoteAmount`. The quote stays
PENDING and the inputs stay PENDING. The saga stays in Finalizing, so it is never compensated, and the startup check
retries it forever. No change is signed. The notes end neither spent nor spendable, which is worse than today's
release. With `total_spent` ≥ the quote amount, the quote goes to PAID, the inputs go to SPENT and the change is
Σ inputs − `total_spent` − input fee. The holder then loses the quote amount.

**Smallest change that makes P4 work: a patch in our CDK fork** (L1c already carries the `unix_time()` patch). The
patch is two edits in `crates/cdk/src/mint/melt/shared.rs`:
1. At :717, allow exactly zero: `if total_spent.value() > 0 && quote.amount() > total_spent {`. Any 0 < x < amount is
   still refused.
2. At :1077, when `total_spent` is 0, record a payment fee of 0 and a paid amount of 0 instead of `checked_sub`.

Then #8 and #9 sign Σ inputs − input fee (input_fee_ppk 0 gives Σ inputs) onto the request's blanks. The quote goes
to PAID and the inputs to SPENT. Regression test: Paid {0} gives SPENT inputs, a PAID quote and Σ change = Σ inputs;
Paid {0 < x < amount} still gives `IncorrectQuoteAmount`.

Two conditions on P4 stay:
- The wallet must read "PAID with change = Σ inputs" as RELEASED (06b wdr.w10), because CDK reports PAID, not UNPAID.
- The keyset must hold every power of two up to the top bit of Σ inputs, so that ⌈log2 Σ⌉ + 1 blanks cover the split (#9).

There is no settle on stock 0.18.2 that returns the full value as change. Unpaid or Failed releases the inputs (#14).
Paid with `total_spent` ≥ the amount burns the amount.

## A5: cashu-ts v4.11.0, blanks from the NUT-13 counter: HOLDS

Base URL: `https://github.com/cashubtc/cashu-ts/blob/v4.11.0/`.

| # | What the code does | Quote | File#line |
|---|---|---|---|
| 1 | A wallet with a seed defaults to deterministic outputs with an auto counter | `return this._seed ? { type: 'deterministic', counter: 0 } : { type: 'random' };` | `src/wallet/Wallet.ts#L1003` |
| 2 | Melt blanks reserve counters from the same counter source as every other output | `const autoCounters = await this.addCountersToOutputTypes(keyset.id, meltOT);` | `Wallet.ts#L3583` |
| 3 | The reservation is the shared, per-keyset counter range | `const range = await this.reserveFor(keysetId, total);` … `counter: cursor` | `Wallet.ts#L892-L899` |
| 4 | Blanks are built by the same deterministic path as swap and mint outputs | `outputData = this._outputDataCreator.createDeterministicData(` (seed, counter, keyset) | `Wallet.ts#L1168-L1174` |
| 5 | Restore re-derives blanks with the same function from `start` | `createDeterministicData(0, this._seed, start, keyset, zeros)` | `Wallet.ts#L2074-L2081` |
| 6 | The derivation depends on (seed, keyset id, counter) only, not on the amount | `derive = createSecretAndBlindingFactorDeriver(seed, keyset.id);` … `derive(counter + i)` | `src/model/OutputData.ts#L341-L343` |
| 7 | The mint's restore looks signatures up by blinded secret, which covers melt change (A3 #11) | `.get_blind_signatures(&blinded_message)` | cdk `crates/cdk/src/mint/mod.rs#L1398-L1401` |

**Condition on P4's blank count** (not on the derivation): stock `prepareMelt` makes `Math.max(ceilLog2(feeReserve),
1)` blanks, where `feeReserve = sendAmount.subtract(meltQuote.amount)` (`Wallet.ts#L3554`, `#L3573`). That is fewer
than P4's ⌈log2 Σ inputs⌉ + 1. 06b :752 already has the wallet build its own n = ⌈log2 Σ⌉ + 1 NUT-13 blanks with
reserved counters. The wallet passes them as a `custom` output type, which is used as is
(`if (outputType.type === 'custom') { outputData = outputType.data;`, `Wallet.ts#L3557-L3558`). It must build them
with `createDeterministicData` on reserved counters (#4-#6), so that restore finds them. Unsigned blanks leave counter
gaps of at most 64, under the 300 gap limit (06b rst.2).

## A2: NEAR, one Borsh-encoded VA3 chunk in one tx: HOLDS WITH CONDITION (raw bytes, not JSON base64)

Source: `https://github.com/near/nearcore/blob/2.13.4/` (mainnet node 2.13.4, protocol 86; there is no `86.yaml`, so
v85's config applies). Every value was cross-checked against the live `EXPERIMENTAL_protocol_config` at 05:57:33Z.

| Item | Value | Quote | File#line |
|---|---|---|---|
| `max_transaction_size` | 1,572,864 B | `max_transaction_size: {old: 4_194_304, new: 1_572_864}` | `core/parameters/res/runtime_configs/69.yaml#L3` |
| Where it is enforced | serialized signed tx | `if tx_size > max_tx_size {` | `core/primitives/src/transaction.rs#L331-L334` |
| `max_arguments_length` | 4,194,304 B | `max_arguments_length: 4_194_304` | `.../parameters.yaml#L265`; enforced `runtime/runtime/src/action_validation.rs#L272` |
| Function-call bytes | send_sir 2,235,934; send_not_sir 47,683,715; exec 2,235,934 gas/B | `send_not_sir: 47_683_715,` | `69.yaml#L34-L45` (L42) |
| Function-call base | send 200 Ggas, exec 780 Ggas | `execution: 780_000_000_000` | `66.yaml#L9-L13` |
| `sha256` | base 4,540,970,250; per byte 24,117,351 | `wasm_sha256_byte: 24_117_351` | `parameters.yaml#L174-L175`; charged `runtime/near-vm-runner/src/logic/logic.rs#L1589-L1592` |
| Bytes into and out of registers and memory | write_register 3,801,564; read_register 98,562; write_memory 2,723,772; read_memory 3,801,333 gas/B | `wasm_write_register_byte: 3_801_564` | `parameters.yaml#L163-L169`; `input()` `logic.rs#L826`, `read_register` `#L449` |
| Gas caps | `max_gas_burnt` and `max_total_prepaid_gas` 1 Pgas | `max_total_prepaid_gas: { old: 300_000_000_000_000, new: 1_000_000_000_000_000 }` | `83.yaml#L7-L9` |

**Fit (Borsh).** The args are `seq` u64, `chunk_index` u32, `bytes` (4 + 1,500,000) and `path` (4 + 32 × ⌈log2 n⌉,
at most 1,028 B even at n = 2^32), so ≤ 1,501,048 B. The signed tx adds about 300-400 B (two account ids, key, nonce,
block hash, method name, gas, deposit, signature). That totals ≈ 1,501,450 B, against 1,572,864 B, leaving
≈ 71,400 B spare. **HOLDS.**

**JSON base64 breaks the fit.** The chunk alone becomes 4 × ⌈1,500,000 / 3⌉ = 2,000,000 B, over 1,572,864 B. The
largest raw chunk under JSON base64 is about 1,178,000 B. So VA3, VA9 and VA14 must take raw Borsh args, as 06a :981
already says.

**Gas estimate** (fees × bytes, L = 1,501,048, chunk 1,500,000):

| Part | Tgas |
|---|---|
| `input()` into the register | 5.71 |
| `read_register` into wasm memory | 4.24 |
| `sha256` over 1.5 MB (read_memory 5.70 + hash 36.18 + bases) | 41.89 |
| 32 path hashes of 64 B | 0.39 |
| Host calls in total | ≈ 52.2 |
| Wasm's own Borsh copy | a few, ASSUMED |
| Contract execution in total | ≈ 55-60 |
| Action exec (per byte 3.36 + base 0.78) | ≈ 4.1 |
| Send, when the signer is not the vault (per byte 71.58 + base 0.2) | ≈ 71.8 |
| Send, when the signer is the vault (send_sir) | ≈ 3.6 |
| **Total for one stranger's chunk** | **≈ 131-136** |

That is ≈ 0.013 N at 10^8 yocto/gas, under the 1 Pgas cap (and under the old 300 Tgas). This matches 06a :983-987.
L4 still measures it.

## Effect on the draft

- **A3 fails as written.** Without the two-line fork patch (and its regression test), P4's "settle as change" leaves
  every WAIT melt PENDING forever. Add the patch to L1c's CDK change path, as A3's own fallback says.
- **A5 holds.** P4's blank count needs the wallet's own `blanks(n)` (06b :752) and not the stock `prepareMelt` count.
- **A2 holds** for raw Borsh args only.
