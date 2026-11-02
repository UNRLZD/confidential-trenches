#!/usr/bin/env bash
# Redeploys the helper on its server at one commit of the public repo (card helper-release-bump). Run on the server,
# from the checkout it updates:
#   apps/helper/deploy/redeploy.sh <40-hex commit>
# In order, stopping at the first failure (the .env is read before step 1, so a refused one changes nothing):
#   1. fetches the commit (depth 1) and checks it out, detached;
#   2. in deploy/.env, next to compose.yaml: sets HELPER_COMMIT to the commit and HELPER_RELEASE to the release number
#      send.ts reads (a whole number that only goes up, one per release): kept when the commit is the one already
#      there, one more when it is another (a rollback included), 1 when there was none. Every other line is kept byte
#      for byte, the file is replaced in one rename and stays mode 600. A HELPER_COMMIT or HELPER_RELEASE line not in
#      the plain NAME=value form, or written twice, is refused with nothing changed;
#   3. docker compose up -d --build with those two values.
# It prints names, never values. REDEPLOY_REMOTE replaces the repository URL (the test's local repository).
# The release is read, raised and written here rather than computed from the commit's place on main: the number orders
# what this host ran, with its store, so a rollback gets the next number; a count on main would go down on a rollback.
set -euo pipefail

# Everything runs from this function, read whole before step 1 checks out a commit that may change this file.
main() {
  local sha="${1:-}"
  if [[ $# -ne 1 || ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "usage: redeploy.sh <40-hex commit>" >&2
    exit 2
  fi
  local deploy root remote
  deploy="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(cd "$deploy/../../.." && pwd)"
  remote="${REDEPLOY_REMOTE:-https://github.com/UNRLZD/confidential-trenches.git}"

  # the release is read first, so a refused .env changes nothing, the checkout included
  local env="$deploy/.env" release
  release="$(next_release "$env" "$sha")" || exit 1

  git -C "$root" fetch -q --depth 1 "$remote" "$sha"
  git -C "$root" checkout -q --detach "$sha"
  if [[ "$(git -C "$root" rev-parse HEAD)" != "$sha" ]]; then
    echo "redeploy: the checkout is not the commit" >&2
    exit 1
  fi

  write_env "$env" "$sha" "$release"

  echo "redeploy: docker compose up -d --build"
  cd "$deploy"
  HELPER_COMMIT="$sha" HELPER_RELEASE="$release" docker compose up -d --build
}

# The lines that set NAME in a .env, in any form compose may read (spaces, export).
lines_of() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1" || true
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
