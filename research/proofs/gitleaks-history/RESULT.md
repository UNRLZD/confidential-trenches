# gitleaks full-history scan

Run by prep lane PR1 on 2026-10-22 at 18:56:59Z, 19:12:18Z and 19:18:23Z (from `date -u`), for merge note M190 (12)
("the gitleaks full-history scan"). gitleaks 8.30.1, from the repo root:

```
gitleaks detect --source . --redact --no-banner --log-opts="--all"
```

(Each run also wrote `--report-format json --report-path <scratchpad>`; the report is redacted and not kept here.)

**Result: 5,184 hits, all rule `generic-api-key`, in 61 files and 20 commits. None is a secret: every matched value is
public data the generic rule mistakes for a key (4,747 EVM addresses, 371 NEAR account ids, 53 dash-joined labels,
7 base58 public values, 6 Cashu keyset ids).** The later runs (703 and 707 commits; the last one after this lane's
F3, B1, BNB, B3 and B2 commits) found the same 5,184 fingerprints, none new and none gone. This folder's own commit
comes after the last run; its two files were scanned one by one before it (no leaks). No value was printed at any step.

| Run | Commits scanned | Bytes | Hits |
|---|---|---|---|
| 18:56:59Z | 696 | 66.27 MB in 7.07 s | 5,184 |
| 19:12:18Z | 703 | 66.61 MB in 8 s | 5,184 (same fingerprints) |
| 19:18:23Z | 707 | 66.70 MB in 7.83 s | 5,184 (same fingerprints) |

## How the hits were classified, without printing them

A script outside the repo read each hit's line from `git show <commit>:<file>`, located the secret by the redacted
`Match` text around it, and printed only a shape class (regexes: `0x` + 40 hex; 66 hex; base58 of 43-44 chars; a
`.near`/`.tg` account id; 64 hex; a dash-joined label). One hit did not fit a class and was checked with long tokens
masked: in `sol-labels.json` the match runs from line 95 into line 96, whose value is a Solana program id (a key in a
program-id → label map). The key-named hits were each read in their code with the value masked:

- `solanaKey` (4, `proofs/p1-private-balance/runs/*`): `run.mjs` writes `solanaKey: sol.address` at all three commits,
  a public address.
- `keyset_id` / `other_root_keyset_id` (6, `proofs/p7-notes/runs/*`): the id from the test mint's public
  `GET /v1/keys/<id>` (`run.ts:54-55`, `lib.ts:34-35`).
- `Access key ed25519:…` (1, `proofs/p2-ckd/client/data/mainnet-run-…json:24`): an RPC error message naming a public key.
- `destinationTokenAccount=` (1, `proofs/p4-speed/solana/results/live-…json:840`): a Solana token account in a Jupiter URL.
- `HKDF_INFO_STRONG_KEY` (1, `proofs/p2-ckd/client/ckd.ts:23`): an HKDF info label. `DEFAULT_TOKEN`, `KEYCAT`,
  `token`: EVM token addresses. `key: "…"` in `build-fixtures.mjs` and the capture logs: fixture job names.

`.gitleaksignore` (666 entries, marked by team lead 2026-10-20) matches none of these 5,184 (checked in both the commit and
the commit-less fingerprint forms); its entries cover other files. Marking these hits is team lead's call under the owner's
standing rule for provably public hits; this lane did not edit `.gitleaksignore`.

## Every hit: file, commit, rule

The full list, one row per hit (commit, file, rule id, line, column, value shape; no value): `results/hits-2026-10-22T18-57Z.tsv`
(5,184 rows). Grouped by file and commit:

| File | Commit | Rule | Hits | Lines | Value shape |
|---|---|---|---|---|---|
| `design/proto/fixtures/ohlcv/eng-NEARLY-markers.json` | `eb8719682c` | generic-api-key | 282 | 1-1 | NEAR account id |
| `design/proto/tools/build-fixtures.mjs` | `eb8719682c` | generic-api-key | 3 | 150-386 | label (dash-joined) |
| `design/proto/tools/capture-log-2.json` | `eb8719682c` | generic-api-key | 12 | 18-662 | label (dash-joined) |
| `design/proto/tools/capture-log-3.json` | `eb8719682c` | generic-api-key | 13 | 16-389 | label (dash-joined) |
| `design/proto/tools/capture-log-4.json` | `eb8719682c` | generic-api-key | 12 | 115-369 | label (dash-joined) |
| `design/proto/tools/capture-plan.json` | `eb8719682c` | generic-api-key | 12 | 154-490 | label (dash-joined) |
| `proofs/p1-private-balance/runs/2026-10-19T21-17-38-247Z-dry.json` | `5169860f5c` | generic-api-key | 1 | 11 | base58 public value |
| `proofs/p1-private-balance/runs/2026-10-19T21-49-01-314Z-dry.json` | `04fa19ad3b` | generic-api-key | 1 | 11 | base58 public value |
| `proofs/p1-private-balance/runs/2026-10-19T22-20-16-772Z-dry.json` | `0d7290801e` | generic-api-key | 1 | 11 | base58 public value |
| `proofs/p1-private-balance/runs/2026-10-19T22-53-44-913Z-live.json` | `0d7290801e` | generic-api-key | 1 | 11 | base58 public value |
| `proofs/p2-ckd/client/ckd.ts` | `71aa875905` | generic-api-key | 1 | 23 | label (dash-joined) |
| `proofs/p2-ckd/client/data/mainnet-run-2026-10-19T225334510Z.json` | `f5c34b5f19` | generic-api-key | 1 | 24 | base58 public value |
| `proofs/p3-coverage/base-controls.mjs` | `257c61db6f` | generic-api-key | 1 | 8 | EVM address |
| `proofs/p3-coverage/base-relay-clanker-age.mjs` | `756852e5e6` | generic-api-key | 1 | 12 | EVM address |
| `proofs/p3-coverage/results/base-2hop.json` | `257c61db6f` | generic-api-key | 8 | 48-104 | EVM address |
| `proofs/p3-coverage/results/base-lifi.json` | `756852e5e6` | generic-api-key | 8 | 7-112 | EVM address |
| `proofs/p3-coverage/results/base-pf-classes.json` | `257c61db6f` | generic-api-key | 2240 | 30-28201 | EVM address |
| `proofs/p3-coverage/results/base-poolfirst-fill.json` | `257c61db6f` | generic-api-key | 35 | 95-544 | EVM address |
| `proofs/p3-coverage/results/base-poolfirst-more.json` | `257c61db6f` | generic-api-key | 31 | 5-456 | EVM address |
| `proofs/p3-coverage/results/base-poolfirst-tokens.json` | `257c61db6f` | generic-api-key | 2240 | 3-30735 | EVM address |
| `proofs/p3-coverage/results/base-relay-clanker-age.json` | `756852e5e6` | generic-api-key | 7 | 5-65 | EVM address |
| `proofs/p3-coverage/results/base-relay-extra.json` | `756852e5e6` | generic-api-key | 2 | 35-49 | EVM address |
| `proofs/p3-coverage/results/base-relay-quotes.json` | `756852e5e6` | generic-api-key | 14 | 8-365 | EVM address |
| `proofs/p3-coverage/results/base-relay-rerun.json` | `257c61db6f` | generic-api-key | 6 | 6-116 | EVM address |
| `proofs/p3-coverage/results/base-relay-rerun2.json` | `257c61db6f` | generic-api-key | 2 | 6-28 | EVM address |
| `proofs/p3-coverage/results/base-top-doppler.json` | `756852e5e6` | generic-api-key | 25 | 6-438 | EVM address |
| `proofs/p3-coverage/results/base-v4-quoter.json` | `759da0537e` | generic-api-key | 46 | 18-1187 | EVM address |
| `proofs/p3-coverage/results/controls.json` | `257c61db6f` | generic-api-key | 2 | 47-84 | NEAR account id |
| `proofs/p3-coverage/results/near-2hop.json` | `257c61db6f` | generic-api-key | 4 | 20-295 | NEAR account id |
| `proofs/p3-coverage/results/near-checks.json` | `756852e5e6` | generic-api-key | 7 | 96-317 | NEAR account id |
| `proofs/p3-coverage/results/near-route-sample.json` | `756852e5e6` | generic-api-key | 8 | 95-673 | NEAR account id |
| `proofs/p3-coverage/results/sol-labels.json` | `756852e5e6` | generic-api-key | 1 | 95 | Solana program id (lines 95-96) |
| `proofs/p4-speed/base/results/2026-10-19T21-23-43-454Z-dry.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T21-28-17-758Z-rehearse.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T21-30-03-667Z-rehearse.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T21-32-05-063Z-rehearse.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T21-34-49-740Z-rehearse.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T22-16-28-772Z-dry.json` | `7e78118952` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T23-26-18-403Z-live.json` | `0ddad7163d` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T23-27-18-285Z-live.json` | `0ddad7163d` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-19T23-38-52-673Z-live.json` | `0ddad7163d` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-20T00-44-01-931Z-rehearse.json` | `fc4a76af39` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-20T00-51-59-782Z-live.json` | `9280fda4df` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-20T02-44-23-706Z-dry.json` | `57e9b1bd7c` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/2026-10-20T02-45-28-154Z-live.json` | `57e9b1bd7c` | generic-api-key | 1 | 4 | EVM address |
| `proofs/p4-speed/base/results/ghosts.json` | `0ddad7163d` | generic-api-key | 46 | 8-323 | EVM address |
| `proofs/p4-speed/base/results/ghosts.json` | `6cc7efdb4b` | generic-api-key | 1 | 470 | EVM address |
| `proofs/p4-speed/base/results/ghosts.json` | `9280fda4df` | generic-api-key | 20 | 330-463 | EVM address |
| `proofs/p4-speed/base/run.mjs` | `7e78118952` | generic-api-key | 1 | 62 | EVM address |
| `proofs/p4-speed/near/results/2026-10-19T21-45-07-978Z-dry.json` | `7e78118952` | generic-api-key | 4 | 4-93 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-19T22-13-47-723Z-dry.json` | `7e78118952` | generic-api-key | 4 | 4-100 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-19T23-16-23-460Z-dry.json` | `d8ef212546` | generic-api-key | 4 | 4-100 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-19T23-16-48-050Z-live-progress.json` | `d8ef212546` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-19T23-17-30-770Z-live.json` | `d8ef212546` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-19T23-56-24-589Z-live.json` | `d8ef212546` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-20T00-51-31-374Z-live.json` | `33ca5ab661` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-20T01-09-49-556Z-live.json` | `33ca5ab661` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/2026-10-20T01-27-04-776Z-live.json` | `33ca5ab661` | generic-api-key | 1 | 4 | NEAR account id |
| `proofs/p4-speed/near/results/ghosts.json` | `33ca5ab661` | generic-api-key | 42 | 64-351 | NEAR account id |
| `proofs/p4-speed/near/results/ghosts.json` | `d8ef212546` | generic-api-key | 8 | 8-57 | NEAR account id |
| `proofs/p4-speed/solana/results/live-2026-10-20T00-02-08-517Z.json` | `b5e7eb06df` | generic-api-key | 1 | 840 | base58 public value |
| `proofs/p7-notes/runs/2026-10-19T23-02-24-078Z.json` | `491e290674` | generic-api-key | 2 | 16-19 | Cashu keyset id |
| `proofs/p7-notes/runs/2026-10-19T23-04-28-428Z.json` | `491e290674` | generic-api-key | 2 | 16-19 | Cashu keyset id |
| `proofs/p7-notes/runs/2026-10-19T23-29-35-071Z.json` | `9992c4697c` | generic-api-key | 2 | 16-19 | Cashu keyset id |
