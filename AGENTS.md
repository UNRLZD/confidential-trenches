# AGENTS.md

How to build, test and change this repository. Written for people and coding agents alike; `CLAUDE.md` imports
this file, so every tool reads the same text.

## What this is

Confidential Trenches is a trading terminal built on Blindfill. Blindfill holds the money and the keys, and the
terminal is an app on it with no key of its own.

- The vault is a NEAR contract that pays out only against a proof made on the user's device. It has no access key,
  no owner and no upgrade path, so nobody, including us, can sign for it or change it.
- The user's device holds the 12 words (the backup phrase), every key derived from them, the notes (sealed records of
  what the user owns in the vault) and the proofs.
- The kit, `@blindfill/kit`, is the one public entry to all of it, for our terminal and for any other app.
- The helper server holds vendor API keys, relays signed messages and sends signed orders. It holds no key that can
  move a user's money.
- NEAR Intents moves money in, out and across chains.

For the longer read, see [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md).

## Map

| To change | Go to | Note |
|---|---|---|
| The vault contract | `contracts/vault/src/` | Rust; tests in `contracts/vault/src/tests.rs` and `contracts/vault/tests/` |
| What apps may call | `packages/kit/src/index.ts` | The kit's only public entry, its `.` export |
| A check on a quote before signing | `packages/kit/src/checks/` | 1Click quotes, Solana pool reads |
| Keys, 12 words, notes | `packages/wallet/src/` | Runs only on the device |
| The signing page | `packages/signpage/` | Served from its own address, apart from the terminal |
| The terminal's screens | `apps/terminal/src/` | React on Vite |
| The helper server | `apps/helper/src/` | Node; deploy files in `apps/helper/deploy/` |
| A CI gate | `scripts/ci/` | Each gate has a `*.test.mjs` with planted failures |
| A live check | `scripts/live-checks/` | One per change, see below |
| The performance table | `perf/runs/*.json` | `scripts/perf-table.mjs` writes the table from these |
| CI | `.github/workflows/ci.yml` | Five required jobs |

`packages/exit/` will hold the exit tool: money out with only the 12 words and public RPCs. It is empty today.

## How the parts connect

Three boundaries, each with a check that fails when it breaks:

1. **Apps reach Blindfill only through the kit's public entry.** Everything under `packages/` and `contracts/` is
   Blindfill, and a file outside them may import only `packages/kit/src/index.ts`. Held by `pnpm run check:imports`.
2. **Keys stay on the device.** Servers hold API keys, never a key that moves money. gitleaks keeps every secret
   out of the tree and the history, with `.gitleaks.toml` adding NEAR secret keys to its default rules.
3. **The vault has no key.** Its live check reads `keys: []` on two RPCs and reads the compiled code's imports, so
   a host call that adds a key or deploys new code fails it (`scripts/live-checks/vault-skeleton.mjs`).

## Setup

- Node 24 or later, pnpm 10.33.1 (`packageManager` in `package.json`).
- `pnpm install --frozen-lockfile`. pnpm installs a package version only once it is a week old
  (`minimumReleaseAge: 10080` in `pnpm-workspace.yaml`).
- For the vault: Rust 1.96.0 (`rustup toolchain install 1.96.0 --profile minimal`).
- For the secret scan: gitleaks 8.30.1, the version CI installs.

## Commands

Run from the repository root.

| Command | What a pass proves |
|---|---|
| `pnpm run check:imports` | No file outside Blindfill reaches past the kit's entry, in any form the two checks read |
| `pnpm run test:gates` | Every CI gate still refuses its planted failures |
| `pnpm -r --if-present --no-bail run test` | Every package's own tests |
| `pnpm -r --if-present run typecheck` | Every package type-checks |
| `node --test scripts/live-checks/*.test.mjs` | Every live check passes its recorded good run and fails its recorded bad one |
| `pnpm run test:vault-scripts` | The vault scripts' own tests |
| `cargo +1.96.0 test --locked --manifest-path contracts/vault/Cargo.toml` | The vault's Rust tests |
| `node scripts/perf-table.mjs --check` | README and `docs/performance.md` match the run records |
| `gitleaks dir . --config .gitleaks.toml --redact` | No secret in the working tree |
| `node scripts/ci/money-gate.mjs --all` | Every recorded money transaction reads back as succeeded on two public RPCs |

While working, run the narrowest test first: `node --test <file>` for one file, or
`pnpm --filter <package> test` for one package. Run the full set before you push. Two take longer:
`test:gates` up to a minute, and `money-gate --all` several minutes, since it reads every recorded transaction
over public RPCs that rate-limit.

## Rules for changes

- **Import Blindfill only from `@blindfill/kit`.** Our terminal gets no private path, so any app can do what it
  does. `check:imports` fails on a deep import.
- **The vault never gains an access key, owner, upgrade, pause or setter.** Any one of them would let someone
  move or freeze the money. The vault's live check reads its keys and its code imports after every deploy.
- **Keys exist only on the user's device.** A server that holds a money key can lose it. gitleaks runs on the tree
  and the full history in CI.
- **Never sign on a server's word.** The device checks every quote against the user's own request and against pool
  reads from two RPC providers before it signs, so a broken-in server cannot steer a signature.
- **A money path is done when it has landed.** Deposit, withdraw, trade and orders count as done only after a real
  run reaches arrival and every transaction reads back on chain. Money code is what `MONEY` in
  `scripts/ci/money-gate.mjs` names: `contracts/vault/`, the pool programs in `contracts/pool-solana/` and
  `contracts/pool-evm/`, `packages/kit/`, `packages/wallet/`, and the terminal's trading code once it lands in
  `apps/terminal/src/trading/`.
- **A security fix comes with a test that fails before the fix and passes after it.** Without it, nothing shows the
  fix works or keeps it working.
- **Every commit subject starts with `Card <key>: `**, where `<key>` names the change in lowercase letters, digits and
  hyphens. It ties each commit to one change and its live check. The verify gate refuses a pull request otherwise.

## How a change is proven

1. Write the test first and watch it fail. For a bug, the test reproduces it.
2. Make the change and watch the test pass. Then run the commands above that cover what you touched.
3. Add the live check: `scripts/live-checks/<key>.mjs` checks the change's end state on what is deployed. Its
   `<key>.test.mjs` replays `<key>.answers.json`: a recorded good answer must pass and a recorded bad one must fail.
   Each deploy script prints the live check to run next.
4. A change with nothing to check live writes, on its own line in the pull request body,
   `Live check: none (<reason>)`.
5. A money-path change keeps its run record in `scripts/live-checks/<key>.md`: a `Money path: yes` line and one
   `Tx: <chain> <id>` line per transaction. The money gate reads each one back on two public RPCs.

## CI

`.github/workflows/ci.yml` runs five required jobs on every pull request into `main`:

| Job | Runs |
|---|---|
| `gitleaks` | gitleaks on the tree and the history, then `test:gates` |
| `deep-import` | `check:imports` and the performance table check |
| `verify-gate` | `scripts/ci/verify-gate.mjs`: commit subjects and live checks |
| `money-gate` | `scripts/ci/money-gate.mjs` on the change's records |
| `test` | package tests, typecheck, live-check replays, vault scripts, `cargo test` |

On a pull request the verify and money gates run as `main` has them, so a pull request cannot loosen its own gate.
Every action is pinned to a commit sha. `scripts/ci/tests-run.test.mjs` fails when a tracked test file is run by
no command.

## Never

- Commit a `.env` file, a `.pem` or a private key. A key in git history stays readable after the file is deleted.
  Test keys come only from published vectors, such as the all-zero seed in `packages/wallet/test/vectors/a8.json`.
- Loosen a gate to get a change through. Each gate's tests plant the failures it must refuse. Change a gate and
  its planted cases in the same commit.
- Hand-edit `pnpm-lock.yaml` (run `pnpm install`), or `docs/performance.md` and the table between the `perf-table`
  markers in `README.md` (run `node scripts/perf-table.mjs`).
