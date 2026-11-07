#!/usr/bin/env bash
# Moves the helper's two mainnet vault lines in deploy/.env to the vault of the mainnet deploy record (card
# helper-v1-cutover), so a release that moves its pin (src/withdraw/send.ts MAINNET_VAULT) starts with no hand edit of
# the server's .env. Run on the server, from the checkout redeploy.sh keeps, once it is at the commit to deploy:
#   apps/helper/deploy/vault-lines.sh
#
# The first deploy of contracts/vault/deployments/mainnet-v1.json, in this order (the one place it is written; the
# key scripts point here). R is the commit that adds the record and moves MAINNET_VAULT to its account_id (send.test.ts
# holds the two equal):
#   1. on the server: git -C <checkout> fetch -q --depth 1 origin R && git -C <checkout> checkout -q --detach R, then
#      this script: WITHDRAW_VAULT_MAINNET, and BIND_VAULT_MAINNET when set, move to mainnet-v1.json's account_id;
#   2. apps/helper/deploy/redeploy.sh R, holding the helper's live checks (from R on helper-bind-relayer-mainnet is
#      listed, scripts/ci/helper-live-checks.mjs bindMainnetPlan, and fails until step 4, and a failing check undoes a
#      deploy). Its settings check (src/env-check.ts, the start's own readers with R's pin) refuses a vault line still
#      on the old vault before any helper is started or stopped, so a missed step 1 stops there, not after the wait;
#   3. apps/helper/deploy/bind-relayer-key.sh, which needs R running (it checks the record against the running image's
#      pin) and writes the deposit carry's three lines (once: a rerun is refused);
#   4. apps/helper/deploy/redeploy.sh R again, so the helper starts with them;
#   5. the owner sends 1 NEAR to the gas account bind-relayer-key.sh printed (the carry's floor for one more deposit is
#      0.3302526 NEAR, src/bind/send.ts RELAYER_FLOOR_YOCTO);
#   6. once it has landed: the helper's live checks, helper-bind-relayer-mainnet and helper-mainnet-vault-env among
#      them.
# The withdrawal relayer's account, its keys and its fee recipient stay: none of them is tied to a vault.
#
# In order, stopping at the first failure with deploy/.env unchanged:
#   1. refuses (exit 4) when contracts/vault/deployments/mainnet-v1.json does not exist or names no mainnet vault: the
#      kit names no mainnet vault before that record (packages/wallet/test/deposit-delegate.test.ts: mainnet-v1.json's
#      or null, never mainnet-test.json's), and this never falls back to the test vault;
#   2. refuses (exit 1) when either name is set by a line that is not one plain NAME=value line (redeploy.sh's lines_of
#      matcher: export, spaces, the NAME: form, or the name twice), as redeploy.sh refuses its own;
#   3. writes deploy/.env again whole (a mode 600 temporary file beside it, then one rename), every other line kept byte
#      for byte, each of the two lines that is set now naming the record's vault; a name not set stays unset. When both
#      already name it, nothing is written.
# It prints the names it moved, never a value.
# exit 0 done, 2 usage, 4 no mainnet vault record, 1 any other failure
set -euo pipefail

NAMES=(WITHDRAW_VAULT_MAINNET BIND_VAULT_MAINNET)
# NEAR's account id rule (nearcore AccountId): 2 to 64 characters, lowercase parts joined by '.', '-' or '_' inside
ACCOUNT_RE='^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'

# deploy/.env's lines setting NAME, in any form redeploy.sh's lines_of reads
lines_of() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1" || true
}

# The one string value of "key" in the record (a flat JSON object our deploy writes), or nothing when it is not there
# exactly once.
field_of() {
  local found
  found="$(grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"\\\\]*\"" "$1" || true)"
  [[ -n "$found" && "$found" != *$'\n'* ]] || return 0
  found="${found#*:}"
  found="${found#"${found%%[![:space:]]*}"}"
  found="${found#\"}"
  printf '%s' "${found%\"}"
}

main() {
  if [[ $# -ne 0 ]]; then
    echo "usage: vault-lines.sh" >&2
    exit 2
  fi
  local deploy root env record vault network name found tmp moved=()
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  env="$deploy/.env"
  record="$root/contracts/vault/deployments/mainnet-v1.json"

  if [[ ! -f "$record" ]]; then
    echo "vault-lines: no contracts/vault/deployments/mainnet-v1.json: the mainnet vault is not deployed at this commit; nothing changed" >&2
    exit 4
  fi
  network="$(field_of "$record" network)"
  vault="$(field_of "$record" account_id)"
  if [[ "$network" != "mainnet" || ${#vault} -lt 2 || ${#vault} -gt 64 || ! "$vault" =~ $ACCOUNT_RE ]]; then
    echo "vault-lines: mainnet-v1.json names no mainnet vault; nothing changed" >&2
    exit 4
  fi
  if [[ ! -e "$env" ]]; then
    echo "vault-lines: no deploy/.env; nothing to move"
    exit 0
  fi
  for name in "${NAMES[@]}"; do
    found="$(lines_of "$env" "$name" | grep -c . || true)"
    [[ "$found" == 0 ]] && continue
    if [[ "$found" != 1 ]] || ! grep -qE "^${name}=" "$env"; then
      echo "vault-lines: $name in deploy/.env is not one plain $name=value line; nothing changed" >&2
      exit 1
    fi
    grep -qxF "${name}=${vault}" "$env" || moved+=("$name")
  done
  if [[ ${#moved[@]} -eq 0 ]]; then
    echo "vault-lines: every vault line set already names mainnet-v1.json's vault; nothing changed"
    exit 0
  fi

  umask 077
  tmp="$(mktemp "$env.vault.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  awk -v vault="$vault" -v names="${NAMES[*]}" '
    BEGIN { n = split(names, N, " ") }
    { for (i = 1; i <= n; i++) if (index($0, N[i] "=") == 1) { print N[i] "=" vault; next } print }
  ' "$env" > "$tmp"
  # every line not one of the two kept byte for byte, each of the two now the record's (checked, never printed)
  if [[ "$(grep -cvE "^($(IFS='|'; echo "${NAMES[*]}"))=" "$tmp" || true)" != "$(grep -cvE "^($(IFS='|'; echo "${NAMES[*]}"))=" "$env" || true)" ]]; then
    echo "vault-lines: the rewrite did not keep every other line; nothing changed" >&2
    exit 1
  fi
  for name in "${moved[@]}"; do
    if ! grep -qxF "${name}=${vault}" "$tmp"; then
      echo "vault-lines: $name was not moved; nothing changed" >&2
      exit 1
    fi
  done
  chmod 600 "$tmp"
  mv -f "$tmp" "$env"
  trap - EXIT
  echo "vault-lines: moved ${moved[*]} to mainnet-v1.json's vault in deploy/.env. Next: apps/helper/deploy/redeploy.sh $(git -C "$root" rev-parse HEAD 2>/dev/null || echo '<this commit>')"
}

main "$@"
