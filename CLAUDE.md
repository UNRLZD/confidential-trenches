# CLAUDE.md

Guidance for coding agents in this repository. AGENTS.md holds the same text.

Confidential Trenches has two parts. Blindfill is the private engine: a keyless vault contract on NEAR, fresh wallets
whose keys stay on the user's device, orders signed in advance, and the open kit `@blindfill/kit`. The UNRLZD
terminal is an app on Blindfill and reaches it only through the kit's public entry. NEAR Intents moves every dollar
into and out of the vault and across chains.

## Layout

| Path | What |
|---|---|
| `contracts/vault/` | The vault, a Rust NEAR contract |
| `packages/kit/` | `@blindfill/kit`; its public entry is the package's `.` export |
| `packages/kit/src/checks/` | The device's checks on every quote before it signs |
| `packages/wallet/` | Keys, notes and proofs on the device |
| `packages/signpage/` | The signing page, on its own address |
| `packages/exit/` | The exit tool: money out with only the 12 words and public RPCs |
| `apps/terminal/` | The UNRLZD terminal |
| `apps/helper/` | The helper server: API keys, relays and signed orders, never a money key |
| `scripts/ci/` | CI gates, each with its planted-case tests |
| `scripts/live-checks/` | One live check per card, run after every deploy |

## Commands

Node 24 or later, pnpm 10.33.1.

| Command | Checks |
|---|---|
| `pnpm install --frozen-lockfile` | Install from the lockfile |
| `pnpm run check:imports` | No import reaches past the kit's public entry |
| `pnpm run test:gates` | Every CI gate refuses its planted case |
| `pnpm -r --if-present --no-bail run test` | Every workspace package's own tests (CI's `test` job, which also runs the vault's `cargo test`) |
| `gitleaks dir . --config .gitleaks.toml` | No secret in the tree |
| `node scripts/ci/money-gate.mjs --all` | Every money-path transaction reads back on two public RPCs |

## Rules for changes

- The terminal imports Blindfill only from the kit's public entry; CI fails on a deep import.
- The vault never gains an access key, owner, upgrade, pause or setter.
- Wallet keys exist only on the user's device. Servers hold API keys, never money keys. No secret is committed;
  gitleaks runs in CI.
- Server data is never trusted for anything signed: a quote is checked against the user's own request and the
  on-chain pools before the device signs it.
- A money path (deposit, withdraw, trade, orders) is done only when a real run has carried it to arrival and every
  transaction is read back on chain.
- A security fix gets a regression test that fails before the fix and passes after it.
- Every commit names its card: `Card <key>: <what changed>`.
