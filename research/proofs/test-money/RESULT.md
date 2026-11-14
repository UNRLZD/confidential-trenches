# Test money: the lanes' mainnet dev wallets (card test-wallets-funding)

Status 2026-11-02 09:37Z (M4's $8 principal folded in at 09:13Z; the AI review of e0d5832 folded in at 09:36Z): wallets made, `fund.sh --dry` and `sweep.sh --dry` ran with real quotes on every leg; nothing
signed or sent. The owner's paste funds all nine funded wallets once the funder is topped up.

## The wallets and what each holds

Amounts are markets.md §2.6 (docs/plan1/markets.md l.2731-2779, made by test-money.py, §6.6 l.3200-3277), split per
wallet by `scripts/testmoney/plan.mjs`. Every wallet holds one native coin, both its trade asset and its gas: SOL
(P4 Solana trades SOL to token, proofs/p4-speed/solana/RESULT.md:96-99), ETH on Base (proofs/p4-speed/base/RESULT.md:72-74),
ETH on Robinhood (proofs/p4-speed/hood/RESULT.md:47-52) and NEAR (P4 NEAR self mode wraps the ghost's own NEAR in the
buy, proofs/p4-speed/near/RESULT.md:35-43). Keys: Keychain `ct-testmoney-<chain>` / `<lane>` (scripts/testmoney/README.md).

| Lane | Chain | Address | Amount | Split (dollars of that coin) |
|---|---|---|---|---|
| M1 | Solana | `Gq6LQoSrhAfvsM8kaofDz6EPpCd5TWs832unfPWD5qLd` | $34.04 | principal 20.00 + price loss 8.45 + gas 0.78 + rug 2.00 + margin 2.8075 |
| M2 | Base | `0xE697BcC880061f491f28a3846B281eE0436eD88b` | $26.59 | principal 15.00 + price loss 4.68 + gas 2.07 + hop fees 0.525 + rug 2.00 + margin 2.31875 |
| M2 | Robinhood | `0xA810bDaC38cF78AcB729C7ED4569B1048AB5252a` | $26.10 | principal 15.00 + price loss 4.30 + gas 2.05 + hop fees 0.525 + rug 2.00 + margin 2.21875 (26.09375, takes the lane's last cent) |
| M2 | Solana | `DXqyhDyM9qpwWRKuo3twFgqtLDL9zeezhuuvuovu8acu` | $0.00 | the third end of the hop routes; receives SOL from the lane's own hops |
| M3 | NEAR | `bfc40e40f2b22e0c01474869c074099c7ebd8c4dd2720a1db9ee78a001051aa0` | $27.17 | principal 15.00 + price loss 0.90 + gas 6.84 + rug 2.00 + margin 2.435 (27.175; §2.6 prints 12.17 for the spend) |
| M4 | Solana | `HYiSs3WoZCpEMbq3Z3H9XFpj3tkeyzfMpp2EtTf9NceR` | $2.89 | principal 2.00 (named change) + 10 order fires: price loss 0.65 + gas 0.06 + margin 0.1775 |
| M4 | Base | `0x0259E4Db481948a15E6C5DFee74aaE4502Ec757C` | $2.94 | principal 2.00 (named change) + 10 order fires: price loss 0.52 + gas 0.23 + margin 0.1875 |
| M4 | Robinhood | `0x80D29705e99e86f54a2f86bcdb1adD8Dd5FFe0c4` | $3.59 | principal 2.00 (named change) + 10 order fires: price loss 0.86 + gas 0.41 + margin 0.3175 |
| M4 | NEAR | `cd0131eb31b337000d1abf8fbc8b9171fc17576bad6717ed3a0cc14987d3d6ce` | $3.07 | principal 2.00 (named change) + 10 order fires: price loss 0.10 + gas 0.76 + margin 0.215 (3.075, takes the lane's last cent) |
| M5 | Solana | `4nqkKeovDXJ2oLd8A5XQqFzw4iG4kqKvBWzHGtULcJ8k` | $5.89 | principal 5.00 + price loss 0.65 + gas 0.06 + margin 0.1775 |
| | | | **$132.28** | §2.6's $124.28 + M4's $8: lanes 34.04 + 52.69 + 27.17 + 12.49 + 5.89; $78 principal comes back on the sweep |

**Named change on §2.6: principal M4 $8** (the team lead's call, received 2026-11-02 by 09:13Z, on this card). §2.6 gives M4 $0 principal, which left each
M4 wallet at $0.89-1.59, below the $2 a test order fire trades: a $2 order fire needs a $2 position. So each of
M4's four wallets (Solana, Base, Robinhood, NEAR) holds $2 more, swept back like every principal. It is one line
in `plan.mjs` (`CHANGES`, with this reason); `split()` compares each lane to §2.6 plus its named changes, with the
same half-cent rule, so dropping the change or a wallet's $2 is refused (tests). The team lead updates markets.md §2.6.

How the split is made (test-money.py's model, ported to integer micro-dollars):

- Round trip at $2 = fixed + share x $2: Solana 0.006 + 0.065 = 0.071; Base 0.023 + 0.052 = 0.075; Robinhood
  0.041 + 0.086 = 0.127; NEAR 0.076 + 0.010 = 0.086 (§2.6 cost table). "gas" above is the fixed part x round trips,
  "price loss" the share part.
- M2 (§2.6 rows: Base 50 + 40, Robinhood 30 + 20, hops 30 x 0.024, fallback legs 10 x 0.033, rug x2): Base pays its
  90 round trips, Robinhood its 50; the hops and fallback legs (0.72 + 0.33 = 1.05) are paid by the wallet a hop
  leaves from, half each (0.525); one rug on each fresh-token chain (§2.6: "one whole $2 trade per fresh-token chain
  lane"); the $30 principal is $15 each. Base (6.75 + 0.525 + 2.00) x 1.25 = 11.59375; Robinhood (6.35 + 0.525 +
  2.00) x 1.25 = 11.09375; sum 22.6875 = §2.6's 22.69.
- M4 ("order fires on 4 chains, 10 each", 40 x the four chains' mean 0.08975 = 3.59): 10 round trips per chain at
  its own unit: 0.71 + 0.75 + 1.27 + 0.86 = 3.59, the same sum; x 1.25 = 0.8875 + 0.9375 + 1.5875 + 1.075 = 4.4875 =
  §2.6's 4.49.
- Rounding: each wallet half up to the cent; the lane's last funded wallet takes the lane's §2.6 total less the
  others, so each lane is §2.6's printed figure (plus its named change) to the cent. `split()` refuses when a lane's exact figure is more
  than half a cent from §2.6 (M3's exact 27.175 against 27.17 is within; §2.6's 12.17 is Python's float format of
  12.175).

## The legs (scripts/testmoney/fund.mjs)

| To | Route | Why |
|---|---|---|
| Solana wallets | 1Click: `nep141:wrap.near` (native NEAR sent to the 64-hex deposit address, ORIGIN_CHAIN) -> `nep141:sol.omft.near`, recipient the wallet (DESTINATION_CHAIN), refund to the funder | g1-money-loop's near-to-sol leg, as it is |
| Base wallets | the same, -> `nep141:base.omft.near` | |
| Robinhood wallets | the same, -> `nep141:hood.omft.near` | Robinhood is on 1Click's own list: `GET https://1click.chaindefuser.com/v0/tokens` 2026-11-02T08:55Z: `{"assetId":"nep141:hood.omft.near","decimals":18,"blockchain":"hood","symbol":"ETH"}` (and P4 hood RESULT.md:84 quoted this route on 2026-10-20). No leg uses Relay |
| NEAR wallets | one native Transfer from the funder to the wallet's implicit id | NEAR to NEAR needs no swap; the Transfer creates the implicit account. A deviation from "over 1Click", for this reason |

Every 1Click leg uses g1-money-loop's checks as they are: `oneclick.mjs checkQuote` (the signature under the pinned
1Click key, all 17 signed request fields equal to the body sent, a live request answered only by a live quote with a
deposit address and no memo, loss at most 3%, amountIn at most asked), `nearhold.mjs checkHold` before signing,
`legok.mjs agreedBaseline` (two equal reads before a send) and `legOk` (arrived, and the NEAR origin tx and every
destination tx 1Click lists read back ok on two distinct RPCs of their chain). The run stops at the first leg that is
not ok (`common.mjs runLegs`). dry is false only in `--live`, which runs only in a terminal, re-sizes every leg with
fresh quotes, refuses while the funder is short, asks the owner to type the total NEAR back, and only then opens the
funder's key file. Caps: 20 NEAR a leg, 60 NEAR in all (fixed in NEAR, so a bad price cannot spend the funder).

Sizing: each 1Click leg is quoted at the wallet's dollars over 1Click's NEAR price, then once more with the amount
raised by that quote's out/in shortfall, so the wallet receives its dollars at the quoted rate.

## Dry run, 2026-11-02T09:55:42Z (`sh scripts/testmoney/fund.sh --dry`, record runs/2026-11-02T09-55-42-389Z-fund-dry.json)

After the re-check fold, with M4's $8. Prices (1Click /v0/tokens): NEAR $4.13, SOL $94.44, ETH $2290.22. 1Click key
from the env file. No fund-live record exists, so no deposit is open. Every wallet read on both RPCs of its chain
first: all hold 0, below 10%, so all are funded. 14 quotes, all checked. (Earlier records: 09:08:47Z before the M4
change, 09:14:08Z after it, 09:36:11Z after the review fold.)

| Leg | NEAR in | Out at the quote |
|---|---|---|
| M1 Solana | 8.259136 | $34.0391 |
| M2 Base | 6.461621 | $26.5894 |
| M2 Robinhood | 6.34989 | $26.1322 |
| M3 NEAR (Transfer) | 6.578692 | $27.1700 |
| M4 Solana | 0.70342 | $2.8873 |
| M4 Base | 0.714724 | $2.9403 |
| M4 Robinhood | 0.877972 | $3.5948 |
| M4 NEAR (Transfer) | 0.743341 | $3.0700 |
| M5 Solana | 1.430685 | $5.8901 |

- To the wallets: 32.119485 NEAR. Gas 0.139049 (nearhold.mjs txCost for 9 Transfers to 64-hex ids, the account
  creation charge counted on each) + funder storage 0.00182 + reserve 0.05 = **32.310354 NEAR needed**.
- The funder `951a5eab…fb33` holds **0.472269 NEAR** on free.rpc.fastnear.com and near.drpc.org (09:55Z), not the
  4.1007 N of 2026-10-26: the G1 loops spent it.
- **Top-up: 31.838086 NEAR (about $131.49 at $4.13).** The live run re-quotes, so a NEAR price move changes the
  need; a top-up of 32.5 NEAR covers a 2% move, and what is not used stays on the funder.

`sh scripts/testmoney/sweep.sh --dry` (09:56:16Z, record runs/2026-11-02T09-56-16-356Z-sweep-dry.json): no wallet is
funded yet, so each 1Click route was quoted at the wallet's planned amount back to the funder: 7 quotes checked,
loss 0.26-0.35% each. The NEAR wallets go back by a Transfer of their free balance.

**The first live sweep is a canary: `sh scripts/testmoney/sweep.sh --lane M5`** (one Solana wallet, $5.89 planned),
read back on two RPCs, before the other lanes.

## The review fold (AI review of e0d5832, FIX; folded 09:36Z)

1. A rerun after a stop paid finished legs again. Now each wallet is read on both RPCs first (the re-check fold below moves the default to 10%): at 97% of its dollars it
   is "held, skipped", below that it gets the difference; a live run refuses while a 1Click deposit in the last
   fund-live record is not SUCCESS, REFUNDED or FAILED (the deposit address is saved before the NEAR is sent); the stop
   line points at `node wallets.mjs balances`.
2. The EVM sweep refused whenever fees rose between plan and send. The plan now keeps ceil(1.5 x its reserve) back;
   the send still checks the amount plus its own reserve against the balance.
3. One wallet under 1Click's minimum blocked every lane. A sweep under $0.10, or one 1Click answers "Amount is too low
   for bridge, try at least N" (Base 560000000001 wei, Robinhood 10000000000000 wei, read 2026-11-02T09:30Z), is a
   leftover: skipped, with what stays printed.
4. Fund and sweep now take every outside call (RPCs, 1Click, Keychain, prompt, clock, sends) as one injected `D`, so
   each gate is tested. The review's 24 planted removals (adapted to the new code where its text moved) and 9 more for
   this fold: 33 of 33 killed, none survive.
5. sweep has no `--funder`: the funder is fixed.
6. A broken funder key file now gives one generic message; no part of the file is printed. The Keychain reads already
   print nothing of the key (a malformed item says only "not 32 bytes of hex").
7. A Solana sweep send not confirmed in 90 s throws ("may still land at <deposit>"), and nothing is submitted.
- fund.sh and sweep.sh say what is true: the dev-wallet keys are read first only to derive addresses; the funder's key
  file and the signing keys are used only after the typed confirmation.
- The reviewer's two dry records (runs/2026-11-02T09-16-28-326Z-fund-dry.json, …09-17-01-699Z-sweep-dry.json) are left
  untracked and untouched: they are the review's, not this card's.

## The re-check fold (re-check of 692f692, FIX; folded 09:55Z)

1. A deposit saved but never paid no longer blocks reruns. A deposit that is not final and whose 64-hex address has
   no NEAR account on both RPCs is printed as "never paid" and the run goes on. A not-final or unreadable status
   refuses only when the deposit's 64-hex address holds a NEAR account on an RPC, the account read fails or does not
   answer on both RPCs, or the address is not 64-hex; with no account on both RPCs it goes on (safe, as follows).
   Safe: the funder's next send takes a new nonce and a new 1Click deposit address, so the old quote can never be
   paid by it.
2. By default a wallet is funded only below 10% of its dollars (a first fund, or one refunded); it gets the
   difference. `--refill` tops up spent money: every wallet below 97% gets its difference, and the typed prompt
   names the dollars it re-funds ("--refill: re-funds $X of spent test money").
3. "Held" is decided on the larger of the two RPC reads, so one RPC behind does not fund a wallet twice. A wallet
   whose deposit in the last fund-live record is SUCCESS within the hour is skipped without a read.
4. Tests: the deposit is recorded (onDeposit, then saveRun fund-live) before the NEAR is sent; an unreadable status
   is not final; of two records the newest is read and a cut `.tmp` is never read; the nested `live.depositAddress`
   is read.
5. Run records are written to a temp file and renamed into place. **After the owner's live run, its
   `*-fund-live.json` record is committed**, since the next run reads it (README says so too).
- Red at 692f692, green after: the new test file run against 692f692's code fails 7 tests (items 1, 2 twice, 3 twice,
  4's unreadable status / nested address, 5's planted write fault) and passes 85 of 85 on this commit.
- The reviewer's 40-row mutate.mjs, its three rows whose text moved re-pointed (the temp-file scrub, the `below`
  threshold, the larger-read rule now planted as its inverse) plus 10 rows for this fold: **50 of 50 killed**.
- The review's four untracked dry records (runs/2026-11-02T09-16-28-326Z, 09-17-01-699Z, 09-40-42-675Z,
  09-41-06-019Z) are left untouched.

## The re-check fold 3 (round-3 AI re-check of dfbacec, FIX small; folded 10:17Z)

A. Tests now pin the "never paid" rule: a deposit counts as never paid only when both NEAR RPCs answer and both read
   no account at its 64-hex address. One RPC seeing the account (0 / 5), an account read that throws, one RPC answer
   only, or an address that is not 64-hex: each stays open, and a live run refuses.
B. The SUCCESS skip hour now starts at the `/v0/status` answer's top-level `updatedAt` (a key listed in
   proofs/pr3-1click-status-echo's record; its value read live 2026-11-02T10:18Z for deposit
   a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f: SUCCESS, `"2026-10-31T21:37:23.000Z"`;
   `Date.parse` reads it, and a nanosecond form too, both tested), not at the record's `started`. Chosen over a `depositAt` stamped in onDeposit: `updatedAt` is the SUCCESS moment
   itself, which is what the window waits on (RPCs catching up with the arrival), so neither a long run, a typed
   prompt left open nor a slow swap shortens it, and it needs no new record field, so records written before this
   fold read the same. An answer without a readable `updatedAt` falls back to `started`. A REFUNDED deposit is never
   skipped.
C. A test runs `main` without `--refill` on a wallet holding half its dollars: nothing is quoted (and one at exactly
   10% is held, the boundary the reviewer planted as N14).
D. `--refill`'s words ("re-funds $X of spent test money") are computed only with `--refill`; a run without it on a
   wallet at 5% asks to type the total with no refill words.
E. README gives the exact two lines to commit the new fund-live record (`git add` of that file, then the
   path-limited commit). Claim 1 of the re-check fold above now says when an unreadable status refuses: only when
   the deposit address holds an account, the account read fails or answers on one RPC, or the address is not 64-hex;
   with no account on both RPCs the run goes on.
- Red at dfbacec, green after: the new test file run against dfbacec's fund.mjs fails 2 tests (B's updatedAt window,
  D's prompt) and passes 87; on this commit 89 of 89 pass.
- Planted removals, scratch copy only (mut-fold3.mjs): the lead's 50 rows (three SUCCESS-window rows re-pointed at the
  rewritten line), the reviewer's N1-N14 and this fold's B and D rows: **66 of 66 killed** (N1, N2, N3, N4, N6, N12
  and N14 survived before this fold).
- Dry runs on this commit: `sh scripts/testmoney/fund.sh --dry` rc 0 (runs/2026-11-02T10-15-37-472Z-fund-dry.json):
  9 legs, 32.193943 NEAR to the wallets, the funder needs 32.384812 NEAR and holds 0.472269 on both RPCs, top-up
  31.912544 NEAR (about $131.48 at $4.12). `sh scripts/testmoney/sweep.sh --dry` rc 0
  (runs/2026-11-02T10-16-09-423Z-sweep-dry.json): every wallet holds 0, so 7 legs quoted at their planned amounts
  ($102.04 in, $101.77 out), 2 NEAR wallets need no quote, M2-sol has none planned.

## Reads (sources)

- Chain identity, both RPCs each, 2026-11-02T08:57Z: Solana `getGenesisHash` = `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`
  (api.mainnet-beta.solana.com, solana-rpc.publicnode.com); Base `eth_chainId` 0x2105 (mainnet.base.org,
  base-rpc.publicnode.com); Robinhood 0x1237 = 4663 (rpc.mainnet.chain.robinhood.com, robinhood-rpc.publicnode.com);
  NEAR `status` chain_id mainnet, genesis_hash `EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H` (free.rpc.fastnear.com,
  near.drpc.org, rpc.mainnet.near.org).
- 1Click token ids and decimals, `GET /v0/tokens` 2026-11-02T08:55Z: `nep141:wrap.near` 24, `nep141:sol.omft.near` 9,
  `nep141:base.omft.near` 18, `nep141:hood.omft.near` 18.
- fastnear answers `view_account` for an account not made yet with `HANDLER_ERROR` whose `cause.name`
  `UNKNOWN_ACCOUNT` comes after a long `info` block (2026-11-02T09:04Z). g1-money-loop near.mjs `nearNative` matches
  the name in a message cut at 200 characters, so it throws for such an account; `chains.mjs balance` reads
  `rpcError.cause.name` instead (test "NEAR balance: an account not made yet").

## Tests

`node --test scripts/testmoney/testmoney.test.mjs`: 89 pass (4 added by re-check fold 3, 9 by the re-check fold, 29 by the review fold, driving fund's and sweep's
live gates through injected deps; address vectors: the zero ed25519 seed gives NEAR
3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29 and Solana 4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS,
secp256k1 key 1 gives 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf). Planted cases: per body (fund and sweep) seven fields
asked other than the quote carries, a dry answer to a live request, an answer edited after signing; the stop rule on a
one-RPC read-back, no arrival, a throw and no gate; the split on a changed row, a wrong lane total and a moved
principal; M4's named change dropped while its wallets keep the $2, and one M4 wallet losing its $2 while the change
stays; the Keychain on a missing and a malformed item; the chain check on Base answering 1, Solana answering
devnet and NEAR answering testnet; the NEAR caps; no terminal. Removing each rule from the code fails tests: the quote
check (18), the stop rule (4), the §2.6 check (2), the chain compare (3), the missing-item refusal (1), the leg cap (1).
