# P2 CKD: result

**Pass line:** a test contract requests a CKD secret; we decrypt it and check it against domain 2's public key; the same
secret comes back on a second request.

**Testnet: PASS** (2026-10-19 21:02-21:17 UTC). 19 CKD responses from `v1.signer-prod.testnet`, all decrypted by our own
TypeScript client and checked with the BLS pairing equation against domain 2's live public key. Every request from the
same contract and path gave the same secret, with a fresh app key each time. All 42 recorded txs were re-checked on a second RPC
(`check-records.ts`, rpc.testnet.near.org: "all records match the chain").

**Mainnet: PASS** (2026-10-19 23:04-23:08 UTC, run by AI under the owner's overnight OK, plan §11.11). Two CKD
responses from `v1.signer` to a fresh test contract, both decrypted and pairing-checked against domain 2's live key, same
secret both times (fingerprint `a50759ee25098fba`). Every tx re-checked on near.drpc.org (`check-records.ts`: "all records
match the chain"). **Mainnet latency has a long tail:** 7.4 s and 96.8 s (165 blocks) in the passing run, 2.8 s in run 1,
and one request in run 3 got no answer at all (the MPC's own `fail_on_timeout`). See section 5.

Status key as in the hackathon research: **VERIFIED** = read in source or measured live.

---

## 1. The scheme (near/mpc tag `3.17.0`, commit `d0fc87b1`, the version live on both networks)

| Step | What happens | Source (all VERIFIED) |
|---|---|---|
| Groups | BLS12-381. MPC domain key `pk = msk·G2` (G2, 96 B compressed); app key, ciphertext and secret are G1 (48 B compressed, ZCash/blstrs encoding) | `crates/near-mpc-crypto-types/src/crypto.rs:7-8,120,139` |
| Wire format | `"bls12381g1:" + base58(48 B)`, `"bls12381g2:" + base58(96 B)` | `crypto.rs:283-292` |
| Request | `request_app_private_key({request: {derivation_path, app_public_key: {"AppPublicKey": A}, domain_id: 2}})`, 1 yocto, prepaid gas ≥ `ckd_call_gas_attachment_requirement_tera_gas` (**15 TGas live**; the README's "at least 10 Tgas" is stale) | `crates/contract/src/api/ckd.rs:24-67`, `api/common.rs:56-69`, README `crates/contract/README.md:109-124`; live `config` view |
| app_id | `SHA3-256("near-mpc v0.1.0 app_id derivation:" + predecessor + "," + path)`. **Predecessor = the account that called the MPC contract**, taken by the contract (`env::predecessor_account_id`) and by the node indexer from the receipt | `near-mpc-crypto-types/src/kdf.rs:17-38`, `ckd.rs:99-113`; contract `api/ckd.rs:34-53`; node `crates/node/src/indexer/handler.rs:376-397` |
| Hash to curve | `H = hash_to_curve_G1(pk_compressed(96 B) ‖ app_id)`, RFC 9380 `BLS12381G1_XMD:SHA-256_SSWU_RO_`, **DST `"NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_"`**, empty aug | `crates/threshold-signatures/src/confidential_key_derivation.rs:71-77`, `ciphersuite.rs:257-259`, `crypto/constants.rs:26` |
| Node side | each node i: random y, `Y = y·G1`, `S_i = x_i·H`, `C = S_i + y·A`, both scaled by its Lagrange coefficient; the leader sums them. So `Y = Σλ_i y_i·G1`, `C = msk·H + a·Y` | `threshold-signatures/src/confidential_key_derivation/protocol.rs:162-196` (Y 179, H 182, S 185, C 188, λ 191-194) |
| Response | `{big_y, big_c}` (two G1 strings) is returned through yield/resume as the result of the caller's promise. It is public: ElGamal ciphertext to `A` | `primitives.rs:135-137`; `api/ckd.rs:69-150` |
| Decrypt | `S = C − a·Y = msk·H(pk ‖ app_id)` (a BLS signature on the app id) | `confidential_key_derivation.rs:52-56`; `crates/ckd-example-cli/src/ckd.rs:132-153` |
| Verify | `e(H(pk ‖ app_id), pk) == e(S, G2)`, with S and pk on-curve, torsion-free, not identity | `ciphersuite.rs:229-255`; `ckd-example-cli/src/ckd.rs:99-114` |
| Key from S | application's choice. The upstream example uses `HKDF-SHA256(salt "near-mpc-ckd-hkdf-v1", ikm = S (48 B), info "near-mpc-ckd-strong-key-v1")`; use a distinct `info` per key purpose | `ckd-example-cli/src/ckd.rs:18-21,155-167`, its README lines 12-16 |
| Publicly verifiable variant | `{"AppPublicKeyPV": {pk1: a·G1, pk2: a·G2}}`; then the MPC contract itself checks `e(C,g2) = e(Y,pk2)·e(H,pk)` on chain before resolving | contract `primitives/ckd.rs:35-75`, `api/ckd.rs:94-102` |

**No JS client exists**: near/mpc 3.17.0 ships only a Rust client (`crates/ckd-example-cli`), and the research found
no other (chainsig-rails.md, open question 1). So we wrote `client/ckd.ts` on
`@noble/curves` 2.4.0 (bls12-381) and `@noble/hashes` 2.4.0. `client/ckd.test.ts` checks it against near/mpc's own vectors (all 4 in
`crates/threshold-signatures/tests/vectors/ckd_test_vectors.json`: pk, H, decrypt, pairing, HKDF) and the
app_id snapshot (`kdf.rs` test). It also rejects a tampered C, a wrong pk, the identity pk and a wrong app id. 4/4 tests pass.

## 2. Live checks (views)

| Network | Contract | Result | Read |
|---|---|---|---|
| testnet | `v1.signer-prod.testnet` | `version` "3.17.0"; domain 2 = `ConfidentialKeyDerivation`/`CKD`; 17 participants, threshold 11, keyset epoch 25; pk `bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj` | blocks 273,846,378-422 (and at the start of every run) |
| mainnet | `v1.signer` | `version` "3.17.0"; domain 2 = `ConfidentialKeyDerivation`/`CKD`; 17 participants, threshold 11, keyset epoch 13; pk `bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR`; `ckd_call_gas_attachment_requirement_tera_gas` 15 | blocks 220,707,897-899 (near.drpc.org); again in the `--dry` run |

The runs read the key from both `public_key {domain_id: 2}` and `state.keyset` and require the two to match.

## 3. Testnet run (the pass line)

Test contract `contract/` (near-sdk 5.29.1, built with `cargo near build non-reproducible-wasm --locked`, rustc 1.96.0,
cargo-near 0.22.0): `request_key(derivation_path, app_public_key)` is owner-only. It calls
`request_app_private_key` with 1 yocto from its own balance and 30 TGas, then returns the response from its
`on_ckd` callback. So the MPC's predecessor is the contract, as it will be for the ghost contract. The committed wasm
`contract/wasm/p2_ckd_v1.wasm` (120,276 B) has code hash `8jpWtaFxZm5HDPRCTSWs3obKQYGSzi1i9Y4LjMw3YHnA`; each run
compares it with the deployed `code_hash`.

Canonical run, `client/data/testnet-run-2026-10-19T211625590Z.json` (current code, defaults):

| Step | Tx | Burnt (N) |
|---|---|---|
| fund fresh implicit account `9f8eba24…62e1a3` (1.3 N) | [5kU4vvmW…](https://testnet.nearblocks.io/txns/5kU4vvmW4Nm7mkEymWu5QDGQn2MeDBpJtwtn4ngytkoF) | 0.007115 (incl. the 0.007 N `account_creation_charge`) |
| deploy + `new` | [DpyxEucz…](https://testnet.nearblocks.io/txns/DpyxEuczd62EtQcrmepeLXYaTgzZpKqNF1rrNshzagDp) | 0.001046 |
| request 1 → verified, fingerprint `e995b524688d108b` | [7Ahon8X5…](https://testnet.nearblocks.io/txns/7Ahon8X5agVnzB8u4qZN2QgQYZYN2xTAfCtrXKwZ5df6) | 0.001164 |
| request 2 → verified, **same** fingerprint | [9nDGu8UU…](https://testnet.nearblocks.io/txns/9nDGu8UUB7HPm3PSHLVHgmMkGhDsgFHpvSD7azZB45sD) | 0.001164 |
| delete account, refund to funder | [8WY3AcxS…](https://testnet.nearblocks.io/txns/8WY3AcxSmdJ5fVqkrf5DVbN2KJyUaD8ZUYbdPoYiytdd) | 0.000051 |
| **funder balance change** | | **0.010770** (burnt 0.010540 + 0.000230 not shown as burnt, the same in every run) |

Other runs, same result: `…210259971Z` (first pass, [DyuqyY2B…](https://testnet.nearblocks.io/txns/DyuqyY2BzWYSq3wfJpe9jwXckHdqUprdZTHFPfKpYT5x),
[FwENttcw…](https://testnet.nearblocks.io/txns/FwENttcwDYSLgznRCytmxCzArw5PKNYP9hcZLHT88Etr)), `…211032705Z`, and `…211151396Z`
(8 requests, all one fingerprint). `…211503412Z` is a failed run kept as evidence. With a 1.25 N hold, only 0.043 N
was free after storage, and the 80 TGas request was rejected (`INVALID_TRANSACTION`): prepaid gas is bought at the
1e9 yocto/gas `min_gas_purchase_price`, so it needs 0.08 N free. The refund-on-failure path deleted the account and
returned the money. Fix: 60 TGas per request and a 1.3 N hold.
The fingerprint is a SHA-256 tag of the secret, safe to publish. The secret, the app scalars and the derived keys never leave memory.

**Latency** (19 responses, block timestamps):

| Measure | p50 | p90 | max |
|---|---|---|---|
| MPC `request_app_private_key` receipt → `return_ck…` resume | **3.59 s** (6 blocks) | 17.3 s | 31.9 s (64 blocks) |
| tx included → result | 4.79 s | 18.5 s | 33.0 s |
| client: send → result in hand (1 s polls) | 6.39 s | 20.1 s | 34.4 s |

14 of 19 answered in 3.0-3.7 s. Five took 8.7, 12.8, 14.7, 27.9 and 31.9 s (testnet MPC; mainnet not measured). The yield timeout
is 200 blocks on both networks (`yield_timeout_length_in_blocks`, `EXPERIMENTAL_protocol_config`), so the worst case
used a third of it. CKD runs once per enclave boot, never on a trade path.

## 4. Open question: what decides who gets the root? (measured, `client/data/testnet-extras-…210615860Z.json`)

| Case | Same path `p2-ckd/root` | Fingerprint | Tx |
|---|---|---|---|
| A, contract v1 (`8jpWta…`) | baseline | `72dd615f7b45a11b` | [8RwLRWww…](https://testnet.nearblocks.io/txns/8RwLRWwwgo3FHFUAQ2Tay73PhiCCAwG2teQRh6SdzjzU) |
| A **upgraded** to v2 (code hash `CNBhSAtB…`, `version()` = "p2-ckd v2 (upgrade test)" at blocks 273,847,847-848) | **same** | `72dd615f7b45a11b` | [89DwiJAp…](https://testnet.nearblocks.io/txns/89DwiJApiy23YnU5iNGjLr5WegtyGJeubu3LPoNFEqba) |
| A's **full-access key calls `v1.signer` directly**, no contract code | **same** | `72dd615f7b45a11b` | [8EgUi3Gi…](https://testnet.nearblocks.io/txns/8EgUi3GirJWRuUT5oXfhop4CF8SH39zBt9To1Jy86wmW) |
| A, other path `p2-ckd/other` | different | `009e564234562bfd` | [7ypTYLCA…](https://testnet.nearblocks.io/txns/7ypTYLCAjhe5sxrQvdFBSXhG1W77A81qc5s7yWeMVmjz) |
| B, same v1 wasm on another account | different | `0005cd8809dbe9f8` | [4fFuJnNd…](https://testnet.nearblocks.io/txns/4fFuJnNdtJx1rk55SaQSnFVUfbfkdon8AdCn8dUmmTgY) |

The source agrees: the inputs are (domain msk, predecessor account id, path) and nothing else (`kdf.rs:17-38`; the code
hash is never read). The upstream design doc is explicit: "the MPC contract does not verify remote attestation ... The developer
must control the contract which calls the CKD functionality, and make the required verifications within that contract"
(`threshold-signatures/docs/confidential_key_derivation/confidential-key-derivation.md:61-65`). Its example
`get_key` checks the attestation, the image digest in the event log, and that `A` is in `report_data` (lines 137-150).

**What this means for "only the approved code hash can get the root".** The root belongs to the ghost contract's
**account name**, not to its code. So the claim holds only if the ghost contract enforces all of these:
1. **No full-access key on the ghost account**, ever after deploy. One key = the root, with no contract involved (row 3).
2. **The upgrade path is the root's gate.** Upgraded code gets the same root (row 2). Code changes go only through the
   approved-hash lock-in with the public 24 h delay (plan §5), with no other `deploy` path.
3. **`request_key` accepts `A` only from a verified attestation** of the approved code hash, with `A` bound in `report_data`.
   The response is public ciphertext, so whoever supplies `A` gets the root.
4. **A fixed path.** The path is a public argument and each new path is a new root (row 4), so the contract pins it. Per-user keys are
   derived inside the enclave (HKDF `info` per user and purpose), never as on-chain paths, which would publish linkable traces.
5. **The account name must never be re-creatable by someone else.** If the ghost account were deleted, whoever can
   re-create that name gets the same root. For a sub-account that means the parent's owner. Never delete it.
6. 11 of 17 MPC nodes can compute any app's secret (ToB finding 15, chainsig-rails.md CS13). This is unchanged.

## 5. Mainnet (4 runs, 2026-10-19 22:35-23:08 UTC)

Funder `951a5eab…3bfb33` (hackathon wallet, funded by the owner). `mainnet-run.sh` = self-test, then
`run.ts --network mainnet --yes --funder ~/.confidential-trenches/keys/funder-near.json`.

| Run | Record | Outcome | Net cost (N) |
|---|---|---|---|
| 1 (owner's paste) | `mainnet-run-…223513195Z` | request 1 **verified** in 2.8 s (5 blocks); request 2 succeeded on chain (`62yXJ2cv…`) but our poll threw on a dRPC free-plan timeout, and the error path deleted the account while request 2 ran, losing its gas refunds. Fixed: polls retry transport errors; `settle()` waits for FINAL before a delete | 0.046017 |
| 2 (owner's paste) | `mainnet-run-…225334510Z` | stopped before the deploy: near-api-js read the new account's key from one endpoint that had not seen it, then the teardown hit a FastNEAR 429. 1.3 N stayed in `588a04ec…` until `refund.ts` ([CY14TiYp…](https://nearblocks.io/txns/CY14TiYpUp5tqtzo8dNoLbcFkG5fP1RjURA84wcWrwyL), FINAL). Fixed: all signing reads go through `Rpc` (failover, backoff), a fresh key is waited for | ~0.0072 |
| 3 | `mainnet-run-…230142756Z` | request 1 ([DCTpfzJu…](https://nearblocks.io/txns/DCTpfzJu6inYech8bTjdJUCKqJ4BMeNDcxJV4r99Jtou)) **got no MPC answer**: `v1.signer`'s `fail_on_timeout` fired ("Request has timed out"), our callback panicked as designed. ECDSA `sign` requests on `v1.signer` were answered in the same minutes. Teardown clean | 0.009783 |
| 4 | `mainnet-run-…230446061Z` | **PASS**: fund [DTagysyV…](https://nearblocks.io/txns/DTagysyVaWmev6e4peGK73MwkZ4RoroPW14yAG1Kf3yV), deploy [EPTgqusv…](https://nearblocks.io/txns/EPTgqusvVDdEAcNkznAoWXtTgjTDWPCYttqkonX2yANe), request 1 [AkPaoSkC…](https://nearblocks.io/txns/AkPaoSkCG6p5BUy2y1kHVG15MKcqyJDp1gupbHJrnbk8) 7.4 s (13 blocks), request 2 [5k8hV1DJ…](https://nearblocks.io/txns/5k8hV1DJRZPzDS57GRjERjEhsjuueSbJvUJ82CEjmr2d) 96.8 s (165 blocks), same fingerprint, delete [B8aRs6qD…](https://nearblocks.io/txns/B8aRs6qDT62ZCS84bpPAuTxr2LXT5659uDKVLVcn2sPm). The run printed "REFUND FAILED (INVALID_TRANSACTION)" although the delete had succeeded: the send was retried on the next endpoint after the first had taken it. Fixed: an `INVALID_TRANSACTION` on send is looked up by hash first (regression test `near.test.ts`, fails before, passes after) | 0.010639 |

**Mainnet P2 total: ~0.074 N** (~$0.37 at $4.94/N), of which ~0.046 N was run 1's lost refunds.

**What this means for the product:** CKD on mainnet answered 4 of 5 requests, from 2.8 s to 96.8 s, and dropped one.
CKD sits on the enclave's boot path only (never per trade), so the speed target is untouched, but the boot path must
(a) treat a timeout as normal and re-request with backoff, (b) budget minutes, not seconds, for a cold start, and
(c) keep the previous instance serving until the new one holds its key. This goes into the P3 enclave spec.

## 6. Files

`contract/` (src, Cargo.lock, `build.sh`, committed `wasm/` v1 and v2), `client/ckd.ts` (the scheme), `ckd.test.ts` + `vectors/`
(upstream vectors, MIT), `near.ts`/`steps.ts` (RPC, signing), `run.ts` (pass line, both networks, `--dry`), `extras.ts`
(section 4), `check-records.ts` (re-checks every recorded tx on a second RPC), `refund.ts`, `testnet-funder.ts` (faucet),
`data/` (every run's record: tx hashes, blocks, latency, fingerprints; no keys). Testnet funder `p2ckd-be9844bc.testnet`
(faucet), every test account deleted. Testnet keys from these runs sit in `confidential-trenches/.keys/` (gitignored);
from now on new keys go to `~/.confidential-trenches/keys/`.

## 7. Risks and notes

- Latency has a tail on both networks (testnet up to 31.9 s; mainnet up to 96.8 s, plus one timeout in 5). The ghost
  contract's callback must handle a yield timeout and the enclave must retry. Boot path only.
- No other mainnet CKD usage was found in the research sample (chainsig-rails.md CS12), so mainnet CKD liveness is thin
  evidence (5 requests). The benchmark should sample it again before G2.
- `0.000230 N` per run is charged but not reported as `tokens_burnt`. It is the same in 2- and 8-request runs, so it comes from
  fund/deploy/delete. The cause was not traced. The cost above includes it.
- The secret is bound to domain 2's public key (it is hashed into H). A future re-keying of domain 2 (a new domain,
  not a reshare) would change every root. Resharing keeps msk (not exercised here).
