#!/usr/bin/env bash
# Redeploys the helper on its server at one commit of the public repo (card helper-release-bump). Run on the server,
# from the checkout it updates:
#   apps/helper/deploy/redeploy.sh <40-hex commit>
# In order, stopping at the first failure (the .env and the budgets are read before step 1, so a refused one changes
# nothing):
#   0. every RPC_BUDGET_* and PROXY_BUDGET_* compose may pass, from deploy/.env and from this shell, is checked with the
#      rule the helper's start applies (src/limits/limits.ts budgetFromEnv): a value it would refuse stops here, naming
#      the variable only, instead of leaving the container restarting; and each vendor's key (JUPITER_API_KEY,
#      RELAY_API_KEY, LIFI_API_KEY, ONECLICK_JWT) is set, or its PROXY_BUDGET_<VENDOR> names the keyless plan, as the
#      helper's start requires (src/proxy/proxy.ts checkVendorPlans);
#   1. fetches the commit (depth 1) and checks it out, detached;
#   2. in deploy/.env, next to compose.yaml: sets HELPER_COMMIT to the commit and HELPER_RELEASE to the release number
#      send.ts reads (a whole number that only goes up, one per release): kept when the commit is the one already
#      there, one more when it is another (a rollback included), 1 when there was none. Every other line is kept byte
#      for byte, the file is replaced in one rename and stays mode 600. A HELPER_COMMIT or HELPER_RELEASE line not in
#      the plain NAME=value form, or written twice, is refused with nothing changed;
#   3. swaps the helper with no gap, with those two values: builds the image (docker compose build helper) and runs its
#      pool senders' settings check (src/env-check.ts, the start's own readers) in a one-off container with the
#      environment compose gives the helper: a network set only in part, or a value the start would refuse, stops here,
#      with no helper started or stopped; with no helper
#      running (a first deploy) docker compose up -d --wait brings the stack up; otherwise starts the new helper beside the
#      old one (docker compose up --no-deps --no-recreate --scale helper=<old + 1> --wait), waits for its healthcheck
#      (compose.yaml: /v1/health says ready), and only then stops (30 s) and removes each old container. Past the bound
#      (REDEPLOY_READY_S seconds, default 300) the new container is removed, the old one keeps serving, and it exits 1.
#   4. caddy: made again (--force-recreate, its certificates kept in the caddy_data volume) when the HELPER_SITE compose
#      resolves differs from the running caddy's, since nothing else ever makes it read a new one (card hosts-main-on-top).
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

  # the release is read first, so a refused .env changes nothing, the checkout included
  local env="$deploy/.env" release
  release="$(next_release "$env" "$sha")" || exit 1
  check_budgets "$env" || exit 1

  git -C "$root" fetch -q --depth 1 "$remote" "$sha"
  git -C "$root" checkout -q --detach "$sha"
  if [[ "$(git -C "$root" rev-parse HEAD)" != "$sha" ]]; then
    echo "redeploy: the checkout is not the commit" >&2
    exit 1
  fi

  write_env "$env" "$sha" "$release"

  cd "$deploy"
  export HELPER_COMMIT="$sha" HELPER_RELEASE="$release"
  swap_helper "$wait_s" "$sha"
  caddy_site "$wait_s"
}

# Step 3. The new helper starts next to the old one (docker-rollout's pattern: --no-recreate keeps the running container
# and --scale adds one from the new image), compose waits for its healthcheck up to the bound, and only then is each old
# container stopped. Past the bound, or when what runs new is not this commit's image, the new container is removed and
# no old one is touched. The old ones get `docker stop -t 60`: past the helper's own drain (src/server.ts STOP_MS, 50 s),
# so a bind's answer (45 s) is never cut. Prints ids, never values.
swap_helper() {
  local wait_s="$1" sha="$2" old new id count stale
  echo "redeploy: docker compose build helper"
  docker compose build helper
  # the new image's own readers, with the environment compose passes it (the reader names variables, never values)
  echo "redeploy: docker compose run --rm --no-deps -T helper node src/env-check.ts"
  if ! docker compose run --rm --no-deps -T helper node src/env-check.ts; then
    echo "redeploy: the new helper refuses its pool senders' settings (above); no helper was started or stopped" >&2
    exit 1
  fi
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

# Step 4 (card hosts-main-on-top). Caddy serves the names in HELPER_SITE, read once when its container is made: the
# helper's swap never touches it (--no-deps --no-recreate), and the Caddyfile turns the admin endpoint off, so nothing
# reloads it. The value compose resolves now (this shell's HELPER_SITE, else deploy/.env's, else compose.yaml's default,
# read with `docker compose config caddy`) is compared with the running container's (its Config.Env); when they differ,
# or no caddy runs, caddy is made again from the same image. Its certificates live in the named volume caddy_data
# (compose.yaml: caddy_data:/data, and caddy_data under volumes:), so a recreate keeps them and asks the CA only for a
# name it has none for. Prints that it changed, never the names.
caddy_site() {
  local wait_s="$1" id want have
  # compose prints the value plain, or quoted when YAML needs it: the quotes are taken off
  want="$(docker compose config caddy | sed -n 's/^[[:space:]]*HELPER_SITE:[[:space:]]*//p' | head -n 1 | sed -E "s/^[\"']//; s/[\"']\$//")"
  if [[ -z "$want" ]]; then
    echo "redeploy: compose resolves no HELPER_SITE for caddy; caddy left as it is" >&2
    exit 1
  fi
  id="$(docker compose ps -q caddy | head -n 1)"
  if [[ -n "$id" ]]; then
    have="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n 's/^HELPER_SITE=//p' | head -n 1)"
    if [[ "$have" == "$want" ]]; then
      echo "redeploy: caddy's HELPER_SITE is unchanged; caddy left running"
      return 0
    fi
    echo "redeploy: caddy's HELPER_SITE changed; docker compose up -d --no-deps --force-recreate --wait caddy"
  else
    echo "redeploy: no caddy running; docker compose up -d --no-deps --force-recreate --wait caddy"
  fi
  if ! docker compose up -d --no-deps --force-recreate --wait --wait-timeout "$wait_s" caddy; then
    echo "redeploy: caddy was not running within $wait_s s" >&2
    exit 1
  fi
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
