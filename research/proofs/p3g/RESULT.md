# P3g: our dstack v0.6.1 enclave on one Google Cloud C3 TDX VM

Lane P3G, 2026-10-22 03:32Z to 05:15Z (`date -u` reads). Google Cloud project `trenches-enclave-e0ff2c` (number
840692695115). Every gcloud call went through `g.sh`, which pins the project two ways and logs to `results/gcp.log`.
No Phala service and no BUSL-1.1 part was used. Estimated spend is **$0.13 of the $10 cap**, for **0.254 VM-hours**.
VM `p3g-c3` is **STOPPED** (TERMINATED). Nothing was deleted.

Tags: **M** = measured here (commands in "Rerun"). **D** = a vendor's own docs or code say it (path:line or URL).
**I** = my inference. **UNKNOWN** = not verified.

## Answers

1. **Image: PASS (M + D).**
   - We used Dstack-TEE/dstack release `mkosi-os-v0.6.1` asset `dstack-0.6.1-uki.tar.gz`, sha256 `42ce3692…5fa8`. That equals
     both the GitHub asset digest and the release's `image-hashes.txt`.
   - Its `disk.raw` (sha256 `430adff7…ced7`) was the boot disk.
   - `os_image_hash` = `ec43cb8c…47e6`. The UKI (`f348ff57…1fd1`) equals the release's `gcp_uki_auth`. It is the prod image
     (§1).
   - Key provider `tpm`. No KMS, no gateway; `allowed_envs` is `[]`. Collateral comes from Intel PCS only. Licences are
     in §1; none is BUSL.
2. **One VM: PASS (M).**
   - `p3g-c3`: c3-standard-4, `--confidential-compute-type=TDX`, us-east4-a, maintenance TERMINATE, no service account.
   - It sits on its own VPC `p3g-net`. Firewall `p3g-allow-mac` allows tcp 8080/3338/3339/8090 from `14.181.204.148/32`
     only.
   - P7 run 2's compose, adapted: two cdk-mintd v0.18.2 mints. Their installer refuses any binary whose sha256 is not
     `0d33d686…c54f`. `mint` is seeded from CKD root S; `mintt` from P7's public test root.
   - The app answered 69 s after create.
3. **Attestation: PASS (M).**
   - **TCB `UpToDate`, advisories `[]`**, against Intel PCS collateral issued 2026-10-22T04:04:54Z (tcbEvaluationDataNumber
     20). FMSPC `00806f050000`, PPID `b391ff59fda1bd9d7c4471d42830ef9c`.
   - dstack-verifier v0.6.1: `is_valid: true`, `tee_variant: dstack-gcp-tdx`, on both boots.
   - Testnet contract `p3g-ghost.p2ckd-be9844bc.testnet` (no access keys) registered both boots in two steps:
     - **step 1 `register_tpm`: 132.32 TGas** (contract receipt 131.45; this includes the GCE project check at 0.52);
     - **step 2 `register`: 211.30 TGas** (contract receipt 195.80).
   - No C4 VM was needed, because C3 is UpToDate.
4. **Stop/start: PASS (M).**
   - **PPID before = after = `b391ff59fda1bd9d7c4471d42830ef9c`**, with the same PCK certificate serial.
   - The TPM-sealed seed unsealed (PCR policy sha256:0,2,14) and the LUKS data disk opened again, with its journal
     recovered.
   - These stayed the same across the restart: app_id, compose hash, instance_id, MRTD/RTMR0-2, PCR0/2/14, the CKD root
     fingerprint `a3b7da4bc99b1592` and the mint keyset `01b29af2…641b`.
5. **P7 row 1, items 1-4: PASS (M).**
   - (1) The pinned mint runs in the CVM. Its seed was written from CKD inside the CVM to a 1 MB tmpfs (mode 400). The app
     has no env other than the image defaults.
   - (2) `mintt`'s keyset `01ae7231…229fa1fe` and all 32 keys equal P7's local run.
   - (3) P7's client did a round trip from the Mac on both mints.
   - (4) After the restart both keysets are unchanged, earlier notes keep their states, and a new deposit works.
6. **team lead M162 (§6).**
   - Q1: the AK certificate's subject is `L=us-east4-a, O=Google Compute Engine, OU=trenches-enclave-e0ff2c,
     CN=7627989056050441480`.
   - The instance-identity extension (OID 1.3.6.1.4.1.11129.2.1.21) is present: zone us-east4-a, project number
     **840692695115** (= `gcloud projects describe`), project id trenches-enclave-e0ff2c, instance id
     7627989056050441480, instance name p3g-c3.
   - Step 1 checks it (E37), and its gas is measured with that check.
   - Q2: a `tpm` boot has **no sealed vendor blob or config channel**. Without KMS, dstack refuses an encrypted env. The
     only unmeasured input is the shared disk's `.user-config`, which the app must authenticate itself. Citations in §6.
7. **team lead R15a (§7).**
   - (1) PCR14 holds exactly dstack's 10 runtime events (app-id, compose-hash, instance-id, key-provider, …). Its
     compose-hash payload equals RTMR3's compose-hash event in the same boot's TDX quote, and equals the repo's
     app-compose sha256 `7c81cb60…fe81`.
   - (1, cont.) The app container sees no `/dev/tpm*`. Through the guest agent, a container gets TPM quotes only over
     sha256(TDX quote), never over arbitrary data.
   - (2) The AK chains through "EK/AK CA Intermediate" (serial `DB15BB6D…A053`, issued 2026-05-19) to the pinned
     **2022 root** `594759…beb2`, not the 2018 chain. PEMs are saved.
   - (3) Step 1's gas already includes the project check (0.52 TGas of 132.32).

---

## 1. Image and licences

**Downloads** (all in `vendor-dl/`, gitignored; nothing from them ran on the Mac except the verifier built from source):

- Source: `git fetch --depth 1 origin tag v0.6.1` of https://github.com/Dstack-TEE/dstack.git gave commit
  `7f143148cc49f4a09799958835d310e050137cb3`. That equals `git_revision` in `image-hashes.txt` and the commit PG read.
- OS: release `mkosi-os-v0.6.1` (published 2026-10-13T02:17:37Z), read through the GitHub API. Its 4 assets and their
  digests:
  - `dstack-0.6.1-uki.tar.gz`: 615,602,925 B, sha256 `42ce3692a3ca779bf12506130a142ce2ffc749ac5e1d0261c54750616e625fa8` (used);
  - `dstack-0.6.1.tar.gz`: `7583f51c…ca41` (not used);
  - `dstack-0.6.1-kernel-devel.tar.gz`: `bbbba3a7…8c3c` (not used);
  - `image-hashes.txt`: sha256 `39abd5ef…0436`.
  - Our download's sha256 equals both the API digest and the `image-hashes.txt` line (M).
- Inside the UKI tarball:
  - `disk.raw` (868,220,928 B, sha256 `430adff7f2c3f00a8d9db2825e698acdccb1ebe7979cffdd23eb539e8be7ced7`);
  - `digest.txt` = `ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6` = `os_image_hash` in
    `image-hashes.txt` and in both attestations (M);
  - `image-hashes.txt` gives `gcp_uki_auth f348ff57230e76a53a9c343ab67fe43a2f50616a328fe613e0346aea71cf1fd1`. That is
    the PCR2 event 3 digest in both TPM event logs (M).

**Boot disk** (`cvm.mjs disks boot`, M):

- An APFS clone of `disk.raw` is checked for its sha256 prefix, then zero-padded to 1 GiB. Google requires 1 GB
  increments (D: https://cloud.google.com/compute/docs/import/import-existing-image, read 04:23Z).
- It is packed with GNU tar `--format=oldgnu -S` (tar sha256 `ac6f3da3…cfaa`). It became image `p3g-dstack-0-6-1` with
  UEFI_COMPATIBLE, TDX_CAPABLE and GVNIC.
- The shared FAT32 disk `DSTACKSHR` holds `app-compose.json` (sha256 = compose hash `7c81cb60…fe81`), `.sys-config.json`
  (`d20429f5…18b4`) and `.instance_info`. The data disk is an empty GPT with one Linux partition, `dstack-data`.
- `results/disks.json` has every hash.

**Prod, not dev (D + M):**

- dstack names its development archive `dstack-dev-<version>.tar.gz`, and that archive records `"is_dev": true` (D:
  `docs/building-guest-os.md:130-131`).
- The v0.6.1 OS release publishes no `dstack-dev-*` asset. We booted `dstack-0.6.1-uki`, and its UKI hash is the
  release's own `gcp_uki_auth` (M).
- The TD debug attribute is off in both quotes (`td_debug_bit: false`, M).
- The verifier's `os_image_is_dev` is `null` on the GCP path (D: `dstack/verifier/README.md:41`: "null on every path but TDX legacy").
- The `metadata.json` bytes (sha256 `a724f0ee…3319`, listed in the measured `sha256sum.txt`) are not in the UKI tarball,
  so I did not read their `is_dev` (UNKNOWN; the hash is bound by `os_image_hash`).

**No BUSL, no Phala service (M + D):**

- `grep -rIl "BUSL\|Business Source"` over the whole v0.6.1 tree finds nothing.
- Nothing from Phala-Network/meta-dstack-cloud was fetched.
- `.sys-config.json` has `kms_urls: []` and `gateway_urls: []`, and `pccs_url` is Intel PCS. If it were empty, dstack
  would fall back to Phala's PCCS, so it was set explicitly.
- The verifier's OS-image download URL points at a closed local port (`verifier.toml`).

**Licences**

| Part | Licence | Source |
|---|---|---|
| Dstack-TEE/dstack v0.6.1 (OS image, guest agent, dstack-util, tpm-qvl, tpm-types, verifier) | **Apache-2.0** | Repo `LICENSE` (Apache 2.0), GitHub API `spdx_id` Apache-2.0, SPDX header `Apache-2.0` in every file read (`system_setup.rs`, `dstack-attest/src/lib.rs`, `tpm-qvl/src/lib.rs`, `verifier/src/main.rs`, `rpc_service.rs`). One inconsistency: the Rust workspace metadata `dstack/Cargo.toml:11` says `license = "MIT"` while the same file's SPDX header says Apache-2.0. Both are permissive; neither is BUSL |
| NEAR shade-attestation 0.2.0 (vendored, `contract/shade-attestation/`) | MIT | its `LICENSE` |
| dcap-qvl 0.5.2 (contract), 0.5.3 (verifier) | MIT | crate metadata |
| @phala/dcap-qvl 0.6.3 (npm, Mac-side collateral fetch in `attest.mjs`) | Apache-2.0 | package.json |
| dcap-qvl-webpki 0.103.4 | ISC | crate metadata |
| x509-parser 0.16, near-sdk 5.29.1 | MIT OR Apache-2.0 | crate metadata |
| cdk / cdk-mintd v0.18.2 | Apache-2.0 OR MIT | P7 |
| cashu-ts 4.11.0 (P7 client) | MIT OR Apache-2.0 | P7 |
| node:24-alpine (container base) | MIT (Node.js) | P3/P7 pin |
| Whole contract graph (372 crates) | MIT / Apache-2.0 / ISC / BSD / Zlib / CC0 / Unlicense mixes; 2 crates `Apache-2.0 OR BSL-1.0` (BSL-1.0 is the Boost licence, not BUSL) | `results/contract-dep-licences.txt` (M, `cargo metadata --locked`) |

## 2. The VM

- **Create** (`vm.mjs create p3g-c3 c3 us-east4-a`, 04:41:07Z → rc 0 at 04:41:34Z):
  - c3-standard-4, `--confidential-compute-type=TDX`, image `p3g-dstack-0-6-1`, boot disk 10 GB;
  - data disk 20 GB pd-balanced and shared disk 1 GB, from images `p3g-data` and `p3g-shared-2`;
  - `--maintenance-policy=TERMINATE`, `--network=p3g-net --subnet=p3g-subnet`, `--no-service-account --no-scopes`.
  - These are the flags of dstack-cloud v0.6.1 (`dstack/scripts/bin/dstack-cloud` 1466-1476), on our own VPC.
  - Read back at 05:04Z: TERMINATED, TDX, onHostMaintenance TERMINATE, NIC on p3g-net only, no service account
    (`results/resources-final.txt`).
- **Network**: VPC `p3g-net` has one subnet, <private range>/24 in us-east4. Its only ingress rule is `p3g-allow-mac`: tcp
  8080 (app), 3338 (`mint`), 3339 (`mintt`) and 8090 (guest agent's public info), from `14.181.204.148/32`. That is the
  Mac's IPv4, read from 3 services at 03:41:51Z (`results/mac-ip.json`).
  - The project's `default` network, with Google's default 0.0.0.0/0 SSH/RDP/ICMP rules, was created at 2026-10-22
    01:57:43Z by project setup. It is not ours: p3g-c3 has no NIC on it. It was left as is.
- **The app**: `cvm/docker-compose.yml`. Three services, all on `node:24-alpine@sha256:44fce696…` with no environment
  entries:
  - `app` (P7 run 2's app plus `/v1/Attest`, `/Info`, the R15a probes and the P3g contract names);
  - `mint` (cdk-mintd v0.18.2 on `/seed/ckd.mnemonic`);
  - `mintt` (on `/seed/test.mnemonic`).
  - The `seed` volume is tmpfs (`size=1m,mode=0700`). The mint installer (P7 run 2's `mintScript`) downloads the v0.18.2
    release asset and refuses it unless sha256 = `0d33d68695f50f606df385bbb439862011fef73462df32d586ad014b8900c54f` = the
    SHA256SUMS line.
  - Both mints report `cdk-mintd/0.18.2` (M). The compose is measured: its sha256 is the attested compose hash, and the
    contract pins it.
- **Timeline** (`results/vm-events.jsonl`):

  | Event | Time (UTC) |
  |---|---|
  | app up, boot 1 | 04:42:17Z |
  | stop | 04:47:02Z to 04:49:26Z |
  | start | 04:49:32Z to 04:49:43Z (same ephemeral IP 35.245.160.32) |
  | app up, boot 2 | 04:50:20Z |
  | final stop | 04:54:03Z to 04:56:26Z |

## 3. Attestation

**TDX (M, `results/attest-c3-boot{1,2}.json`).** The quote is 8,000 B and its report_data is P3's
`SHA-512("ghost/v1/register" ‖ a_pk ‖ h_pk ‖ n_pk)`.

| | Boot 1 | Boot 2 |
|---|---|---|
| TCB status / advisories | **UpToDate** / [] | **UpToDate** / [] |
| FMSPC | 00806f050000 | 00806f050000 |
| PPID | b391ff59fda1bd9d7c4471d42830ef9c | b391ff59fda1bd9d7c4471d42830ef9c |
| PCK leaf serial | 7F1402E328503B098CE66C73FF3DA42912D5B2DC | same |
| TCB info issue / next update | 2026-10-22T04:04:54Z / 2026-11-21T04:04:54Z (eval #20) | same |
| MRTD | c1ee9c16…70a5 | same |
| quote sha256 (= TPM qualifying data) | 11580e69…60f1 | 285fdbac…1354 |
| dstack-verifier (bin sha256 fd5a26c4…) | is_valid, quote/event_log/os_image_hash verified, 4.9 s | same, 5.7 s |

- The verifier was built from the v0.6.1 tag on the Mac. The only patch is `results/verifier-mac-build.diff`, which stubs
  a Linux-only SEV-SNP ioctl that report generation uses and verification never does.
- It ran oneshot (`--verify`) with `insecure_allow_external_trust_anchors = false`.
- `acpi_tables_verified: false` is expected on GCP. The OS binding there is PCR0 (GCP OVMF) plus the PCR2 UKI event.
  The verifier sets that field only for TDX ACPI table contents.

**vTPM (M).**

- The TPMS_ATTEST is a quote (magic `ff544347`, type `8018`) over sha256 PCRs [0, 2, 14]. Its `extraData` = sha256(TDX
  quote) on both boots.
- PCR0 = `0cca9ec1…f802` (GCP OVMF; the contract pins it). PCR2 event 3 = the release UKI.
- PCR14 = replay of the 10 runtime events = `30397d05…2841`, the same on both boots.
- TPM `reset_count` went 4 → 5 across the stop/start.
- AK certificate: ECC P-256, serial `9A535871BEAEDEFC4B6040092BA7419E1C9D04`, sha256 `7a409ff7…a6c8`, valid 2026-10-22
  04:41:28Z to 2056-10-14. It has no CRL distribution point. Byte-identical on both boots.
- Chain:
  - AK ← "EK/AK CA Intermediate" (from the AK's AIA URL; serial `DB15BB6D380D0F2C0AC142005B7E5534ACA053`, sha256
    `a830449c…ac27`, valid 2026-05-19 to 2122-07-08, CRL DP = the root CRL);
  - Intermediate ← "EK/AK CA Root" (sha256 `594759…beb2`). `openssl verify` says OK.
  - This intermediate is newer than PG's `intermediate_v3` (`c84de811…`). The contract pins only the root and verifies
    whichever intermediate the AK names, so this did not matter.
- Root CRL (fetched fresh, 04:43:05Z and 04:50:46Z): 765 B, sha256 `bb053e65…a581`, thisUpdate 2026-10-22T01:12:26Z,
  nextUpdate 2026-10-29T01:12:26Z, signature OK, no revoked serials, intermediate not listed.

**Contract** (`contract/`; `wasm/p3g_ghost.wasm` 1,224,658 B, sha256 `5497662d…7e47`, code_hash `6hD9PzXe…vdQS` = on chain):

- Deploy tx `3BnSFkZyPqt7jvMYWYCqk5sXRivFy2ZxoBSydUwf6wzU`: CreateAccount + Transfer + Deploy + `new`, with no AddKey.
  Read back: 0 access keys, `accepted_tcb ["UpToDate"]`, `test_build false`.
- **Step 1 `register_tpm(tpm_quote, intermediate_pem, root_crl, runtime_events)`** (`src/lib.rs` 431-517):
  - the TPM quote must be from the GCP platform;
  - root CRL: signed by the pinned root, thisUpdate ≤ block time < nextUpdate, intermediate not revoked (E31);
  - dstack tpm-qvl at block time: quote, event-log replay, AK signature, AK → intermediate → pinned root (E30);
  - PCR selection [0, 2, 14] (E38), 32-byte qualifying data (E33), PCR0 = GCP OVMF (E34), PCR2 event 3 ∈ approved UKIs
    (E35), PCR14 = runtime-event replay (E36);
  - the AK's GCE identity names project 840692695115 / trenches-enclave-e0ff2c (E37);
  - then **one pending entry per caller**, keyed by the implicit account; a new call replaces it. The entry holds the
    digest, PCR14, block time, AK subject, GCE identity, UKI and the CRL hash and dates.
- **Step 2 `register(...)`** (`src/lib.rs` 519-616):
  - refused unless a pending entry exists (E40), is ≤ 10 min old (E41) and its digest = sha256(this TDX quote) (E42);
  - RTMR3's runtime events must replay to the pending PCR14 (E43);
  - then P3's `register` checks through shade-attestation `verify_with_policy`: dcap-qvl with collateral, the TCB rule
    UpToDate only (E10), report_data, RTMR3 replay, compose hash and the measurement allowlist (`add_measurements`
    tx `DJuakYohczhKZvSKkerRcvFLT8DELMu9Sf9JRhMGYTXm`);
  - the PPID allowlist is off (`None`); the vTPM step replaces it;
  - the pending entry is deleted. Both successful `register` txs show `get_pending` = null afterwards (M).
- Unit tests: 10/10 (`results/contract-unit-tests.txt`). They cover the E40/E41/E42 rules, the CRL window and a tampered
  signature or body, an unrelated CRL, GCE identity parse/missing, and the runtime replay against cc-eventlog. E41 was
  not run on chain (it needs a 10-minute wait).

**Gas** (testnet, `results/near-events.jsonl`; "total" = all receipts; meter = in-contract `env::used_gas` marks):

| Step | Tx | Total TGas | Contract receipt | Meter split (TGas) |
|---|---|---|---|---|
| register_tpm, boot 1 | `4o7DubQRDok6QEBF1x5KaoXHreyc77KCuRXGthCgKrVZ` | **132.32** | 131.45 | entry 2.66, root_crl 31.80, tpm_qvl 94.51, pcr_policy_uki_pcr14 0.36, **gce_identity 0.52**, store_pending 0.20 |
| register, boot 1 | `9qu1EuQ6WfeiJn9rM8DTkSeJ6z9FDS7pQcwFrQPsh4Ut` | **211.30** | 195.80 | entry 10.79, pending 0.84, rtmr3_events_vs_pcr14 0.27, shade_verify_dcap 179.66, store 9.83 |
| register_tpm, boot 2 | `6mtGep7q1NBp9WUwE4z63eQKX1hoBwGfgBHbXVJkYvF` | 132.33 | 131.46 | same split ±0.01 |
| register, boot 2 | `JAdtmijpRgtu298XNAAjFC2VN7oxLj44ikYWov8MEBmH` | 211.30 | 195.81 | same split ±0.01 |
| register before step 1 (refused **E40**) | `6jn34Gs7gZKJGpgpEHWipmB5fW8UHg9zMeM6Wi6uA2xp` | 20.84 | 12.87 | |
| register, boot-1 quote with boot-2 pending (refused **E42**) | `33fYCxDX8YCoCsBviFes7v7G7y37VcpTJJUS6GzcwaFy` | 20.87 | 12.90 | |
| request_key, boot 1 / boot 2 | `Edi3dA4bc2NYdtGkkybnjTumas6yhKXhzRw6DCCJCTdq` / `Bz8TeDerLKYis1vW1RMBmYuAGLajmsHrMMZui1amYLLQ` | 20.36 / 20.36 | 3.54 | |

- Args are 11,785 B for step 1 and 160,712 B for step 2. Both steps fit the 300 TGas cap, with 168 and 89 TGas of
  headroom.
- PG's sandbox numbers were 126.7 and 181.7 (I: the differences come from the added PCR14/GCE checks, P3's register
  work, and testnet's per-byte argument cost).
- Other testnet txs:
  - funding: faucet `GJRsAuhLnGEd4rDBMTe1rN369XnwedqXKCP7YEwb5m6z` and `BwYWLuQww1w8b7tpjuv9bcUuiESZt3GNPrtBuniCQ3WX`;
  - n funding `FisB16W6qBaLK8uw96s5KEb4vnqdCxeWNLfEtEWncWWh` and `4NeGGoNRvjHUSJM1xcaWqU4FKFGgTeajRKCxwVZ1yZXy`.
- The JS views in `near-events.jsonl` print `instance_id` as `7627989056050441000` because of JS number precision. The
  contract stores the u64 7627989056050441480 (I: Rust u64; the AK subject string next to it carries the exact digits).
- **C4 / test flag:** not needed. `wasm/p3g_ghost_tcbtest.wasm` (feature `tcb-test-accept-observed`) was built and never
  deployed. No C4 VM was created.

## 4. Stop/start of the C3 VM (M)

| | Boot 1 (04:42Z) | Boot 2 (04:50Z) |
|---|---|---|
| PPID / PCK serial | b391ff59fda1bd9d7c4471d42830ef9c / 7F1402E3… | **same / same** |
| AK certificate sha256 | 7a409ff7…a6c8 | same |
| app_id / compose hash | 7c81cb60…02e6 / 7c81cb60…fe81 | same |
| instance_id | 8a9bdae8a935ac5e4f3af738672958984d2311d6 | same |
| MRTD, RTMR0-2, PCR0/2/14 | (§3) | same |
| sealed seed | "no sealed seed found, generating new seed" (serial boot 1, line 626) | "unsealed root key seed from TPM (PCR policy: sha256:0,2,14)" (serial boot 2, line 609) |
| data disk | LUKS created | "LUKS header detected on /dev/nvme0n2p1", opened, "recovering journal" (lines 613-621) |
| app `boots.log` on the encrypted disk | 1 boot | 2 boots (persisted) |
| `/seed` at boot | empty (tmpfs) | empty (tmpfs) |
| CKD root S fingerprint | a3b7da4bc99b1592 | **a3b7da4bc99b1592** |
| `mint` keyset | 01b29af2…641b | **same, all 32 keys equal** |
| per-boot key n | 76bc0e2f… | 6f3849e3… (new, as designed) |

- `instance_id` = sha256(seed ‖ app_id ‖ AK binding)[..20] (D: `dstack-util/src/system_setup.rs:2950-2963`; serial:
  "mixing platform per-instance binding into instance_id"). It is stable because `.instance_info` carries a fixed
  `instance_id_seed` and the AK did not change.
- One stop/start kept the host's PPID. Whether a later stop/start or host maintenance does is UNKNOWN (one sample).

## 5. P7 row 1, items 1-4 (M)

1. **The pinned mint runs in the CVM, seeded from CKD inside it.**
   - At 04:45:50Z the app derived S from the MPC response (`request_key` tx `Edi3dA4b…`, read from 2 agreeing RPCs) and
     wrote `/seed/ckd.mnemonic`. Mode 400, on a 1 MB tmpfs that was empty at boot.
   - `mint` then started on it. The app's env names are only `HOME HOSTNAME NODE_VERSION PATH PWD SHLVL YARN_VERSION`, and
     the compose has no env entries.
   - Evidence: `results/status-c3-boot1-ckd.json`.
2. **`mintt` = P7's local run.** Keyset `01ae7231ab72cc6e39cf75975539c697d9c103a59bda20796c24dba038229fa1fe`, 32
   denominations, `keys_differing: []` (`results/keys-compare.json`).
   - The CKD mint's keyset `01b29af2…641b` shares 0 keys with it, as it should.
3. **Round trip from the Mac with P7's client** (`p7client/roundtrip.ts`, P7 run 2's file with only paths changed):
   - steps on each mint: deposit 2000 → swap 700 → ghost melt 1000 (fee 1) → token states (13 held UNSPENT, 12 SPENT);
   - 37 DLEQ proofs checked; `pass: true` (`results/roundtrip-c3-{mint,mintt}-boot1.json`).
   - The CKD keyset is not on NEAR's published list. P7's rule records that, and the run continued pinned to the keyset
     id, as P7 did.
4. **The restart keeps the keyset.** Both mints answered after boot 2 with the same keyset id and all 32 keys. The
   earlier notes' states held, and a new 500 deposit worked (`results/roundtrip-c3-{mint,mintt}-boot2.json`,
   `keys-compare.json`).

## 6. team lead M162 reads

**Q1. Our VM's AK certificate (M).**

- Subject: `L=us-east4-a, O=Google Compute Engine, OU=trenches-enclave-e0ff2c, CN=7627989056050441480`.
- Extension 1.3.6.1.4.1.11129.2.1.21 is present. Parsed: zone `us-east4-a`, project_number `840692695115`, project_id
  `trenches-enclave-e0ff2c`, instance_id `7627989056050441480`, instance_name `p3g-c3`.
- The extension's trailing field, raw: `a020301ea003020100a1030101ffa2030101ffa303010100a403010100a503010100`. That is
  `[0] 0`, `[1] TRUE`, `[2] TRUE`, `[3..5] FALSE`. I read this as Google's security properties (version 0, is_production
  true, …), per go-tpm-tools' struct order (I).
- `gcloud projects describe trenches-enclave-e0ff2c --format='value(projectNumber)'` = 840692695115 (M), so they are
  equal.
- The contract checks both project number and id in step 1 (E37, `src/lib.rs` 488-491), and step 1's gas above includes
  that check (0.52 TGas).
- Files: `results/attest-c3-boot1.json` (`ak_cert`), `results/ak-chain-c3-boot1.pem`.

**Q2. Sealed config input without KMS (D, with M from the serial log).** There is none: a `tpm` boot has no sealed
vendor blob.

- What a `tpm` boot reads from the host is the shared disk. `system_setup.rs:305-320` copies `app-compose.json` (50 MB
  cap), `.sys-config.json`, `.instance_info`, an optional `.encrypted-env` and an optional `.user-config` (50 MB, line
  316).
- The compose is measured (compose-hash event). `.instance_info` feeds the measured `instance-id` event.
- An encrypted env needs a key from the key provider:
  - `decrypt_env_vars` fails with "encrypted env is present but the key provider gave no valid env crypt key"
    (`system_setup.rs:3131-3150`);
  - the TPM provider's keys come from `gen_app_keys_from_seed`, which sets `env_crypt_key: vec![]`
    (`dstack-util/src/main.rs:1179-1232`, via `generate_tpm_app_keys`, `system_setup.rs:2443-2477`);
  - the host CLI refuses a `.env` unless the key provider is KMS (`dstack/scripts/bin/dstack-cloud:1619-1625`);
  - our serial logs show "No encrypted env, using default" (boot 1 line 655, boot 2 line 641; M).
- `.user-config` is linked as `/dstack/user_config` (`system_setup.rs:3225`) and is **not measured**. dstack's docs say
  an app must authenticate it itself (`docs/encrypted-env-spec.md:465-468`; `docs/security/security-best-practices.md`,
  "Authenticated envs and user_config").
- The only secret a `tpm` boot holds is the TPM-sealed root seed, sealed to sha256 PCRs 0, 2 and 14
  (`tpm-attest/src/lib.rs:30-55`). Our app takes its secret S from NEAR MPC CKD at runtime, after the on-chain
  registration.
- I: a confidential config must come in after attestation, like S, or be signed and checked by the app. The host can
  swap `.user-config` freely.

## 7. team lead R15a reads

**1. PCR14 in the running app (M; `results/tcg-eventlog-c3-boot{1,2}.{bin,json}`).**

- The full firmware TCG2 event log was read from the running app through a read-only bind of the host's securityfs.
  - 29,812 B, sha256 `243b0ea7…f6bb`, byte-identical on both boots.
  - Spec ID Event03 with sha1/sha256/sha384 banks.
  - Events per PCR: {0: 5, 1: 9, 2: 4, 3: 1, 4: 2, 5: 3, 6: 1, 7: 6, 9: 2, 11: 12}. The sha256 replay equals the quoted
    PCR0 and PCR2. The log equals the event log inside dstack's TPM quote.
  - **PCR14 has no firmware events.**
- Every PCR14 event comes from dstack's runtime log. Type 0x08000001, in order: `system-preparing` (empty), `app-id`
  (`7c81cb60…02e6`), **`compose-hash` (`7c81cb60…fe81`)**, `gpu-policy-hash` (`44136fa3…ff8a`), **`instance-id`**
  (`8a9bdae8…11d6`), `boot-mr-done`, **`key-provider`** (`{"name":"tpm","id":""}`), `storage-fs` (`ext4`),
  `storage-encrypted` (`1`), `system-ready`.
  - Each event's sha256 digest and the running PCR14 after it are in the JSON. The replay equals the quoted PCR14
    `30397d05…2841`.
  - D: `dstack-attest/src/lib.rs:190-224` extends each runtime event into RTMR3 (sha384) and the platform's TPM PCR. For
    `DstackGcpTdx` that is (14, sha256) (`dstack-types/src/lib.rs:1351-1357`).
- **So yes:** dstack v0.6.1 on GCP extends app-id, compose hash, instance-id and key-provider into PCR14.
  - The compose hash in PCR14 equals RTMR3's `compose-hash` event in the same boot's TDX quote, whose RTMR3 replay
    equals the quote.
  - Both equal sha256 of the repo's `cvm/shared/app-compose.json` (M, both boots).
  - The contract enforces the link (E36 in step 1, E43 in step 2).
- **Can a container quote arbitrary qualifying data?**
  - Our app container: no `/dev/tpm*` nodes (`tpm_probe.dev_tpm_nodes: []`, M). Our compose has no `privileged` or
    `devices` entry.
  - Through the guest agent (`/var/run/dstack.sock`): a TPM quote is made only with qualifying data = sha256(TDX quote)
    (D: `dstack-attest/src/attestation.rs:2247-2257`). The TDX report_data is the caller's, so a container can bind its
    own data only through the TDX quote. That is the binding our contract checks.
  - Raw 32-byte qualifying data is accepted only by the guest-OS CLI `dstack-util` (D: `dstack-util/src/main.rs:1488-1503`).
    That needs root on the guest OS, or a container given the TPM device.
  - Apps cannot add runtime events: v0 `EmitEvent` bails, "runtime RTMR3 events are system-owned"
    (`guest-agent/src/rpc_service.rs:697-701`).
  - dstack has **no compose policy against `privileged: true` or `devices:`**. `verify_app_compose_policy`
    (`system_setup.rs:1013-1046`) checks only `requirements`. dstack's own doc warns that "privileged code inside the
    CVM can append additional measured events after boot" (`docs/security/security-best-practices.md:195`).
  - I: the guard is the pinned compose hash. A compose granting the TPM device or privileged mode has a different hash
    and is refused by `add_measurements`' allowlist. Reviewers must read the compose.
- The R15a probe itself is a read-only mount of `/sys/kernel/security` into `app`, visible in the measured compose. It
  exposes only the public firmware log. I: drop it from the production compose.

**2. AK chain (M; `results/ak-chain-c3-boot1.pem` = AK + intermediate + root; `results/root-crl-c3-boot1.crl`).**

- AK (issuer CN=EK/AK CA Intermediate) ← intermediate serial `DB15BB6D380D0F2C0AC142005B7E5534ACA053` (issuer CN=EK/AK
  CA Root) ← root DER sha256 **`594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2`** (2022-07-08 to
  2122-07-08).
- This is the **2022 chain, not the 2018 one**. `openssl verify -CAfile root -untrusted intermediate ak` gives OK.
- The OID 1.3.6.1.4.1.11129.2.1.21 extension is present, and its project number equals the project's (840692695115).

**3. Step 1's gas with the project check (M).** The testnet `register_tpm` already checks it, at 132.32 TGas total and
0.52 TGas for the GCE identity parse and compare. team lead need not add a cost.

## Spend and resources left

- **Spend** (`results/spend.jsonl`, an upper-bound estimate by `spend.mjs` from `results/spend-plan.json` list prices):
  **$0.13**, made up of 0.254 VM-hours × ($0.2225 C3+TDX + $0.005 IPv4), disk existence at $0.15/GB-month, and $0.07
  flat allowances for images, bucket and egress.
  - No budget is set on the billing account (read 03:42Z). The billed figure is UNKNOWN until Google's billing report
    shows it.
  - NEAR testnet only; no mainnet tx. The funder now holds 7.98 N and the contract 12.76 N, all testnet.
- **Left in the project** (read 05:04Z, `results/resources-final.txt`; idle prices are list prices, I):

| Resource | State | Idle cost / month |
|---|---|---|
| VM `p3g-c3` (c3-standard-4, TDX, us-east4-a) | TERMINATED | $0 compute (no static IP; the ephemeral IP is released) |
| Disks `p3g-c3` 10 GB, `p3g-c3-data` 20 GB, `p3g-c3-shared` 1 GB (pd-balanced) | READY, attached to p3g-c3 | ≈ $3.1-3.4 (31 GB × $0.10-0.11), plan upper bound $4.65 |
| Images `p3g-dstack-0-6-1` (archive 616,940,864 B), `p3g-data`, `p3g-shared`, `p3g-shared-2` | READY | ≈ $0.05 (0.62 GB × $0.085) |
| Bucket `gs://p3g-trenches-enclave-e0ff2c` (4 objects, 587 MiB, us-east4) | | ≈ $0.014 |
| VPC `p3g-net`, subnet `p3g-subnet`, firewall `p3g-allow-mac` | | $0 |
| **Total idle** | | **≈ $3.2-3.5 / month (upper bound ≈ $4.72)** |

`p3g-shared` (compose `8ad2ef66…`, before the R15a probe) is superseded by `p3g-shared-2`. It is kept, not deleted.

## Not verified (UNKNOWN)

- Whether the PPID survives other stop/starts or host maintenance (one sample: kept).
- `is_dev` inside the image's `metadata.json` (not in the UKI tarball; see §1).
- A revoked intermediate or AK on chain. The live CRL lists nothing, and AK certs carry no CRL DP. The contract's
  revocation path is unit-tested only with tampered and unrelated CRLs.
- E41 (pending > 10 min) on chain. It is unit-tested only.
- The actual billed amount (no billing export; the estimate above is an upper bound).
- The field names of the GCE extension's trailing security-properties field (raw bytes recorded).

## Rerun

From `proofs/p3g`. Spending steps are marked; each one logs itself to `results/spend.jsonl`. The whole live run took
0.25 VM-hours.

```sh
H="~/Downloads/NEAR trading terminal/scripts/the build queue"
# 0. Downloads (vendor-dl/, untrusted, sha256-checked): dstack tag v0.6.1 source and the OS release asset
git -C vendor-dl/dstack-src-v0.6.1 rev-parse HEAD                     # 7f143148cc49f4a09799958835d310e050137cb3
shasum -a 256 vendor-dl/os-v0.6.1/dstack-0.6.1-uki.tar.gz             # 42ce3692…5fa8 = image-hashes.txt
# 1. Verifier (Mac): apply results/verifier-mac-build.diff to the v0.6.1 tree, then
(cd vendor-dl/dstack-src-v0.6.1/dstack && CARGO_TARGET_DIR="$PWD/../../target-verifier" "$H" p3g -- cargo +1.92 build --release --locked -p dstack-verifier --bin dstack-verifier)
# 2. Contract: wasm (both builds) and unit tests
"$H" p3g -- contract/build.sh
(cd contract && "$H" p3g -- cargo test --locked)                       # 10 passed
# 3. Disks and images (one-off; images exist): node cvm.mjs render; node cvm.mjs disks [boot|shared|data];
#    ./g.sh storage cp out/disks/<n>.tar.gz gs://p3g-trenches-enclave-e0ff2c/<n>.tar.gz
#    ./g.sh compute images create <n> --source-uri=gs://… --guest-os-features=… --storage-location=us-east4
# 4. VM (SPENDS): start the stopped VM, wait for the app
node vm.mjs start p3g-c3 c3 us-east4-a && node vm.mjs wait "$(node vm.mjs ip p3g-c3 us-east4-a)"
IP=$(node vm.mjs ip p3g-c3 us-east4-a); B=boot3; L=c3-$B
# 5. Attestation + event log (Intel PCS, Google CA hosts, dstack-verifier oneshot)
node attest.mjs $IP $L && node eventlog.mjs $IP $L
# 6. Chain (testnet; contract already deployed): fund n, step 1, step 2, CKD
C=p3g-ghost.p2ckd-be9844bc.testnet
node chain.mjs fund $L && node chain.mjs register-tpm $IP $L $C && node chain.mjs register $IP $L $C && node chain.mjs request-key $IP $L $C
# 7. P7 checks from the Mac
(cd p7client && node roundtrip.ts c3-mint-$B http://$IP:3338 --after c3-mint-boot1 && node roundtrip.ts c3-mintt-$B http://$IP:3339 --after c3-mintt-boot1 && node compare-keys.mjs c3-mintt-boot1 c3-mint-boot1 c3-mint-$B)
# 8. Stop (always)
node vm.mjs stop p3g-c3 c3 us-east4-a
```

- A fresh deploy is `node chain.mjs deploy real`, then `node chain.mjs measurements <contract> <label>`. Pass no key
  material; `near.mjs` loads the P2 testnet funder key file by path.
- The root CRL's nextUpdate is 2026-10-29T01:12:26Z. `attest.mjs` fetches it fresh each run. The contract refuses an
  expired CRL (E31).

## Files

- Scripts:
  - `g.sh` (gcloud wrapper, pinned project, log);
  - `spend.mjs` (spend log and estimate);
  - `cvm.mjs` (compose render, disks);
  - `vm.mjs` (create/start/stop/serial/wait);
  - `attest.mjs` (attestation, Intel PCS, AK chain, CRL, verifier, contract args);
  - `eventlog.mjs` (TCG2 decode, PCR14);
  - `chain.mjs` (testnet txs);
  - `verifier.toml`;
  - `p7client/` (P7 run 2's client, paths changed).
- CVM: `cvm/app.mjs`, `cvm/docker-compose.yml`, `cvm/shared/{app-compose.json,.sys-config.json,.instance_info}`.
- Contract:
  - `contract/src/lib.rs`, `Cargo.toml`, `Cargo.lock`, `build.sh`;
  - `shade-attestation/` (NEAR's 0.2.0 with `shade-attestation.p3g.diff`);
  - `certs/gcp-ek-ak-ca-root.der`, `testdata/`;
  - `wasm/p3g_ghost.wasm` (deployed), `wasm/p3g_ghost_tcbtest.wasm` (test only, never deployed).
- Evidence (`results/`):
  - attestation: `attest-*`, `attestation-*.hex`, `verifier-*`, `args-*`;
  - TPM and serial logs: `tcg-eventlog-*`, `ak-chain-c3-boot1.pem`, `root-crl-c3-boot1.crl`, `serial-*`;
  - app and mints: `status-*`, `roundtrip-*`, `keys-compare.json`;
  - chain: `near-events.jsonl`;
  - cloud and spend: `vm-events.jsonl`, `gcp.log`, `spend*.json*`, `resources-final.txt`, `disks.json`, `mac-ip.json`;
  - contract: `contract-unit-tests.txt`, `contract-dep-licences.txt`;
  - verifier build: `verifier-mac-build.diff`.
