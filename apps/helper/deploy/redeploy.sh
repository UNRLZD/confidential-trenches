#!/usr/bin/env bash
# Redeploys the helper on its server at one commit of the public repo (card helper-release-bump). Run on the server,
# from the checkout it updates:
#   apps/helper/deploy/redeploy.sh <40-hex commit>
# In order, stopping at the first failure (the commit, the .env, the budgets and Caddy's admin socket are read before step
# 1, so a refused one changes nothing):
#   0. fetches the repository's main (objects and refs/remotes/origin/main only, no checkout; the whole history the
#      first time, as a shallow checkout is made complete) and refuses a commit that is not on it, a typo, a commit on
#      another branch only, or an id that is not a commit, before deploy/.env is read (card
#      redeploy-commit-first: on 7 Nov 03:40Z a mistyped commit printed "HELPER_RELEASE raised by one" before its fetch
#      failed). Then every RPC_BUDGET_* and PROXY_BUDGET_* compose may pass, from deploy/.env and from this shell, is
#      checked with the rule the helper's start applies (src/limits/limits.ts budgetFromEnv): a value it would refuse
#      stops here, naming the variable only, instead of leaving the container restarting; and each vendor's key
#      (JUPITER_API_KEY, RELAY_API_KEY, LIFI_API_KEY, ONECLICK_JWT) is set, or its PROXY_BUDGET_<VENDOR> names the
#      keyless plan, as the helper's start requires (src/proxy/proxy.ts checkVendorPlans);
#   1. checks the commit out, detached;
#   2. builds the image (docker compose build helper) and runs its senders' settings check (src/env-check.ts, the
#      start's own readers: the pool senders, the withdrawal relayer and the deposit carry, with the new image's mainnet
#      vault pin) in a one-off container with the environment compose gives the helper: a network set only in part, a
#      value the start would refuse, or a WITHDRAW_VAULT_MAINNET or BIND_VAULT_MAINNET left on the vault before
#      (deploy/vault-lines.sh moves them), stops here with deploy/.env unchanged and no helper started or stopped, not
#      after the bound below (compose takes HELPER_COMMIT and HELPER_RELEASE from this shell first). Only then, in
#      deploy/.env next to compose.yaml, it sets HELPER_COMMIT to the commit and HELPER_RELEASE to the release number
#      send.ts reads (a whole number that only goes up, one per release): kept when the commit is the one already
#      there, one more when it is another (a rollback included), 1 when there was none. So the two lines move only for
#      a commit on main whose image builds and takes its settings. Every other line is kept byte for byte, the file is
#      replaced in one rename and stays mode 600. A HELPER_COMMIT or HELPER_RELEASE line not in the plain NAME=value
#      form, or written twice, is refused at step 0 with nothing changed;
#   3. swaps the helper with no gap, with those two values: with no helper running (a first deploy) docker compose up
#      -d --wait brings the stack up; otherwise starts the new helper beside the old one (docker compose up --no-deps
#      --no-recreate --scale helper=<old + 1> --wait), waits for its healthcheck (compose.yaml: /v1/health says ready),
#      and only then stops (30 s) and removes each old container. Past the bound (REDEPLOY_READY_S seconds, default
#      300) the new container is removed, the old one keeps serving, and it exits 1;
#   4. reloads Caddy with this checkout's Caddyfile through its admin socket inside the container (Caddyfile: admin
#      unix//config/caddy-admin.sock): Caddy swaps to the new config with no gap and skips a config that is unchanged. The
#      file goes in on stdin, since compose mounts the one file and a checkout writes a new one, which the running
#      container's mount never sees. A Caddy that step 3 started (none ran before) read this checkout's file at its start
#      and is not reloaded. A refused reload (a bad Caddyfile) leaves Caddy on the config it had and exits 1.
#   Before step 1, once the commit is found on main (objects only: no checkout, no .env), the socket is read: a running Caddy
#   with no socket (one started from a Caddyfile with `admin off`), or a helper running with no Caddy, is refused, naming
#   the one command that fixes it, with nothing changed, so a redeploy never ends with a new helper behind the old Caddy.
# It prints names and container ids, never values. REDEPLOY_REMOTE replaces the repository URL (the test's local repository).
# The release is read, raised and written here rather than computed from the commit's place on main: the number orders
# what this host ran, with its store, so a rollback gets the next number; a count on main would go down on a rollback.
set -euo pipefail

# Everything runs from this function, read whole before step 1 checks out a commit that may change this file.
main() {
  local sha="${1:-}"
  if [[ $# -ne 1 || ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: redeploy.sh <40-hex commit> (REDEPLOY_READY_S, if set: whole seconds, 1 to 9999)" >&2
    exit 2
  fi
  # the bound for step 3, checked with the other pre-checks so a bad one changes nothing
  local wait_s="${REDEPLOY_READY_S:-300}"
  if [[ ! "$wait_s" =~ ^[1-9][0-9]{0,3}$ ]]; then
    echo "usage: redeploy.sh <40-hex commit> (REDEPLOY_READY_S, if set: whole seconds, 1 to 9999)" >&2
    exit 2
  fi
  local deploy root remote
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  remote="${REDEPLOY_REMOTE:-https://github.com/UNRLZD/confidential-trenches.git}"

  # the commit first: one not on main never reaches the .env, so no release is read, named or written for it
  on_main "$root" "$remote" "$sha" || exit 1

  # the release is read next, so a refused .env changes nothing, the checkout included
  local env="$deploy/.env" release
  release="$(next_release "$env" "$sha")" || exit 1
  check_budgets "$env" || exit 1

  local caddy_ran
  caddy_ran="$(cd "$deploy" && caddy_socket)" || exit 1
  git -C "$root" checkout -q --detach "$sha"
  if [[ "$(git -C "$root" rev-parse HEAD)" != "$sha" ]]; then
    echo "redeploy: the checkout is not the commit" >&2
    exit 1
  fi

  cd "$deploy"
  export HELPER_COMMIT="$sha" HELPER_RELEASE="$release"
  build_helper
  # the two lines move only for an image that built and takes its settings
  write_env "$env" "$sha" "$release"
  swap_helper "$wait_s" "$sha"
  if [[ "$caddy_ran" == yes ]]; then
    reload_caddy
  else
    echo "redeploy: Caddy started with this checkout's Caddyfile (none ran before); no reload"
  fi
}

# Step 0. Fetches main whole into refs/remotes/origin/main (a shallow checkout, which every earlier depth-1 fetch left,
# is made complete once, so no earlier commit cuts the history short) and holds the commit only when it is a commit
# main descends from. No fetch by id: a remote may serve an id that is on no branch of it, so main itself is the check.
on_main() {
  local root="$1" remote="$2" sha="$3" whole=""
  if [[ "$(git -C "$root" rev-parse --is-shallow-repository)" == true ]]; then whole=--unshallow; fi
  git -C "$root" fetch -q --no-tags ${whole:+"$whole"} "$remote" "+refs/heads/main:refs/remotes/origin/main"
  if ! git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null || ! git -C "$root" merge-base --is-ancestor "$sha" refs/remotes/origin/main; then
    echo "redeploy: the commit is not on main of the repository (a typo, or a branch not merged); nothing changed" >&2
    return 1
  fi
}

# Before step 1: whether the running Caddy has its admin socket (prints yes), or no Caddy and no helper run (a first
# deploy: prints no). Any other state is refused before anything changes, naming the one command that fixes it, run from
# a checkout whose Caddyfile names the socket (this one's, once the redeploy is at a commit that has this check).
caddy_socket() {
  if [[ -n "$(docker compose ps -q caddy)" ]]; then
    if ! docker compose exec -T caddy sh -c 'test -S /config/caddy-admin.sock'; then
      echo "redeploy: the running Caddy has no admin socket (started from a Caddyfile with admin off), so it could not take this Caddyfile after the swap; nothing changed. Recreate it once from this checkout, then run this again: cd apps/helper/deploy && docker compose up -d --no-deps --force-recreate caddy" >&2
      return 1
    fi
    echo yes
  elif [[ -n "$(docker compose ps -q helper)" ]]; then
    echo "redeploy: a helper runs with no Caddy in front of it; nothing changed. Start it from this checkout, then run this again: cd apps/helper/deploy && docker compose up -d --no-deps caddy" >&2
    return 1
  else
    echo no
  fi
}

# Step 4. Caddy validates the new config before it swaps to it; on any refusal it keeps serving the one it had.
reload_caddy() {
  echo "redeploy: docker compose exec -T caddy caddy reload (the Caddyfile, through the admin socket)"
  if ! docker compose exec -T caddy caddy reload --config - --adapter caddyfile --address unix//config/caddy-admin.sock <Caddyfile; then
    echo "redeploy: Caddy did not reload the Caddyfile (above); it keeps the config it had, and the new helper serves behind it" >&2
    exit 1
  fi
  echo "redeploy: Caddy reloaded the Caddyfile (unchanged: Caddy kept its config)"
}

# Step 2. The new image and its own readers, with the environment compose passes it (the reader names variables, never
# values). A refusal exits before deploy/.env is written.
build_helper() {
  echo "redeploy: docker compose build helper"
  docker compose build helper
  echo "redeploy: docker compose run --rm --no-deps -T helper node src/env-check.ts"
  if ! docker compose run --rm --no-deps -T helper node src/env-check.ts; then
    echo "redeploy: the new helper refuses its senders' settings (above; a vault line on the vault before: apps/helper/deploy/vault-lines.sh); no helper was started or stopped" >&2
    exit 1
  fi
}

# Step 3. The new helper starts next to the old one (docker-rollout's pattern: --no-recreate keeps the running container
# and --scale adds one from the new image), compose waits for its healthcheck up to the bound, and only then is each old
# container stopped. Past the bound, or when what runs new is not this commit's image, the new container is removed and
# no old one is touched. The old ones get `docker stop -t 60`: past the helper's own drain (src/server.ts STOP_MS, 50 s),
# so a bind's answer (45 s) is never cut. Prints ids, never values.
swap_helper() {
  local wait_s="$1" sha="$2" old new id count stale
  # a stopped container of the service (a start that failed, a crash) is counted by --scale and started again in place
  # of one from the new image, so the swap would report a helper that never came: each is removed first
  stale="$(docker compose ps -a -q --status exited --status created --status dead helper)"
  for id in $stale; do
    docker rm "$id" >/dev/null
    echo "redeploy: removed the stopped helper $id"
  done
  old="$(docker compose ps -q helper)"
  if [[ -z "$old" ]]; then
    echo "redeploy: no helper running; docker compose up -d --wait (bound $wait_s s)"
    if ! docker compose up -d --wait --wait-timeout "$wait_s"; then
      echo "redeploy: the helper was not ready within $wait_s s" >&2
      exit 1
    fi
    return 0
  fi
  count="$(printf '%s\n' "$old" | grep -c .)"
  echo "redeploy: starting the new helper beside the old one (bound $wait_s s)"
  if ! docker compose up -d --no-deps --no-recreate --scale "helper=$((count + 1))" --wait --wait-timeout "$wait_s" helper; then
    # every container of the service that was not running before, a stopped or restarting one included; the old ones
    # are left alone
    new="$(docker compose ps -a -q helper | grep -vxF -f <(printf '%s\n' "$old") || true)"
    # its last lines before it goes, so the failure names its cause (card helper-ready-without-gt: 18:55-18:58Z a start
    # that exited at once was removed with its logs); the helper names variables, never their values
    for id in $new; do
      echo "redeploy: $id's last lines:" >&2
      docker logs --tail 30 "$id" 2>&1 | sed 's/^/  /' >&2 || true
      docker rm -f "$id" >/dev/null || true
    done
    echo "redeploy: the new helper was not ready within $wait_s s; the old one keeps serving" >&2
    exit 1
  fi
  new="$(docker compose ps -q helper | grep -vxF -f <(printf '%s\n' "$old") || true)"
  if ! from_image "ct-helper:$sha" "$new"; then
    for id in $new; do docker rm -f "$id" >/dev/null || true; done
    echo "redeploy: no new helper from ct-helper:$sha is running; the old one keeps serving" >&2
    exit 1
  fi
  for id in $old; do
    docker stop -t 60 "$id" >/dev/null
    docker rm "$id" >/dev/null
  done
  echo "redeploy: swapped: the new helper $(printf '%s' "$new" | tr '\n' ' ' | sed 's/ $//') is ready; stopped and removed the old $(printf '%s' "$old" | tr '\n' ' ' | sed 's/ $//')"
}

# Whether $2 names at least one container and every one runs image $1.
from_image() {
  local id
  [[ -n "$2" ]] || return 1
  for id in $2; do
    [[ "$(docker inspect -f '{{.Config.Image}}' "$id")" == "$1" ]] || return 1
  done
}

# The lines that set NAME in a .env, in any form compose may read (spaces, export, and its "NAME: value" form).
lines_of() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1" || true
}

# One plain NAME=value line or none; prints the value (to the caller's variable only).
plain_value() {
  local found re="^$2=$3\$"
  found="$(lines_of "$1" "$2")"
  [[ -z "$found" ]] && return 0
  if [[ "$found" == *$'\n'* || ! "$found" =~ $re ]]; then
    echo "redeploy: $2 in deploy/.env is not one plain $2=<value> line; nothing changed" >&2
    return 1
  fi
  printf '%s' "${found#"$2"=}"
}

# Whether VALUE is one the helper's start takes for budget NAME (src/limits/limits.ts budgetFromEnv; empty: the
# default): "<total>,<per client>" with the share under the total less the helper's own-read reserve (src/rpc/rpc.ts
# RPC_RESERVE: Solana 3; src/proxy/proxy.ts PROXY_RESERVE: Jupiter 34; every other 0); for RPC_BUDGET_* the share at
# least a full batch (RPC_BATCH_MAX, 10) and an optional third number, one method's limit, from 10 plus the reserve to
# the total.
budget_ok() {
  local name="$1" v="$2" n='[123456789][0123456789]{0,6}' reserve=0
  [[ -z "$v" ]] && return 0
  case "$name" in
    RPC_BUDGET_SOLANA) reserve=3 ;;
    PROXY_BUDGET_JUPITER) reserve=34 ;;
  esac
  if [[ "$name" == RPC_BUDGET_* ]]; then
    local re="^($n),($n)(,($n))?\$"
    [[ "$v" =~ $re ]] || return 1
    local total="${BASH_REMATCH[1]}" share="${BASH_REMATCH[2]}" method="${BASH_REMATCH[4]}"
    ((share < total - reserve && share >= 10)) || return 1
    [[ -z "$method" ]] || ((method >= 10 + reserve && method <= total))
  else
    local re="^($n),($n)\$"
    [[ "$v" =~ $re ]] || return 1
    ((BASH_REMATCH[2] < BASH_REMATCH[1] - reserve))
  fi
}

# Every budget variable compose may pass, from this shell's environment (which compose reads first) and from deploy/.env
# (one plain NAME=value line each), checked with budget_ok. Prints names, never values.
check_budgets() {
  local env="$1" name value names
  names="$(
    compgen -e | grep -E '^(RPC|PROXY)_BUDGET_[A-Z0-9_]+$' || true
    if [[ -e "$env" ]]; then grep -oE '^[[:space:]]*(export[[:space:]]+)?(RPC|PROXY)_BUDGET_[A-Z0-9_]+' "$env" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//' || true; fi
  )"
  for name in $(printf '%s\n' "$names" | sort -u); do
    if [[ -n "${!name+set}" ]] && ! budget_ok "$name" "${!name}"; then
      echo "redeploy: $name in this shell is not a budget the helper takes; nothing changed" >&2
      return 1
    fi
    if [[ -e "$env" ]]; then
      value="$(plain_value "$env" "$name" '.*')" || return 1
      if ! budget_ok "$name" "$value"; then
        echo "redeploy: $name in deploy/.env is not a budget the helper takes; nothing changed" >&2
        return 1
      fi
    fi
  done
  # a vendor with no key needs its budget set to the keyless plan (compose reads this shell first, then deploy/.env)
  local vendor key budget
  for vendor in JUPITER:JUPITER_API_KEY RELAY:RELAY_API_KEY LIFI:LIFI_API_KEY ONECLICK:ONECLICK_JWT; do
    key="${vendor#*:}" budget="PROXY_BUDGET_${vendor%%:*}"
    is_set "$env" "$key" || is_set "$env" "$budget" || {
      echo "redeploy: $key is unset: set it, or $budget to the plan without a key; nothing changed" >&2
      return 1
    }
  done
}

# Whether NAME reaches compose non-empty: from this shell if set there, else from its one plain line in deploy/.env.
# Reads the value only to test it; never prints it.
is_set() {
  local value=""
  if [[ -n "${!2+set}" ]]; then
    value="${!2}"
  elif [[ -e "$1" ]]; then
    value="$(plain_value "$1" "$2" '.*')" || return 1
  fi
  [[ -n "$value" ]]
}

# The release for this deploy: the same commit keeps it, another commit raises it by one, none starts at 1.
next_release() {
  local env="$1" sha="$2" was="" ran=""
  if [[ -e "$env" ]]; then
    was="$(plain_value "$env" HELPER_RELEASE '[1-9][0-9]{0,8}')" || return 1
    ran="$(plain_value "$env" HELPER_COMMIT '[0-9a-f]{40}')" || return 1
  fi
  if [[ -z "$was" ]]; then
    echo "redeploy: HELPER_RELEASE started at 1 (none before)" >&2
    echo 1
  elif [[ "$ran" == "$sha" ]]; then
    echo "redeploy: HELPER_RELEASE kept (the same HELPER_COMMIT)" >&2
    echo "$was"
  else
    echo "redeploy: HELPER_RELEASE raised by one (another HELPER_COMMIT)" >&2
    echo $((was + 1))
  fi
}

# Replaces the two lines in place (or adds them at the end), keeps every other line, and swaps the file in one rename.
write_env() {
  local env="$1" sha="$2" release="$3" tmp
  tmp="$(mktemp "$env.XXXXXX")"
  trap "rm -f '$tmp'" EXIT
  chmod 600 "$tmp"
  if [[ -e "$env" ]]; then
    awk -v c="$sha" -v r="$release" '
      /^HELPER_COMMIT=/ { print "HELPER_COMMIT=" c; dc = 1; next }
      /^HELPER_RELEASE=/ { print "HELPER_RELEASE=" r; dr = 1; next }
      { print }
      END { if (!dc) print "HELPER_COMMIT=" c; if (!dr) print "HELPER_RELEASE=" r }
    ' "$env" >"$tmp"
  else
    printf 'HELPER_COMMIT=%s\nHELPER_RELEASE=%s\n' "$sha" "$release" >"$tmp"
  fi
  mv -f "$tmp" "$env"
  trap - EXIT
  echo "redeploy: deploy/.env written (HELPER_COMMIT, HELPER_RELEASE), mode 600"
}

main "$@"; exit
