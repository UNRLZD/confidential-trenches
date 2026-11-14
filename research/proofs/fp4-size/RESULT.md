# FP-4 Phala size compare (FD-S-08): result

This proof ran on 2026-10-21 from 04:55Z to 05:08Z on Phala Cloud (Intel TDX, dstack). Every time below is UTC and
was read from `date -u` or from a log line. The records are in `results/`. It answers G1 row 37 (10 §7; P11 §6 FP-4)
for 08 CD2.

**Size changes the measurement set: yes; size changes the PPID: no**

Of the six values in the set {MRTD, RTMR0-2, key_provider_event_digest, app_compose_hash_payload} (06a §2.5 item 4),
only **RTMR0** changes with the size. The other five are the same at all three sizes. The PPID is the same at all
three sizes, because all three ran on the same machine (prod5). So each size the enclave may run at needs its own
measurement set on the allowlist, and the sets differ only in RTMR0.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | One image, three sizes, one node | **Done** | P3's compose byte for byte, `dstack-0.6.1`, `node_id: 5` (prod5) for tdx.small, tdx.medium and tdx.large. All three were offered on prod5 (16 vCPU and 32 GB free at 04:55Z), so no size had to move to another node |
| 2 | Measurement set per size | **RTMR0 differs**, the rest is the same | Quotes verified (`UpToDate`, no advisories), RTMR3 replayed, compose hash checked: `results/attest-*.json`, `results/compare.json` |
| 3 | PPID per size, from the API and from the quote | **Same** `3e306e133b7fdaa7bb79f67634cb520c` | `node_info.ppid` equals the PCK certificate's PPID in every quote, and equals P3's |
| 4 | Deploy → running | 50.8 s, 43.9 s, 51.5 s | `results/events.jsonl` |

Phala credit: **$4.904109** at 04:55:48Z (start) and **$4.904109** at 05:04:51Z (end), and still $4.904109 at 05:07:58Z. The credit used that shows is
**$0.000000**. The account is post-paid and each record says `billing_interval: hourly`, so a charge can still land
later. From the API's `hourly_rate.total` and each CVM's lifetime (75.0 s, 69.6 s, 81.4 s), the run costs about
$0.0089 if Phala bills by the second, and at most **$0.41434** if it bills a whole hour per CVM. Both are under the
$0.50 stop line. **CVMs at the end: 0** (`GET /cvms/paginated` total 0 at 05:04:51Z and 05:07:58Z; there were 0 at the start too).

## 1. The table

One row per size. Hex values are cut to 8 characters here; the full values are below the table and in
`results/compare.json`. **Bold** marks the values that differ between sizes.

| Size | vCPU / memory (API) | Guest `vm_config` | Node | OS image | MRTD | **RTMR0** | RTMR1 | RTMR2 | **RTMR3** | Key-provider digest | Compose hash | PPID (quote PCK cert) | PPID (API) | Deploy → running | Deploy → serving |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tdx.small | 1 / 2 GB | `cpu_count` 1, `memory_size` 2,147,483,648 | prod5, node_id 5 | dstack-0.6.1, `ec43cb8c` | `2a674327` | **`68102e7b`** | `89ef86c5` | `e9000e33` | **`5d350787`** | `83368b43` | `c9b4738f` | `3e306e13` | `3e306e13` | 50.8 s | 52.1 s |
| tdx.medium | 2 / 4 GB | `cpu_count` 2, `memory_size` 4,294,967,296 | prod5, node_id 5 | dstack-0.6.1, `ec43cb8c` | `2a674327` | **`027b610a`** | `89ef86c5` | `e9000e33` | **`b11acdc5`** | `83368b43` | `c9b4738f` | `3e306e13` | `3e306e13` | 43.9 s | 45.7 s |
| tdx.large | 4 / 8 GB | `cpu_count` 4, `memory_size` 8,589,934,592 | prod5, node_id 5 | dstack-0.6.1, `ec43cb8c` | `2a674327` | **`fb14dc13`** | `89ef86c5` | `e9000e33` | **`0228a12b`** | `83368b43` | `c9b4738f` | `3e306e13` | `3e306e13` | 51.5 s | 53.6 s |

- **The values that differ:** RTMR0 (in the set) and RTMR3 (not in the set; see §2). All the others are the same at
  all three sizes, and the tdx.small row equals P3's boot 1 of 2026-10-20 in every set value and in the PPID.
- **Full values that are the same at all three sizes:**
  - MRTD `2a674327c50218dba880066b349b8d559d749ed68dce33fd651c184a877d084b07a9e583767a7ad5da13ed91deec2b70`
  - RTMR1 `89ef86c5125b986c325f0a94acfa87718a4ef3a4d4f237dbb72dda3cf777fd2c054555fb4407eb53338d7d67329a7333`
  - RTMR2 `e9000e338f33233e8f51b7fd031e1c158bdcf8572eab041c0bc8eb7fef48b23259a6a556e6c8e2af99999fc39c793179`
  - key-provider event digest `83368b43a0fc6f824f5a9220592df85fd30e2d405ecbd253a5c6354af63e6c9b41aec557c38a38e348ab87f9ac8fc68c`
    (payload `{"name":"kms","id":"3059…"}`, Phala's KMS key, `kms.dstack-pha-prod7.phala.network`)
  - compose hash `c9b4738fba83b998c3e3a77f2cc3cfc4d089cc1e269f3210cf6dd00b378ff33b` (equal to each provision
    response's `compose_hash`; Phala's `pre_launch_script` sha256 `98218161…5ffe8`, as in P3)
  - OS image hash `ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6` (API `os` record, `tcb_info`
    and `vm_config` agree)
  - PPID `3e306e133b7fdaa7bb79f67634cb520c`, from `node_info.ppid` and from the PCK leaf certificate in each quote
    (OID 1.2.840.113741.1.13.1.1; leaf issuer Intel SGX PCK Platform CA)
- **RTMR0 per size** (the values a size approval would add):
  - tdx.small `68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96`
  - tdx.medium `027b610ab0555482f8a3868524093bdf3cdbe2539f81dfeeb886864654cb2fe3422f7fc36d4bab6fa46683aad11d1ba7`
  - tdx.large `fb14dc139f33d6fcf474bc8332cac001259fb31cfbcb6b34d4ceeb552a2c4466884a0cbde45ad98a05c5c060c23ad65a`
- **RTMR3 per size** (replayed from the event log and equal to the quote at every size):
  `5d350787…e915`, `b11acdc5…b86b`, `0228a12b…ce04`.
- Each boot passed the same checks as P3's `attest.mjs`: TCB `UpToDate` with no advisories, `report_data` binds
  (a_pk, h_pk, n_pk), the quote's MRTD and RTMR0-2 equal `tcb_info`, RTMR3 replays, the compose hash is
  sha256(app_compose) and equals its event, one key-provider event, TD debug bit 0, and the PPID in the quote equals
  the API's. Collateral came from `pccs.phala.network` in 2.4-2.9 s.
- The vCPU and memory come from two reads: the API record (`resource.vcpu`, `resource.memory_in_gb`) and the guest's
  own `vm_config` from `GetQuote` (`cpu_count`, `memory_size`). Disk was 20 GB at every size. The guest CPU model
  was family 6 model 0xAF at every size, and the node's VMM was `v0.6.0 (git:96583b6d6a5116c86be9)`.

## 2. Why RTMR0 differs, and why the rest does not

RTMR0 is the firmware's record of the virtual machine it was given, and the size is part of that machine. Lining up
the three event logs shows that exactly four RTMR0 events differ, and no RTMR1 or RTMR2 event does
(`results/compare.json` `imr0_2_events_that_differ`):

| Event | What it measures | small | medium | large |
|---|---|---|---|---|
| 0, `EV_EFI_HANDOFF_TABLES2` (0x8000000B) | The TD HOB: the guest memory map | `0b8772e5` | `5b684faf` | `2e070cda` |
| 8, `acpi-loader` | QEMU's ACPI table loader | `39740da2` | `095d04cf` | `331d1d48` |
| 9, `acpi-rsdp` | The ACPI RSDP | `6385b89d` | `8d9a4d47` | `4ec75e37` |
| 10, `acpi-tables` | The ACPI tables | `05705c3c` | `3070721e` | `557cc395` |

dstack's own measurement code says the same. These citations are dstack v0.6.1 (tag `v0.6.1`, commit
`7f143148cc49f4a09799958835d310e050137cb3`), the release whose OS image these CVMs ran:

- RTMR0's log is the TD HOB hash, computed from `memory_size`, plus the hashes of the ACPI loader, RSDP and tables,
  which `machine.build_tables()` generates (`dstack/dstack-mr/src/tdvf.rs:502-519`). The TD HOB is built from the memory
  size (`tdvf.rs:522-523`), with a different memory layout at 0xB0000000 bytes and above (`tdvf.rs:580`). The log's
  order is TD HOB first and the three ACPI hashes at positions 8-10 (`tdvf.rs:51-89`), the same positions that differ above.
- The ACPI tables are built from `cpu_count` and `memory_size` (`dstack/dstack-mr/src/acpi.rs:34-35`). The MADT has one
  entry per vCPU (`dstack/crates/qemu-acpi/src/fixed_tables.rs:103-113`), the DSDT has one processor object per vCPU
  (`dstack/crates/qemu-acpi/src/dsdt/cpus.rs:256`), and the FADT takes the CPU count (`dstack/crates/qemu-acpi/src/generated_tables.rs:15`).
- MRTD measures only the firmware's pages, by the two-pass or single-pass order (`tdvf.rs:403-412`). The quote's MRTD
  equals the `two_pass` value in the image's own measurement record (`vm_config.tdx_measurement`, read in each quote
  response).
- RTMR1's first event is the kernel's Authenticode hash. QEMU's patching of the kernel header would make it depend
  on the memory size, but this image's OVMF normalizes the header first. In that case dstack measures the kernel file
  itself, "on every QEMU version and at every guest memory size" (`dstack/dstack-mr/src/kernel.rs:257-265`,
  `kernel.rs:281`). The image's measurement record says `kernel_header_normalized: true`, and RTMR1's first event
  digest equals its `kernel_authenticode` `573d7f9b…18a5` at all three sizes.
- RTMR2 is the kernel command line and the initrd (`dstack/dstack-mr/src/machine.rs:155-160`). Neither has a size in it.
- The key-provider digest is the KMS key, and the compose hash is the compose. Neither has a size in it.
- RTMR3 differs because each new CVM gets a new `app-id` and `instance-id`. These are the only two RTMR3 events whose
  payloads differ; `compose-hash`, `os-image-hash`, `key-provider` and the rest are the same. RTMR3 is not in the set:
  the contract replays it from the event log (06a §2.5 item 4).

The PPID is not a property of the VM. It sits in the PCK certificate of the physical platform, so on one machine
it is the same at every size. A different machine has a different PPID (P3 §4).

## 3. How the boots were run

- **Image.** `size.mjs` sends P3's `cvm/compose-file.json` (sha256 `f08a0a2c…b206`) unchanged. Before each provision it
  checks that its `docker_compose_file` equals P3's `cvm/docker-compose.yml` (sha256 `2844aec9…a268`) and that the app
  embedded in it is P3's `cvm/app.mjs` (sha256 `46ab18af…feb1`). Phala's record shows the same
  `docker_compose_hash` and `pre_launch_script_hash`. OS image `dstack-0.6.1`, `key_provider: kms`.
- **No B2.** P3's scoped B2 key was deleted on 2026-10-20, and this proof does not use B2. The encrypted env carries
  `P3_CTL_TOKEN` and empty `B2_KEY_ID` and `B2_APP_KEY` values. The env is not part of the compose, so the compose hash
  stayed equal to P3's. The app needs B2 only for `/b2bench`, which this proof never calls.
- **No NEAR.** The app holds the test contract's name in its compose. No tx was signed or sent.
- **One at a time.** Each size was booted, read and then deleted before the next one was created (CVM ids
  `cvm_Zj9bL8eV`, `cvm_EKB4Vdjl`, `cvm_pjgAEJKB`). Each delete returned 204, and the CVM left the list within 18-20 s.
- **Deploy → running** is from `POST /cvms` to the first `running` status, polled every 5 s, so each value is good to
  about 5 s. **Deploy → serving** is until the app answered `/health` with a ready quote through the gateway.
  In the app: quote 1,064.5-1,095.0 ms, attestation ready 2,190-2,212 ms after the process started.

## 4. Not shown

- **An in-place resize.** Each size was a fresh CVM on a pinned node. Phala's resize of a running CVM was not tested,
  so whether a resize keeps the CVM on the same machine (and so its PPID) is not shown.
- **Other sizes and other nodes.** Only tdx.small, tdx.medium and tdx.large were booted, and only on prod5. From the
  source in §2, every (vCPU, memory) pair gives its own RTMR0. The ACPI build also takes the QEMU version and other
  `vm_config` fields (here `qemu_version` 8.2.2, `pic` true, `hotplug_off` false, `pci_hole64_size` 0, no GPUs), so a
  machine with a different QEMU could give another RTMR0 at the same size. That was not tested; the standby machine's
  set is best read from a boot there, as CD2 already does for its PPID.
- **The final charge.** The credit had not moved by 05:07:58Z (post-paid, hourly billing; see the bound above).

## Files

- `size.mjs` boots one size on one node, saves the API record and the verified quote, and deletes the CVM (it also
  deletes on SIGINT, SIGTERM and SIGHUP, and refuses to create once the run has used $0.50). `compare.mjs` builds
  `results/compare.json` and the table above. `credits.mjs` reads the credit and the CVM list, and `read-api.mjs` saves
  one read-only API GET.
- `lib.mjs` imports P3's helpers unchanged: `phala.mjs` (the API key is loaded from `~/.confidential-trenches/env` and
  never printed), `cvm.mjs` (env encryption, control token, gateway calls), `attest.mjs` (collateral, PCK-certificate
  PPID, RTMR3 replay) and P3's `@phala/dcap-qvl` 0.6.3. Nothing in `proofs/p3-enclave` was edited.
- `results/`: `events.jsonl` (every step, with times), `cvm-<size>.json` (`GET /cvms/{id}`), `attest-<size>.json`
  (quote hex, event log, `vm_config`, guest info, the set, both PPIDs, checks, timings), `compare.json`,
  `credits.jsonl`, `api-teepods-available.json` and `api-instance-types.json` (the node list and Phala's size table, with
  hourly rates).
- In the records, the long compose text is kept as its sha256 and length. The `workspace` and personal fields are
  dropped, and so is the encrypted env. Phala's KMS public key in `compose_file.key_provider_id` is kept as its sha256
  `99f738bc…ad07`, as P3 keeps it (the same value as P3's). Two public values tripped gitleaks' generic-api-key rule
  (that key, and the PPID under a key named `api…`), so after the run the same rules now in `size.mjs` were applied
  to the saved records: the key hashed, and the PPID fields renamed to `cvm_record_node_info` and `cvm_record`. No
  value was changed. `attest-*.json`'s `api_vcpu` and `api_memory_mb` are empty: the script read the
  create response's field names, and `GET /cvms/{id}` keeps them under `resource`. The table takes them from
  `cvm-<size>.json`.

## Reproduce

```sh
cd proofs/p3-enclave && npm ci && cd ../fp4-size     # fp4-size runs on P3's helpers and node_modules
node credits.mjs start
node read-api.mjs /teepods/available teepods-available && node read-api.mjs /instance-types instance-types
node size.mjs tdx.small 5 small && node credits.mjs after-small
node size.mjs tdx.medium 5 medium && node credits.mjs after-medium
node size.mjs tdx.large 5 large && node credits.mjs after-large
node compare.mjs small medium large
node credits.mjs end                                  # credit and CVM count; expect 0 CVMs (a later read: node credits.mjs final)
```

Needs `PHALA_CLOUD_API_KEY` in `~/.confidential-trenches/env` and P3's control token in
`~/.confidential-trenches/keys/p3-ctl-token.json`. `size.mjs` needs the start row that `credits.mjs start` writes.
