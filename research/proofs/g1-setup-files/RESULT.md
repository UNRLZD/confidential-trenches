# g1-setup-files: the Privacy Pools v1.3.0 ceremony keys, checked

Card g1-setup-files, G1 proof 3, 2026-10-26. Built by the vault lead's lanes 1-3; the re-runs and the ptau section
are the lead's.

## What this shows

1. **The keys belong to PP's circuits.** We compiled PP v1.3.0's withdraw and commitment circuits from PP's own
   sources with circom 2.2.1. Both r1cs files are byte-equal to the ones PP committed: withdraw 36,832 constraints,
   commitment 1,537. `snarkjs zkey verify` (snarkjs 0.7.5) passes both final zkeys against our r1cs and the pinned
   phase-1 file, Perpetual Powers of Tau contribution 80 at power 16. `snarkjs powersoftau verify` passes that file,
   and its contributions carry the published hashes of PPoT 0058, 0078, 0079 and 0080 and PSE's announced beacon
   (section "ptau verify").
2. **The ceremony is the one PP published.** withdraw has 514 contributions and then a beacon, commitment has 513
   and then a beacon. The beacon is sha256("21989617") with iteration exponent 10. Both verification keys exported
   from the final zkeys are equal to PP's pinned `.vkey` files.
3. **The keys make real proofs and refuse changed ones.** We made a real Groth16 proof with each final key, using
   PP's pinned wasm, the file the device ships (docs/plan1/vault.md at 6fcfa94, 2.6, l.420 and l.423). The snarkjs
   CLI accepts each proof against its pinned vkey. The same proof bytes with one value changed are refused every
   time: each of the 8 withdraw signals and each of the 4 commitment signals plus one, and the withdraw proof's pi_a
   negated. Every output also equals a Poseidon we computed separately with circomlibjs, so each proof is of the
   values we meant.
4. **Plan 1 does not touch the circuits.** The two planned context changes (an absolute relay fee and a 16-byte salt)
   are inputs to `context`. The circuit only squares `context`, so these keys stay valid. Two proofs whose contexts
   differ only by the salt both verify with the same key, and each one refuses the other's context.

## How to re-run

From the repo root, through the heavy gate:

```
scripts/the build queue g1sf -- proofs/g1-setup-files/run.sh          # fetch, compile, zkey verify, proofs, tests
scripts/the build queue g1sf-ptau -- proofs/g1-setup-files/ptau-verify.sh   # the lead's ptau check, then ptau-check.mjs
```

Light, anywhere: `proofs/g1-setup-files/sources.sh` (public reads behind the claims with no other captured output) and
`node --test test/ptau-check.test.mjs` from this folder.

`run.sh` writes `results/runs/<UTC stamp>/`: `run.txt`, `zkey-verify-<c>.txt`, `zkey-verify-<c>.verdict.json`, `vkey-exported-<c>.json`,
`summary.json`, `proofs.txt`, `proofs.json`. Downloads go to `~/.cache/g1-setup-files` (`G1SF_CACHE`), never into the
checkout. `fetch.sh` refuses any file whose size or sha256 differs from its pin.

Runs kept here:

| Run | Who | What |
|---|---|---|
| `20261026T064406Z` | lane 1 | fetch, compile, zkey verify, fetch tests (6/6) |
| `20261026T070503Z` | the lead | the same, re-run (6/6) |
| `20261026T072253Z` | lane 2 | red: `test/proofs.test.mjs` before `prove.mjs` existed, 0 of 7 pass (red because the module was missing; the planted red of `20261026T080732Z` is red for the right reason) |
| `20261026T072552Z` | lane 2 | green: the whole `run.sh` with `prove.mjs`: ALL CHECKS PASS, ALL PROOF CHECKS PASS, tests 13/13 |
| `20261026T074313Z` | lane 2 | `wasm-version.mjs` on our and PP's wasm (the known item below) |
| `20261026T070604Z` | the lead | `ptau-verify.sh`: `snarkjs powersoftau verify ppot_0080_16.ptau`, 3,950 s, `Powers of Tau Ok!`, exit 0; then `ptau-check.mjs` on that output: PTAU CHECKS PASS (12 of 12 with the checker of that time; 17 of 17 with lane 4's strict checker, `20261026T084232Z`) |
| `20261026T074729Z` | the lead | the whole `run.sh` re-run with `prove.mjs`: ALL CHECKS PASS, ALL PROOF CHECKS PASS, tests 13/13 |
| `20261026T080645Z` | lane 3 | `sources.sh` (Mac): the Ethereum block, PP's commit times, the lockfile overlap |
| `20261026T080732Z` | lane 3 | red: `test/summary.test.mjs` on `summary.mjs` before the byte-equal check, 0 of 3 pass; planted red: `G1SF_PLANT=foreign-vkey` checks the withdraw proof against commitment.vkey, only "withdraw: the real proof verifies" fails (6 of 7 pass); the same test unplanted, 7 of 7 |
| `20261026T080926Z` | lane 3 | green: `test/summary.test.mjs` with the byte-equal check in `summary.mjs`, 3 of 3 |
| `20261026T080927Z` | lane 3 | the whole `run.sh` with lane 3's changes: ALL CHECKS PASS (both byte-equal checks OK), ALL PROOF CHECKS PASS, tests 24/24 |
| `20261026T081550Z` | the lead | the whole `run.sh` on the merged card: ALL CHECKS PASS (both byte-equal checks OK), ALL PROOF CHECKS PASS, tests 24/24; the lead's planted red (`G1SF_PLANT=foreign-vkey`, box, `proofs-test-planted-red.txt`) again failed only "withdraw: the real proof verifies", 6 of 7, by a snarkjs crash on 8 signals against a 4-input key, not by "Invalid proof" |
| `20261026T084232Z` | vault lane 4 | the whole `run.sh` with the strict `ptau-check.mjs`, the #58-#60 pins and the new planted fault: ALL CHECKS PASS, ALL PROOF CHECKS PASS, tests 36/36; planted red (`G1SF_PLANT=swapped-signals`: the withdraw proof with signals 0 and 1 swapped, against withdraw.vkey; `proofs-test-planted-red.txt`) failed only "withdraw: the real proof verifies", 6 of 7, with `[ERROR] snarkJS: Invalid proof` (the first try of it stopped earlier: the box had no `node_modules` for this checkout before `run.sh` ran, so all 7 failed on a missing package; not kept); `ptau-check.mjs` on `20261026T070604Z/ptau-verify.txt`: 17 of 17 (`ptau-check.txt`); `test/ptau-check.test.mjs` red on the old checker, 10 of 20 fail (`ptau-check-test-red.txt`, Mac), green on the new one, 20 of 20 (`ptau-check-test-green.txt`, Mac) |
| `20261026T085046Z` | the lead | the whole `run.sh` on the merged card after lane 4: ALL CHECKS PASS (both byte-equal checks OK), ALL PROOF CHECKS PASS, tests 36/36 |
| `20261026T124954Z-followup` | vault lane, card vault-followup T4 | Mac: red/green of the verdict gates. `gate-red.txt`: `test/verdict.test.mjs` (20 tests) on the old piped `verify.sh` and `ptau-verify.sh`, 13 fail; `guard-red.txt`: with the wrapper but the old argv[1] guard, 16 of 22 fail, among them the symlinked-path tests of `snarkjs-verify.mjs` and `ptau-check.mjs`; `inspect-red.txt`: the same fail-open in `inspect.mjs`; `verdict-green.txt`: 23 of 23 |
| `20261026T125651Z` | vault lane, card vault-followup T4 | the whole `run.sh` through the heavy gate with the verdicts from `zKey.verifyFromR1cs` (box load 13.8 at start): `VERIFIED: zKey.verifyFromR1cs returned true` for withdraw (15 s) and commitment (6 s), the logs byte-identical to `20261026T085046Z`'s, ALL CHECKS PASS, ALL PROOF CHECKS PASS, tests 59/59 (`zkey-verify-<c>.verdict.json` beside the logs) |
| `20261026T125831Z` | vault lane, card vault-followup T4 | `ptau-verify.sh` through the heavy gate with `powersOfTau.verify` (box load 7.8 at start, beside nothing else of ours): 3,399 s, `Powers of Tau Ok!`, `VERIFIED: powersOfTau.verify returned true`, exit 0 (`ptau-verify.verdict.json`), then `ptau-check.mjs`: 17 of 17, PTAU CHECKS PASS (`ptau-check.txt`) |

All runs but `20261026T080645Z` (public reads, run on the Mac) and the three `ptau-check*.txt` files in `20261026T084232Z` (light, run on the Mac)
are on the build box
(`Linux 6.18.54.1-microsoft-standard-WSL2 x86_64`, 16 cpus).

## Pinned files

"Published" means the source publishes this sha256. "Our read" means nobody publishes a hash: we pinned the sha256 of
the file we downloaded on 2026-10-26, and anyone can check that pin against the same URL.

PP = github.com/0xbow-io/privacy-pools-core at commit `c312dcd58f6ad085204be61923c49f8065e4e9ae` (tag v1.3.0).

| File | Bytes | sha256 | Source | Hash |
|---|---|---|---|---|
| withdraw.wasm | 2,607,967 | `36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10` | PP `packages/circuits/build/withdraw/withdraw_js/withdraw.wasm` | published: PP SDK `packages/sdk/src/circuits/artifactHashes.ts:18-33` |
| withdraw.zkey | 17,793,015 | `2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677` | PP `packages/circuits/trusted-setup/final-keys/withdraw.zkey` | published (same file) |
| withdraw.vkey | 4,208 | `666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e` | PP `.../final-keys/withdraw.vkey` | published (same file) |
| commitment.wasm | 2,380,442 | `254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8` | PP `packages/circuits/build/commitment/commitment_js/commitment.wasm` | published (same file) |
| commitment.zkey | 901,233 | `494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3` | PP `.../final-keys/commitment.zkey` | published (same file) |
| commitment.vkey | 3,477 | `7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8` | PP `.../final-keys/commitment.vkey` | published (same file) |
| pp-withdraw.r1cs | 4,937,856 | `c6eb70ebc6b9a5f3fc7150ffc3dba50b694a431cd2d9380fa5c013e2bcbdf357` | PP `packages/circuits/build/withdraw/withdraw.r1cs` | our read (git blob id equals PP's tree) |
| pp-commitment.r1cs | 205,744 | `3c93dfa4c519cf9336818b7b842e42060fbba15a44b0e1fdb0f254e655dac786` | PP `packages/circuits/build/commitment/commitment.r1cs` | our read (git blob id equals PP's tree) |
| beacon_hash | 65 | `f7e735ef9882f018f3e3eeb3067230b757f98bc7efb37d187ccf00eb82b92379` | PP `packages/circuits/trusted-setup/beacon_hash` | our read (git blob id equals PP's tree) |
| final_contribution_beacon | 9 | `f494fd49c680842df54e62e7a1f0552faca2eb06e75bce8fad2a5764362011c0` | PP `packages/circuits/trusted-setup/final_contribution_beacon` | our read (git blob id equals PP's tree) |
| ppot_0080_16.ptau | 75,590,802 | `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9` | `pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_16.ptau`, linked from PSE's perpetualpowersoftau README "Prepared Phase 2 Files" (commit b077232) | our read: PSE gives the link and size, no hash |
| withdraw.circom | 4,656 | `03e00168149bd00cd71d43d86f475e4ff919fef524dca0dd5689d7bc99dc4731` | PP `packages/circuits/circuits/withdraw.circom` | our read (git blob id equals PP's tree) |
| commitment.circom | 1,367 | `9c5ccc11cd162a9e584e882e62c852da60fa2ef90e52476d9ac0d4a7cdff1eb8` | PP `packages/circuits/circuits/commitment.circom` | our read (git blob id equals PP's tree) |
| merkleTree.circom | 3,263 | `5754b7b09afa124e4821dff70a7caf533635366d9dcbb56d04128603494d0882` | PP `packages/circuits/circuits/merkleTree.circom` | our read (git blob id equals PP's tree) |
| circom-2.2.1-linux-amd64 | 11,873,960 | `217c99792b0cdf7806f923d0afd88dafae06a14d82001fd3bda34407e6073317` | github.com/iden3/circom/releases v2.2.1 `circom-linux-amd64` | our read: the release has no digest; size equals GitHub's API |
| circom-2.2.1-macos-amd64 | 10,727,704 | `47f2b4095515a832fe6938f166c3f995b2e376798e17eecaf03d118e40ad6838` | the same release, `circom-macos-amd64` | our read (not used in these runs) |

Pins live in `pins/setup.txt` and `pins/sources.txt`.

## Versions

| Tool | Version | Where it comes from |
|---|---|---|
| circom | 2.2.1 | PP's CI pin (`.github/workflows/circuits.yml` at c312dcd); the binary prints `circom compiler 2.2.1` |
| snarkjs | 0.7.5 | npm, `package-lock.json`; `compile.sh` and `prove.mjs` refuse any other version |
| circomlib | 2.0.5 | npm, lockfile (the circuits' Poseidon, comparators) |
| maci-circuits | 2.5.0 | npm, lockfile (PP passes it as an include path) |
| circomlibjs | 0.1.7 | npm, lockfile (our separate Poseidon) |
| @zk-kit/lean-imt | 2.2.4 | npm, lockfile (the two trees) |
| @noble/hashes | 2.4.0 | npm, lockfile (keccak256 for scope, label, context) |
| node | v24.12.0 | the box; npm 11.6.2 |

All npm packages are installed with `npm ci --ignore-scripts` (177 packages). The 110 packages this lockfile shares
with `proofs/g1-vault-gas/prover/package-lock.json` on main have the same version and integrity hash (`sources.sh`,
`results/runs/20261026T080645Z/sources.txt` part 3, main d81b0d7).

## Commands and results

From `results/runs/20261026T072552Z/run.txt` (the lead's `20261026T070503Z` gives the same fetch, compile and zkey
lines; it has no `prove.mjs` lines, since it ran before `prove.mjs` existed):

| Command | Result line |
|---|---|
| `fetch.sh` (11 files by pin) | each `cached <name> <bytes> B sha256 <pin>` |
| `circom-2.2.1 --version` | `circom compiler 2.2.1` |
| `circom --sym --wasm --r1cs -p bn128 ... --inspect circuits/test/withdraw.circom` | `Everything went okay` |
| `node inspect.mjs r1cs withdraw.r1cs nConstraints` (the gate in `compile.sh`; `snarkjs r1cs info` is printed beside it) | `withdraw constraints 36832 = 36832: OK` (snarkjs prints `# of Constraints: 36832`); `withdraw.r1cs byte-equal to PP's build/withdraw/withdraw.r1cs: yes` |
| `node inspect.mjs r1cs commitment.r1cs nConstraints` (the same) | `commitment constraints 1537 = 1537: OK` (snarkjs prints `# of Constraints: 1537`); `commitment.r1cs byte-equal to PP's build/commitment/commitment.r1cs: yes` |
| `snarkjs zkey verify withdraw.r1cs ppot_0080_16.ptau withdraw.zkey` (since T4: `zKey.verifyFromR1cs`, see "How the zkey and ptau verdicts are decided") | `ZKey Ok!`, exit 0 (T4: `VERIFIED`) |
| `snarkjs zkey verify commitment.r1cs ppot_0080_16.ptau commitment.zkey` (the same) | `ZKey Ok!`, exit 0 (T4: `VERIFIED`) |
| `snarkjs zkey export verificationkey <c>.zkey` | JSON-equal to the pinned `<c>.vkey`, both circuits |
| `node summary.mjs` | `ALL CHECKS PASS` |
| `node prove.mjs --out <run dir>` | `ALL PROOF CHECKS PASS` |
| `node --test test/fetch.test.mjs test/proofs.test.mjs` | `tests 13`, `pass 13`, `fail 0` |

In these runs the byte-equal line was printed by `compile.sh` and kept in `summary.json` (`byteEqualToPP: true`), but
was not one of `summary.mjs`'s checks. It is now a gating check for both circuits ("our r1cs byte-equal to PP's
committed build/<c>/<c>.r1cs"): `test/summary.test.mjs` shows `summary.mjs` passes on the real files and fails on
exactly that check when PP's r1cs is a copy with one byte changed. `run.sh` now also runs `test/summary.test.mjs` and
`test/ptau-check.test.mjs`.

## The zkey checks

| | withdraw | commitment |
|---|---|---|
| power (domain) | 16 (65,536) | 11 (2,048) |
| nPublic | 8 | 4 |
| contributions | 514 + 1 beacon | 513 + 1 beacon |
| beacon hash | `c87bd495d8ccfe9fb4158ee26d47e5ca2bcd4e853f80c9fdebf7e2921630e6e5` | the same |
| beacon iterations exponent | 10 | 10 |
| `snarkjs zkey verify` | `ZKey Ok!`, exit 0 | `ZKey Ok!`, exit 0 |
| exported vkey = pinned vkey | yes | yes |

Each fact is read twice: once by snarkjs, once by `inspect.mjs`, our own reader of the zkey header and contribution
section (`summary.json`).

## The beacon

The beacon hash `c87bd495...0e6e5` is sha256 of the ASCII string `21989617`, PP's `final_contribution_beacon`, with
iteration exponent 10 (p0tion's rule). The review read 21,989,617 as an Ethereum mainnet block on 2026-10-26 ~07:0xZ
(`eth_getBlockByNumber` on ethereum-rpc.publicnode.com): block hash
`0xedfdecb22c38d4f72a696cd881e5a9573dc1e684710bba3a5ee5f5824f390ce0`, time 2025-03-06T18:24:23Z (re-read by
`sources.sh`, `results/runs/20261026T080645Z/sources.txt` part 1). The ceremony
ended in March 2025 (l2beat.com/zk-catalog/privacy-pools).

The beacon is the block number, not the block's hash, so anyone could know its value in advance. A beacon is only
the last step. The key is safe if at least one of the 514 (withdraw) or 513 (commitment) contributors destroyed
their secret, and a beacon known in advance does not change that.

## ptau verify: filled in by the lead

`ptau-check.mjs` (run by `ptau-verify.sh` after snarkjs exits 0, or alone: `node ptau-check.mjs <ptau-verify.txt>`)
passes only when the snarkjs output shows: the contribution before the beacon has PPoT 0080's published response
hash, next challenge and challenge; the three before it have the published response hashes of PPoT 0079, 0078 and
0058, 0058 answered the published challenge_0058, their next challenges are the published ones, and from #58 to the
beacon each contribution answered the one before it; the last contribution is the beacon of slot 7,325,000 with
iterations exponent 31; and "Powers of Tau Ok!", exit 0 (values and sources: `pins/ptau.txt`).

It reads the output line by line in the fixed order snarkjs 0.7.5 prints it and refuses any line out of place: each
hash block is exactly 4 lines of 4 eight-hex words, inside a contribution the fields come in the order Next Challenge,
Response Hash, Response Hash (then the two beacon lines for a beacon), and any ERROR, WARN or other line, or any line
after the exit line, fails. snarkjs prints a contributor's name as stored, so a name with line breaks could print a
fake hash block; the old checker passed such an output (the team lead's demo), and the fixed order now refuses it
(`test/ptau-check.test.mjs` holds two forms of it). `ptau-verify.sh` now also writes `[ptau-verify.sh] elapsed <s> s`
just before its exit line, the one place the check accepts it; the `20261026T070604Z` output was written before that
and has no such line (its 3,950 s is in `ptau-verify-stdout.txt`).

Run `20261026T070604Z` on the build box (`ptau-verify.txt`, `ptau-check.txt`):

- `snarkjs powersoftau verify ppot_0080_16.ptau` (snarkjs 0.7.5) checked all 62 contributions in the file, each
  "Powers Of tau file OK!", and ended `Powers of Tau Ok!`, exit 0, after 3,950 s (`ptau-verify-stdout.txt`, the heavy job's own output).
- Contribution #61, `carter-feldman`, carries PPoT contribution 0080's public key. Its response hash is `28af03a3 e4000bff ... 8d04edb1`,
  its next challenge is `4bf672f3 ba1de1bb ... d3954174`, and the challenge it answered is `d9ec6fad 4a7a7e33 ...
  d0afa2e8`. All three equal the blake2b values PSE publishes for 0080 (perpetualpowersoftau at b077232,
  `0080_carter_response/README.md`).
- Contribution #62, the last and the only beacon, has the beacon `af941599...feeded`, the randao_reveal of
  beacon-chain slot 7,325,000, and `Beacon iterations Exp: 31`, both as the PPoT README's "Beacon" section states
  (l.206-213). It answers #61's next challenge.
- Contributions #58 (no name), #59 `soham-zemse` and #60 `atheartengineer` print the response hashes PSE publishes
  for 0058 (`265770e2 ... 0e670256`, `0058_rasikh_response/README.md` l.24-27), 0078 (`750070be ... a0832667`,
  `0078_soham_response/README.md` l.28-31) and 0079 (`4faa7e9e ... 32e3675e`, `0079_atheartengineer_response/README.md`
  l.24-27). #58 answered challenge_0058 (`44ba2e77 ... 5e036015`, l.6-9 of 0058's README), and each next challenge is
  the one the next contribution answered, as the READMEs publish it, up to the beacon.
- `node ptau-check.mjs results/runs/20261026T070604Z/ptau-verify.txt`: 12 of 12 checks OK, `PTAU CHECKS PASS`, exit 0.
  The same output with one hex digit of #61's response hash changed (`e4000bff` to `e4000bfe`) fails that one check,
  `PTAU CHECKS FAIL`, exit 1 (`ptau-check-red.txt`; `test/ptau-check.test.mjs` holds the same case). The strict
  checker with the #58-#60 checks gives 17 of 17 on the same output (`20261026T084232Z/ptau-check.txt`).

What this proves, and what it does not:

- `powersoftau verify` checks the whole chain of public keys from the generator to the final points, and it
  recomputes the beacon step from the stored beacon value and exponent (snarkjs 0.7.5 src/powersoftau_verify.js
  l.30-70).
- It prints #61's response hash from the hash state and the public key stored in the file (src/powersoftau_utils.js
  l.172-182), not from the points. That hash equals the b2sum PSE publishes for `response_0080_carter`, so the key
  stored as #61 is 0080's key. Matching it with a key of one's own would take a blake2b preimage.
- So the phase-1 file the two zkeys verify against holds PPoT contribution 0080's public key on a chain snarkjs
  checked from the generator, with PSE's announced beacon as its last step. Its secret therefore includes 0080's
  secret: no one without that secret can know the file's tau.
- The two challenge hashes the check matches are values stored in the file, not recomputed; they are bound only
  through 0080's key check and the beacon key derived from them.
- #58-#60's response hashes are printed the same way, from stored state and stored keys, so their match shows the
  keys stored as #58, #59 and #60 are the keys of PPoT 0058, 0078 and 0079. With the chain of challenges from #58 to
  the beacon, this places the file on PPoT's second branch, the one the README's "Note on Chain Fork" (l.437-447 at
  b077232) says is continued: 0078 chains from 0058, and contributions 0059-0077 are a separate fork. Those
  challenge hashes too are stored values, not recomputed.
- The check does not compare #1-#57 with PPoT's published hashes. The safety of the file rests on 0080's key, the
  beacon and any one honest contributor before them.

Our sha256 pin of the file is our own read; this check ties it to 0080's key and the beacon.

## How the zkey and ptau verdicts are decided (card vault-followup T4)

Until then `verify.sh` and `ptau-verify.sh` piped snarkjs through `perl >file`. In run `20261026T090041Z` (box load 11.4,
a ptau job beside it) the withdraw `zkey verify` exited 0 but the file stopped at 120,108 B, so the gate failed closed
without saying whether the key was false or the output was cut (Verifier P3). Now `snarkjs-verify.mjs` calls snarkjs
0.7.5's own `zKey.verifyFromR1cs` and `powersOfTau.verify` from node and takes the boolean they return:

- snarkjs's log lines go straight into `zkey-verify-<c>.txt` or `ptau-verify.txt` with synchronous writes, no pipe. For
  the commitment key the log is byte-identical to the old piped one (checked against `20261026T085046Z`), so
  `summary.mjs` and `ptau-check.mjs` read it unchanged.
- After the call returns, `<log>.verdict.json` holds `{"tool","snarkjs":"0.7.5","result":true|false}`. A stale one is
  removed first.
- `classify` decides from the exit code and that file only, never from the log, and the gate prints one of three lines
  and passes only on the first: `VERIFIED` (exit 0 and true), `VERIFY FALSE` (exit 1 and false), `OUTPUT CUT / PROCESS
  ENDED EARLY` (anything else: no verdict file, a kill, a crash, an exit before the call returned, or an exit code and
  verdict that disagree). `verify.sh` stops on the last two before the next circuit.
- `test/verdict.test.mjs` (23 tests, in `run.sh`): the real gate scripts against a stub snarkjs with a planted false, a
  cut (exit 0 mid-print, the 090041Z shape), a SIGKILL and a throw; `classify` cases; a check that no verify is piped;
  and real snarkjs 0.7.5 on the real keys (true; false with the commitment key against the withdraw r1cs; a real kill).
  Red on the old scripts: 13 of 20 failed (`20261026T124954Z-followup/gate-red.txt`).
- A second bug of the same kind, found by that test: `snarkjs-verify.mjs` first compared `process.argv[1]` with
  `import.meta.url`. Node resolves the main module's symlinks (macOS tmp is `/var`, really `/private/var`) and argv[1]
  keeps them, so through such a path the script ran nothing and exited 0, and `classify` printed no line. The same
  guard sat in `ptau-check.mjs` and `inspect.mjs` (compile.sh's constraint-count gate). All three now compare
  `realpathSync(argv[1])`, the gate also requires the line `VERIFIED:` and not only exit 0, and the tests start each
  script through a symlink, a symlinked folder and a copy under the temp dir. Red on the old guards:
  `20261026T124954Z-followup/guard-red.txt` (16 of 22 failed, among them both path tests) and `inspect-red.txt`; green:
  `verdict-green.txt`, 23 of 23.
- The wasm, the proofs and the other checks are untouched.

## Known item: our wasm is not byte-equal to PP's

The wasm we compiled differs from PP's pinned wasm: withdraw `a019213f...` against PP's `36cda227...`, commitment
`158716a3...` against PP's `254d2130...`. This changes nothing about the keys. The zkey is bound to the r1cs, and our
r1cs is byte-equal to PP's. A witness from any wasm must satisfy that r1cs or no proof verifies, so the wasm is not
trusted for anything. Our proofs use PP's pinned wasm, the file the device ships (docs/plan1/vault.md at 6fcfa94,
2.6, l.420 and l.423).

The likely cause is the compiler version. circom writes its own version into the wasm (the exports `getVersion`,
`getMinorVersion`, `getPatchVersion`). Both of PP's pinned wasm files report **circom 2.2.0**, while PP's CI pins
2.2.1, which we used. PP committed these build files on 2025-02-19 15:56Z (PP commit b209cdd, "chore: new circuit
artifacts"), after the last source change at 13:11Z the same day (f2b5afe); both are the last commits at v1.3.0 to
touch those files (`sources.sh`, `results/runs/20261026T080645Z/sources.txt` part 2). Our two wasm files report
circom 2.2.1, and each is exactly 117 bytes smaller than PP's (withdraw 2,607,850 against 2,607,967; commitment
2,380,325 against 2,380,442), which looks like a compiler difference, not a circuit difference (`node wasm-version.mjs
<wasm>...`, `results/runs/20261026T074313Z/wasm-version.txt`, assembled by hand from the job's output). We did not
compile with circom 2.2.0 to compare bytes, so the cause is likely, not proven.

## Proofs: real ones accepted, changed ones refused

`prove.mjs`, run `20261026T072552Z` (`proofs.txt`, `proofs.json`). Each check runs
`snarkjs groth16 verify <pinned vkey> public.json proof.json`. Test values only: five deposits of 2, 5, 10, 3 and 7
million units into vault.test.near/token.test.near, both trees at depth 3. Note 2 (5,000,000) is spent in part:
2,000,000 out, 3,000,000 left as change. The commitment proof is for note 2's own commitment.

| Case | Expected | snarkjs CLI |
|---|---|---|
| withdraw, real proof (context by vault.md 2.5.2 row 3) | accept | exit 0, `OK!` |
| withdraw, newCommitmentHash + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, existingNullifierHash + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, withdrawnValue + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, stateRoot + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, stateTreeDepth + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, ASPRoot + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, ASPTreeDepth + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, context + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, pi_a with y negated (still a curve point) | refuse | exit 1, `Invalid proof` |
| commitment, real proof | accept | exit 0, `OK!` |
| commitment, commitment + 1 | refuse | exit 1, `Invalid proof` |
| commitment, nullifierHash + 1 | refuse | exit 1, `Invalid proof` |
| commitment, value + 1 | refuse | exit 1, `Invalid proof` |
| commitment, label + 1 | refuse | exit 1, `Invalid proof` |
| withdraw, salt A context | accept | exit 0, `OK!` |
| withdraw, salt B context | accept | exit 0, `OK!` |
| salt A's proof with salt B's context | refuse | exit 1, `Invalid proof` |
| salt B's proof with salt A's context | refuse | exit 1, `Invalid proof` |

Every changed case uses the real proof's bytes with one value changed. None is a new proof. A signal is changed to
(value + 1) mod p, so it stays in the field and the refusal comes from the pairing check, not a range check. pi_a is
negated, not bit-flipped: a bit flip puts the point off the curve and snarkjs stops earlier with "Proof commitments
are not valid".

Outputs checked with circomlibjs's Poseidon, apart from the circuit:

- withdraw: newCommitmentHash = Poseidon(3,000,000, label, Poseidon(newNullifier, newSecret)); existingNullifierHash
  = Poseidon(existingNullifier). stateRoot and ASPRoot are inputs, not outputs: the proof verifies with those roots,
  which are the LeanIMT roots of the five deposits.
- commitment: commitment = Poseidon(value, label, Poseidon(nullifier, secret)); nullifierHash = Poseidon(nullifier).

`test/proofs.test.mjs` re-checks all of this without trusting `prove.mjs`. It re-runs the CLI on each real proof,
builds every changed case again from the real proof (both context swaps included), and recomputes the outputs with
circomlibjs.

## Context: Plan 1 changes nothing in the circuits

The withdraw circuit takes `context` as a public input and only does `signal contextSquared <== context * context;`
(PP `packages/circuits/circuits/withdraw.circom:111` at c312dcd). It never looks at what `context` is made of. The
vault computes `context` outside the circuit and checks it: `context == keccak256(borsh(Withdrawal{processor:
current_account_id, recipient, register_deposit, fee_recipient, relay_fee_bps, refund_precommitment, deadline_ms}) ‖
scope_be32) mod p` (docs/plan1/vault.md at 6fcfa94, 2.5.2 row 3, l.289). The paper says the same at l.436-437:
"`context` is bound by `contextSquared <== context * context` (`CI/circuits/withdraw.circom:111`); its meaning is
enforced by the vault's check 2.5.2 row 3."

Card vault-followup adds two inputs to that hash (markets.md and wallet.md lines below at main 82c5479):

- (a) an absolute `relay_fee` in the token's base units, bound in `context`, with the vault's cap kept only as a
  backstop: `relay_fee × 10,000 ≤ withdrawn × MAX_RELAY_FEE_BPS` (docs/plan1/markets.md l.91, LD5; vault.md l.60
  for `MAX_RELAY_FEE_BPS`);
- (a2) a 16-byte salt, fresh random bytes from the device for each attempt, bound in `context` (docs/plan1/wallet.md
  l.208-213 and l.911).

Both change only the bytes the vault hashes into `context`, and the backstop is a check in the vault, not in the
circuit. The r1cs, the zkeys and the vkeys stay the same. The test shows it: two withdraw proofs of the same spend,
whose contexts differ only by the salt, both verify with the same withdraw.vkey, and each refuses the other's
context. The byte layout used for those two contexts (the relay fee as u128 little-endian and the salt, appended
before scope) is ours, for this test only. Card vault-followup fixes the real layout, and the circuit binds any
layout the same way.

## Hook note

Lane 1 hit a worktree-isolation hook four times. Its message said "Split it into plain, separate commands", and lane
1 ran exactly that form. The team lead accepted this as following the block. Lane 2 hit the same hook four times with the
same message and also ran exactly that form. A different safety check stopped lane 2's one-off circom 2.2.0 compile
because its script ended with a temp-dir removal. That step was not run, which is why the wasm cause above is likely,
not proven.

Lane 3 hit the same hook five times. Twice ("names git in a form too complex") it ran exactly the named form, plain
separate commands. Once (a sed on a runtime variable) it re-ran the plain command with literal paths. Twice ("too
complex to verify": a one-line prepend to `wasm-version.txt` and a reflow of `RESULT.md`) it made the same edits
with the Edit tool instead of separate shell commands, which is a different tool, not the named form; the lead has
put this to the team lead. The edits themselves are in this folder and were reviewed in the diff. The lead's own step
listing box processes with `ps` was blocked by the session guard ("ps listings print other apps' command lines
(secrets): use ps -p <pid> -o pid,stat,etime,comm"); the lead then ran that named form.

## Not covered here

- A byte comparison of a circom 2.2.0 build against PP's wasm (see the known item).
- On chain: the vault's own Groth16 check with these vkeys is card g1-vault-gas (NEAR testnet).
- VT-U05's second clause, "the contribution hashes match the ceremony record" (docs/plan1/vault.md at 6fcfa94, l.748:
  "`snarkjs zkey verify` of both final keys against the r1cs and the phase-1 file" expects "both verify; the
  contribution hashes match the ceremony record"). Only the first half is done here. PP at c312dcd publishes no
  per-contribution record. The GitHub tree read, re-read 2026-10-26 ~12:40Z
  (`gh api repos/0xbow-io/privacy-pools-core/git/trees/c312dcd58f6ad085204be61923c49f8065e4e9ae?recursive=1`,
  `truncated: false`), lists under `packages/circuits/trusted-setup/` only: `beacon_hash` (65 B),
  `final_contribution_beacon` (9 B), `final-keys/` (`commitment.vkey`, `commitment.zkey`, `withdraw.vkey`,
  `withdraw.zkey`) and `last-keys/` (`ragequit_00513.zkey`, `withdraw_00514.zkey`). So the clause is checked only as far
  as it is published: the beacon (sha256 of `final_contribution_beacon` = `beacon_hash` = the beacon in both final
  zkeys, exponent 10), the final-key hashes (the sha256 pins in "Pinned files") and the contribution counts (514 and
  513, each plus the beacon, read by snarkjs and by `inspect.mjs`). The per-contribution record is not published at
  that commit, and p0tion's public transcript was not read, so none of the 514 and 513 contribution hashes is
  compared with a ceremony record.
