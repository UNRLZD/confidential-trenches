# P1 Private balance: result

**Pass line** (plan §8): authenticate a private account; deposit; private swap USDC→SOL and one EXACT_OUTPUT private swap;
private transfer to a second private account (the per-trade settlement); out to a fresh Solana address, a fresh Base
address and a NEAR account, and back in from Solana; every tx checked on RPC; the **real** latency of each leg recorded.

**Coordinator changes 2026-10-20 (design D1: ghosts pre-funded by Intents withdrawals):** (1) **P1b**: for every
out-leg the live run records the arrival tx and who an outside observer sees as sender and fee payer, plus how busy
that sender is. (2) The Solana out-leg delivers **≥ 0.1 SOL after fees** to the **P4 Solana float**
`GLWAiWU726MQPCFGwZjFFGT2qADL39Wj2LJh6sSyBt6u` by default. The settlement-transfer legs stay, labelled
**old design (D0), for the record**.

**Owner decision 2026-10-20: the hackathon is kept fully apart from UNRLZD.** Secrets come only from
`~/.confidential-trenches/env`, the funder is the hackathon's own NEAR account, and new keys go to
`~/.confidential-trenches/keys/`.

**LIVE: PASS (2026-10-19 22:53-22:58Z, owner's paste).** All 15 legs SUCCESS; every chain tx re-checked on a second
provider by the coordinator. Real latencies: deposit 31.9 s to visible; private swap 11.5 s; private transfer (D0)
median 2.8 s; out to Solana/Base/NEAR 21-24 s; back in from Solana 41.8 s. 1Click paid a never-used NEAR implicit
account. See "Live numbers".

## Run it

```sh
# 1. Put the 1Click partner key in ~/.confidential-trenches/env as ONECLICK_API_KEY=<key> (file chmod 600).
# 2. Fund the hackathon funder with at least 15.05 NEAR (15 deposit + 0.05 gas reserve; holds 0 now, no account yet):
#    951a5eab7965eb95c3aae56d5da9535c21b9fa70da1105b93f4bc220703bfb33
# 3. The live run (owner, one paste). Solana goes to the P4 float by default; P4's Base/NEAR floats are appended as
#    --to-base <addr> --to-near <account> once the other P4 agent has them:
sh ~/Downloads/confidential-trenches/proofs/p1-private-balance/live.sh
```

- Secrets: `run.mjs` reads `ONECLICK_API_KEY` itself from `~/.confidential-trenches/env` (`--secrets`), keeps it in
  memory and never prints it. Funder key: `~/.confidential-trenches/keys/funder-near.json` (`--funder-key`, near-cli
  shape), loaded only in `--live`.
- `--dry` (default of `run.mjs`): auth, balances, funding check, a dry quote for every leg, and for every private leg a
  real quote + `generate-intent` whose payload is checked but **not signed**. Nothing that moves value is signed or sent.
- `--live`: runs the legs in order, stops at the first leg that does not reach SUCCESS + visible, `--from <leg>` resumes.
  Before signing anything 1Click returns, it checks the quote echo (assets, amount, recipient, refund) and the intent
  payload (signer, `intents.far`, only `transfer`s of the origin asset to this quote's deposit address, total ≤
  `amountIn`), and refuses a quote that loses more than 1% (transfers), 3% (swaps, deposit) or 6% (withdrawals).
  Stops if quoted fees pass `--max-fees-usd` (15).
- Recipients: `--to-solana` (default: the P4 Solana float `GLWAiWU7…Bt6u`, a fresh address with no account yet; the
  0.1 SOL arrival creates it), `--to-base`, `--to-near` (default: the script's own fresh keys `p1-base.json`,
  `p1-near.json` near-cli format, until P4's floats exist). The back-in leg signs with `--solana-key` (default
  `p1-solana.json`, solana-keygen format); because `--to-solana` is not that key, the leg `out-sol-own` first sends it
  $5 of the user's SOL for the back-in.
- **Key files.** The P1 keys made 2026-10-19 stay where they are, in
  `~/Downloads/confidential-trenches/.keys/` (gitignored, 600): `p1-user.json`, `p1-app.json`, `p1-solana.json`
  (`BuxPd9HL…pb5L`), `p1-base.json` (`0x7de7…53e8`), `p1-near.json` (`f5ff216d…afb0`). The script uses a key file
  there if it exists; any key it has to make is created in `~/.confidential-trenches/keys/`.
- `node observe.mjs <solana|base|near> <arrival tx> <recipient>` repeats the P1b observer read for any arrival.
- Run record: `runs/<time>-<mode>.json` (quotes, intents, tx hashes, timings, the whole log; no tokens or keys).

## Design choices

- **Private accounts sign with `raw_ed25519`** (fresh ed25519 key each: `user` 6c78e373…f293, `app` 2d39fe24…1a70;
  keys in `~/Downloads/confidential-trenches/.keys/p1-{user,app}.json`, 600). The Intents account id is the hex of the public key, and no on-chain
  step is needed. `nep413` would first need `add_public_key` on `intents.near` for a named account
  ([auth docs](https://docs.near-intents.org/api-reference/user-auth/authenticate-user-with-signed-data.md)): one more
  tx, and a **public** one linking the key to the account. An enclave holding one ed25519 key per user signs the
  payload's UTF-8 bytes directly, with no NEP-413 wrapper. Side effect (inference, UNVERIFIED): the key is a valid
  Solana key, and near.com signs Solana wallets in as the same hex id, so a user could exit through near.com with it.
- **Deposit = native NEAR → private USDC** in one 1Click `ORIGIN_CHAIN` quote: one plain `Transfer` to the 64-hex
  deposit address. 1Click credits native NEAR for `nep141:wrap.near` (UNRLZD facts H66, two real swaps on chain).
- **Old design (D0), for the record: settlement measured 7 times**, alternating user→app (after a buy) and app→user
  (after a sell), $3 of SOL each.
- **The app's SOL goes out to the P4 Solana float** (the D1 pre-funding shape). The EXACT_OUTPUT leg is sized so the app
  holds exactly **0.1025 SOL** after the odd number of settles (`OUT_SOL_HOLD` minus one settle). After the 0.0000957
  SOL withdraw fee and the quote's 1% min-out that is ≥ 0.1 SOL, and `--live` **refuses to sign `out-sol` if the
  quote's `minAmountOut` is below 0.1 SOL** (`OUT_SOL_MIN`). Out to NEAR is last, so a refund there blocks nothing.
- Chain txs are built by hand (`lib.mjs`, no SDKs): `xcheck.mjs` shows the NEAR `Transfer` and the Solana transfer are
  **byte-identical, signature included**, to near-js 2.5.1 and @solana/web3.js 1.98.4 (20 random cases each). The
  Base address derivation matches viem 2.56.0 `privateKeyToAccount`. `mocklive.mjs` runs the whole `--live` path
  against an in-memory mock that checks every signature (13 intents, 1 NEAR tx, 1 Solana tx): 15/15 legs pass, and
  the P1b observer lines are filled for all four out-legs.

## What --dry showed (2026-10-19 21:49Z, run record `runs/2026-10-19T21-49-01-314Z-dry.json`)

Prices (1Click `/v0/tokens`): NEAR $4.92, SOL $104.68, ETH $2,401.58. Partner key = `ONECLICK_API_KEY` (Bearer).

| Leg | In | Expected out (min) | Quoted cost | `timeEstimate` | Quote |
|---|---|---|---|---|---|
| deposit: funder NEAR → user private USDC | 15 NEAR ($73.80) | 73.18 USDC (72.45) | $0.62 (0.85%) | 22 s | 713 ms |
| swap: user USDC → user SOL | 20 USDC | 0.19069 SOL (0.18879) | $0.04 (0.20%) | 12 s | 777 ms |
| swap-exact-out: user USDC → app exactly 0.073841 SOL | ≤ 7.8228 USDC | 0.073841 SOL | $0.09 incl. the 1% buffer, refunded | 12 s | 738 ms |
| settle-1…7 (old design D0, for the record): user ⇄ app, 0.028659 SOL | $3.00 | 0.028659 SOL (0.028372) | **$0.000** | **10 s** | 390-437 ms |
| out-sol: app SOL (all) → P4 Solana float | 0.1025 SOL ($10.73) | **0.102404 SOL (min 0.10138 ≥ 0.1: ok)** | $0.01 (withdrawFee 0.0000957 SOL) | 7 s | 408 ms |
| out-sol-own: user SOL → script-held Solana key | 0.047765 SOL | 0.047669 SOL | $0.01 (withdrawFee 0.0000957 SOL) | 7 s | 431 ms |
| out-base: user USDC → ETH on Base | 12 USDC | 0.0049853 ETH | $0.03 (withdrawFee 1e-6 ETH) | 14 s | 832 ms |
| in-sol: Solana → user private SOL | ~0.04681 SOL | same | $0.000 | 20 s | 423 ms |
| out-near: user USDC → NEAR, fresh implicit account | 10 USDC | 2.0388 NEAR | $0.00 | 12 s | 700 ms |

- **Total quoted cost ≈ $0.8** plus gas (< 0.001 NEAR, 5,000 lamports). The deposit stays **15 NEAR (+0.05 gas)**,
  within the ~16 NEAR cap. USDC use: 20 + 7.82 + 12 + 10 = $49.8 of $73.2. Out of ~$74 moved: 0.1 SOL (~$10.7) to the
  P4 float, ~$12 ETH on Base, ~$10 NEAR on NEAR, and ~$23 USDC + ~0.16 SOL stay in the user's private balance
  (keys in `.keys/`).
- The deposit spread moved between 0.41% and 1.07% over five dry runs (NEAR→USDC). Same-asset moves quote zero cost.
- **Auth** (`raw_ed25519`, empty intent, `verifying_contract: intents.near`): OK in 0.45-1.56 s for both accounts with
  `intents.near`'s live salt `252812b3`. Access token **900 s** (docs say 3600), refresh **604,800 s = 7 d** (docs
  say 30 d). Claims: `account_id, iss, sub, exp, iat, jti`. The script signs in again after 600 s.
- **The intent we would sign** (real `generate-intent`, all 13 private legs, 383-478 ms each, after a 570-1,109 ms
  non-dry quote; all 13 pass `checkIntent`):
  `{"verifying_contract":"intents.far","signer_id":"<hex>","deadline":"<now+72 h>","nonce":"<versioned, salt e110f317>","intents":[{"intent":"transfer","receiver_id":"<deposit address>","tokens":{"imt:51e8f94d…7cbe:nep141:<asset>":"<amountIn>"}}]}`.
  So a confidential intent is one `transfer` of an IMT token on `intents.far`, nonce salt `e110f317` (FAR's; the docs
  call it "production salt"), deadline 72 h. EXACT_OUTPUT moves `amountIn`, which includes the slippage buffer.
- Balances: `/v0/account/balances` answers `{"balances":[]}` for zero balances. History: **403 "History is invite-only
  for now" even with a valid user token**. Public `intents.near` balance of the user id: `["0","0"]`.
- Funding: the hackathon funder `951a5eab…fb33` (account id = hex of its public key, checked) holds **0 NEAR (no
  account yet): short by 15.05 NEAR (~$74)**, read 2026-10-19 21:54Z.

## How each leg is timed and checked (for --live)

t0 is taken right before the value-moving call. "Visible" means the receiver can see, and so spend, the funds. Polls run
every 1 s (1Click) or every 1.5 s (chain RPCs), so a time is late by at most one interval.

| Leg | t0 | Visible = | Independent check |
|---|---|---|---|
| deposit | NEAR `send_tx` sent | user's private USDC ≥ before + minAmountOut (1Click balances) | our NEAR tx, `tx` FINAL on NEAR RPC (FastNEAR free → dRPC → near.org → archival) |
| swap, exact-out, settle-1…7 | `POST /v0/submit-intent` | receiver's private balance ≥ before + minAmountOut (exact-out: + amountOut) | **none possible**: FAR has no public RPC. Only 1Click shows FAR balances. Chained legs spend what earlier legs delivered |
| out-sol / out-base / out-near | `POST /v0/submit-intent` | recipient's chain balance (Solana `confirmed`, Base `latest`, NEAR `final` native + wNEAR) ≥ before + minAmountOut | 1Click's `destinationChainTxHashes` on that chain's RPC (receipt status, Solana delta, NEAR signer looked up via FastNEAR's tx index) |
| in-sol | first `sendTransaction` | user's private SOL ≥ before + minAmountOut | our Solana tx, `getTransaction` (delta to the deposit address) |

Also recorded per leg: quote, generate-intent and submit-ack times, the first time each 1Click status was seen, and
the 1Click `nearTxHashes` with whether each exists on **public** mainnet (FastNEAR tx index). That shows each leg's
public footprint. At the end, the user id's public `intents.near` balance must still be 0.

## P1b: what an outside observer sees of each arrival

For every out-leg (`out-sol`, `out-sol-own`, `out-base`, `out-near`) `--live` reads each of 1Click's
`destinationChainTxHashes` from the chain's own RPC (`observeArrival` in `rpc.mjs`) and records:

| Chain | Sender (whose balance pays the recipient) | Fee payer | Sender activity, last hour (one cheap read) |
|---|---|---|---|
| Solana | the account, other than the recipient, with the largest lamport drop (fee added back for the payer) | account key 0 (+ all signers, programs) | `getSignaturesForAddress(sender, 1000)` within 1 h; plus distinct other payees in the 15 newest payouts (largest gain per tx) |
| Base | `from` if the tx sends ETH straight to the recipient, else the called contract | `from` | the fee payer's nonce now minus at head − 1,800 blocks (~1 h at 2 s): txs it signed |
| NEAR | `predecessor_id` of the receipt that `Transfer`s to the recipient (or `ft_transfer`s to it) | the tx `signer_id` | FastNEAR tx index, one 200-tx page: txs in which the sender emits receipts; a lower bound when the page covers < 1 h |

**Measured on real 1Click deliveries** (read 2026-10-19 21:40-21:50Z with the same code, `node observe.mjs`):

- **Solana** `5UCN1JEk…eqW4Q` (UNRLZD round trip 2026-10-03, 0.023447896 SOL to `HXa3Pc6v…9pzx`): sender
  **`6tckHFBpiJ8YgYN8FUskvtvTpXQZ55g5LHeo1kvELoDQ`** (system-owned, holds 23,142 SOL, paid exactly the amount
  received), fee payer and only signer `DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn`, program
  `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` (log: `Instruction: FinalizeTransferSol`; the Wormhole core program
  `worm2Zo…` is in the account list). That this is the Omni bridge's shared SOL vault is the coordinator's label and
  fits the log; it is **not verified** from a registry. The sender made **272 txs in the last hour**; its 15 newest
  payouts went to **5 other payees**.
- **Base** `0x05aaf11b…3f28` (same round trip, +0.000438 ETH): a plain ETH transfer (no calldata) from the EOA
  **`0x2cff890f0378a11913b6129b2e97417a2c302680`**, which is sender and fee payer. It signed **127 txs in the last hour**.
- **NEAR** `HzCom2oy…6SDyc` (UNRLZD fixture, 1Click delivery of native NEAR): the tx is signed by **`intents.near`**
  itself (signer = receiver = `intents.near`), wrap.near unwraps to it, and the `Transfer` to the recipient has
  predecessor `intents.near`, so sender = fee payer = `intents.near`. One index page (200 txs) covers 4.6 min, with 88
  txs where `intents.near` emits receipts: **≥ 88 in the last hour** (lower bound; `txs_count` 36.9 M).

So on all three chains an observer sees a shared payer that pays many others, not the user's private account. Not
measured yet: whether the Solana vault and Base EOA are the same for every 1Click withdrawal, and whether the fee
payers rotate. The live run's four rows add that.

## Live numbers (run record `runs/2026-10-19T22-53-44-913Z-live.json`, 2026-10-19 22:53:44-22:58:34Z, 294 s)

Every chain tx (19: the funder's deposit, 1Click's 14 public NEAR txs, 3 Solana and 1 Base arrival, the Solana
back-in) re-checked by the coordinator on providers the run did not use (`node recheck.mjs <record>`: NEAR on
rpc.mainnet.near.org, Solana on publicnode, Base on Tenderly's gateway): all FINAL / finalized / status 1, 0 failed
receipts, every Solana credit equal to the recorded amount.

| Leg | Final | quote s | submit → ack s | → status SUCCESS s | → visible s | eta s | Fee $ | Tx checked on RPC | Public mainnet txs |
|---|---|---|---|---|---|---|---|---|---|
| deposit | SUCCESS | 0.9 | (chain incl. 3.0) | 36.6 | 31.9 | 22 | 0.352 | `HzXdX4nnTa…` | 2 |
| swap | SUCCESS | 0.8 | 0.5 | 15.0 | 11.5 | 12 | 0.056 | private | 0 |
| swap-exact-out | SUCCESS | 1.0 | 0.5 | 14.9 | 11.1 | 12 | 0.101 | private | 0 |
| settle-1 (D0, for the record) | SUCCESS | 0.7 | 0.5 | 3.7 | 2.5 | 10 | 0.000 | private | 0 |
| settle-2 (D0) | SUCCESS | 0.6 | 0.5 | 3.7 | 2.8 | 10 | 0.000 | private | 0 |
| settle-3 (D0) | SUCCESS | 0.6 | 0.5 | 3.7 | 2.8 | 10 | 0.000 | private | 0 |
| settle-4 (D0) | SUCCESS | 0.6 | 0.5 | 3.7 | 2.7 | 10 | 0.000 | private | 0 |
| settle-5 (D0) | SUCCESS | 0.6 | 0.5 | 3.7 | 2.6 | 10 | 0.000 | private | 0 |
| settle-6 (D0) | SUCCESS | 0.6 | 0.4 | 3.7 | 4.0 | 10 | 0.000 | private | 0 |
| settle-7 (D0) | SUCCESS | 0.6 | 0.5 | 3.8 | 3.6 | 10 | 0.000 | private | 0 |
| out-sol (P4 float, ≥ 0.1 SOL) | SUCCESS | 0.8 | 0.5 | 21.2 | 21.1 | 7 | 0.010 | `2c48hnCtQ5…` | 2 |
| out-sol-own | SUCCESS | 0.9 | 0.4 | 23.3 | 22.6 | 7 | 0.010 | `4hubwZPvft…` | 2 |
| out-base | SUCCESS | 1.0 | 0.5 | 25.2 | 21.2 | 14 | 0.033 | `0x37a15d42…` | 2 |
| in-sol | SUCCESS | 0.6 | (chain incl. 2.8) | 42.5 | 41.8 | 20 | 0.000 | `3ZDDh9uCso…` | 2 |
| out-near | SUCCESS | 0.9 | 0.5 | 22.3 | 24.3 | 12 | 0.000 | `HdKgkMzeMg…` | 2 |

P1b, per arrival (from the `observer` field of each out-leg):

| Leg | Arrival tx | Delivered | Sender | Fee payer | Sender txs, last hour | Other payees (Solana sample) |
|---|---|---|---|---|---|---|
| out-sol | `2c48hnCtQ5QV…` | 0.102404650 SOL (= quote) | `6tckHFBpiJ…` | `DuSs7rCr7o…` | 269 | 3 in 15 |
| out-sol-own | `4hubwZPvftt6…` | 0.047496650 SOL (= quote) | `6tckHFBpiJ…` | `DuSs7rCr7o…` | 268 | 3 in 15 |
| out-base | `0x37a15d422f…` | 0.004974739 ETH (quote 0.004975290, −0.011%, above min) | `0x2cff890f…` | `0x2cff890f…` | 109 (fee payer; an EOA, direct transfer) | - |
| out-near | `HdKgkMzeMgkA…` | 2.025996859 N (quote 2.026333599, −0.017%, above min) | `intents.near` (native Transfer) | `intents.near` | >= 105 (one 200-tx page covers 5.0 min) | - |

Old design (D0), for the record: settlement (n = 7, submit → visible to the receiver): min 2.5 s, median 2.8 s, max 4.0 s.

After the run: user private balance 23.891116 USDC + 0.161149 SOL, app private balance 0; the user account's public
`intents.near` balance 0 (both assets). Keys for both private accounts: `<repo>/.keys/p1-user.json`, `p1-app.json`.

Cost: 1Click fees $0.563 over 15 legs (deposit $0.352 of it, the NEAR→USDC spread), plus one Solana fee (5,000
lamports). The 1Click deposit-submit endpoint answered HTTP 500 on both deposits (deposit, in-sol), yet both completed:
status polling is the source of truth, never the submit's HTTP code.

### Answers to the open questions below (from this run)

1. P1b: both Solana arrivals came from the same sender `6tckHFBp…` with the same fee payer `DuSs7rCr…` (269 txs in the
   last hour, 3 other payees in a 15-tx sample). Base came from an EOA `0x2cff89…` (109 txs/hour). NEAR came from
   `intents.near` itself. Rotation is not seen in 2 arrivals; one run cannot show it.
2. D0 settlement: median 2.8 s (estimate was 10 s), spread 2.5-4.0 s.
3. No fixed order. Cross-chain legs: funds visible 4-5 s before SUCCESS on deposit and out-base, within 1 s on out-sol,
   out-sol-own and in-sol, and 2 s **after** SUCCESS on out-near. Private legs: visible 0.7-3.5 s before SUCCESS
   (balances polled every 1 s, so ±1 s). The ledger counts a leg done only when it has both: the balance change and
   SUCCESS.
4. Same-asset deliveries (SOL out) equal the quote exactly; nothing is taken outside it. Cross-asset deliveries land
   within 0.02% below `amountOut` and above `minAmountOut`.
5. **Yes:** 1Click paid a never-used NEAR implicit account. `f5ff216d…`'s first receipt ever is the delivery
   `HdKgkMze…` (block 220,720,678, native Transfer from `intents.near`), which created it.
6. 1Click lists 2 public NEAR txs per cross-chain leg (deposit wrap/bridge + `intents.near` execution) and none for
   private-to-private legs.

## Open questions

1. **P1b**: is the Solana sender always the same vault and the Base sender always the same EOA, and do the fee payers
   rotate? Two live arrivals per chain (out-sol, out-sol-own on Solana) start the answer.
2. Old design (D0), for the record: real settlement latency vs the 10 s estimate, and its spread.
3. Do funds show in the receiver's balance before, at, or after 1Click's status says SUCCESS? This decides what the
   enclave ledger waits on.
4. The Confidential Infrastructure Fee: same-asset transfers quote $0.000, but the Terms say the fee is "deducted at the
   settlement level". Received vs quoted amounts in the live run will show whether anything is taken outside the quote.
5. Can 1Click pay a **fresh, not yet existing** NEAR implicit account? The dry quote passes. Deliveries arrive as native
   NEAR (facts H14), which would create the account. If it refunds, the money returns to the user's private balance;
   rerun with `--to-near <existing account> --from out-near`.
6. Which `nearTxHashes` does 1Click list for private legs, and are any on public mainnet?
7. A signed intent stays valid **72 h**. The ledger must hold a pending debit until SUCCESS, REFUNDED or the deadline,
   never just until a timeout. EXACT_OUTPUT moves `amountIn` (with the buffer), so reserve that, not `minAmountIn`.
8. 1Click rate limits for 1 s polling: not published (research C41). The run polls status and balances at 1 s.

## Risks

- Confidential access is "invite-only" and revocable (research C13). If it is revoked mid-run, funds stay in the
  private accounts, whose keys we hold. Exit would then go through near.com with the same key (UNVERIFIED, see above).
- If P4 trades from the float addresses during this run, the "visible" check (a balance increase) can miss. Run P1
  before P4 starts trading.
- The NEAR→USDC deposit spread moved up to 1.07% in dry runs. The guard stops at 3%.
- Amounts are quoted at run time from 1Click prices. The leg sizes are constants in `run.mjs` (`SIZE`, and
  `OUT_SOL_HOLD` / `OUT_SOL_MIN` in lamports for the Solana out-leg).

## Sources (all read or called 2026-10-19 20:55-21:50Z)

- Docs (fetched as `.md`): [signed-intent-execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution.md)
  (generate/submit use partner auth; standards list), [authenticate-user-with-signed-data](https://docs.near-intents.org/api-reference/user-auth/authenticate-user-with-signed-data.md)
  (raw_ed25519 signer id = hex of the address bytes, `public_key` = `ed25519:`+base58; nep413 needs `add_public_key`;
  versioned nonce; ±5 min), [get-user-token-balances](https://docs.near-intents.org/api-reference/account/get-user-token-balances.md),
  [making-a-request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md)
  (status values, `/v0/deposit/submit`), [confidential-swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps.md).
- 1Click OpenAPI 0.1.10, `https://1click.chaindefuser.com/docs/v0/openapi.yaml`: `QuoteRequest` (EXACT_OUTPUT
  semantics, `CONFIDENTIAL_INTENTS` types), `Quote` (`withdrawFee`, `timeEstimate`), `SwapDetails`
  (`nearTxHashes`, `destinationChainTxHashes`), `IntentStandardEnum`, `SubmitDepositTxRequest.nearSenderAccount`.
- `@defuse-protocol/intents-sdk` 0.90.0 (npm tarball) `dist/src/intents/expirable-nonce.js`: the nonce layout
  (magic `5628f6c6`, version 0, salt, deadline ns, 15 bytes starting with the start time ns).
- UNRLZD `docs/facts/external-facts.md` H14 (wNEAR deliveries arrive as native NEAR), H66 (native NEAR to a 1Click NEAR
  deposit address is credited), H38 (a non-existent named NEAR recipient fails at quote time).
- Live calls (5 dry runs + 1 read with a user token): `POST /v0/auth/authenticate` ×11 (raw_ed25519, all 200);
  `GET /v0/account/balances` (200, empty list); `GET /v0/account/history` (403); `POST /v0/quote` dry ×63 and
  non-dry ×45; `POST /v0/generate-intent` ×45 (none signed); `intents.near` `current_salt` = `252812b3`, `mt_batch_balance_of`; NEAR `view_account` of the canaries;
  Solana `simulateTransaction` of the hand-built transfer (`AccountNotFound` = parsed, signature ok);
  `getTransaction` needs `maxSupportedTransactionVersion: 1` (solana-core 4.3.0 serves version-1 txs);
  `tx.main.fastnear.com/v0/transactions` leaves out unknown hashes.
- P1b reads (21:40-21:50Z): Solana `getTransaction` + `getSignaturesForAddress` + `getAccountInfo` (sender
  `6tckHF…` system-owned, 23,142 SOL; P4 float `GLWAiWU7…` no account); Base `eth_getTransactionByHash`, `eth_getCode`,
  `eth_getTransactionCount` at `latest` and head − 1,800 (mainnet.base.org serves both); NEAR `EXPERIMENTAL_tx_status`
  (archival) + `tx.main.fastnear.com/v0/account` (200 txs per page, `tx_block_timestamp` in ns). Delivery txs from
  UNRLZD `docs/qa/2026-10-03/round-trips.md` rows 3 and 8 and `services/engine/test/fixtures/intents/tx-native-delivery-100usdg.json`.
