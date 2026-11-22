#!/usr/bin/env bash
# The unplug drill's off switch (card helper-unplug-off; markets.md H3.7 row M4.5 and §3 step 3, vault.md VT-R03): every
# server of ours stopped, and started again after the drill. Run on the helper's server, from the checkout redeploy.sh
# deploys:
#   apps/helper/deploy/unplug.sh off      stops every container of the stack: the helper (the API proxy, the market
#                                         data, the relayers and the order sender all run in it) and Caddy in front of it
#   apps/helper/deploy/unplug.sh on       starts the containers off stopped: the helper first, Caddy once the helper's
#                                         health says ready (UNPLUG_READY_S seconds at most, default 300)
#   apps/helper/deploy/unplug.sh status   one line per service: running, stopped or none
# off stops and never removes (docker compose stop): the containers, the helper's store, Caddy's certificates and
# deploy/.env stay as they were, so on brings back the same helper at the HELPER_COMMIT and HELPER_RELEASE it had, with
# no build and no release raised; a stopped container stays stopped through a Docker restart (restart: unless-stopped).
# off passes only when no container of the stack runs after it, read back; on only when the helper is ready and Caddy
# runs. A helper that never gets ready leaves Caddy stopped, so nothing answers for a helper that is not whole.
# The paper's "its DNS name removed" (markets.md l.1542) is replaced by this switch: with Caddy stopped nothing answers
# on the host's 80 or 443, which scripts/drill/servers-down.mjs reads from outside; a removed name proves nothing more
# and slows the return. The app and the signing page are static files on Cloudflare Pages, with no code of ours on a
# server: they stay up, and servers-down.mjs reports them without judging them.
# HELPER_COMMIT comes from this shell or deploy/.env, as compose reads it; COMPOSE_PROJECT_NAME, when set, names
# another stack (the local proof's). It prints service names, states and the commit, never a value of deploy/.env.
set -euo pipefail

SERVICES=(helper caddy)
ST=

usage() {
  echo "usage: unplug.sh off|on|status (UNPLUG_READY_S, if set: whole seconds, 1 to 9999)" >&2
  exit 2
}

# Sets ST to running, stopped (a container that is not running) or none, for one service. A docker that does not
# answer stops the switch (exit 1): read as "none", a status would say a stack is off that was never read.
state() {
  local run all
  run="$(docker compose ps -q --status running "$1")" || { echo "unplug: docker compose ps did not answer; nothing read" >&2; exit 1; }
  all="$(docker compose ps -a -q "$1")" || { echo "unplug: docker compose ps did not answer; nothing read" >&2; exit 1; }
  if [[ -n "$run" ]]; then ST=running; elif [[ -n "$all" ]]; then ST=stopped; else ST=none; fi
}

status() {
  local s
  for s in "${SERVICES[@]}"; do state "$s" && echo "unplug: $s $ST"; done
}

off() {
  echo "unplug: docker compose stop ${SERVICES[*]}"
  docker compose stop -t 30 "${SERVICES[@]}"
  local s up=()
  for s in "${SERVICES[@]}"; do
    state "$s"
    if [[ "$ST" == running ]]; then up+=("$s"); fi
  done
  status
  if [[ ${#up[@]} -gt 0 ]]; then
    echo "unplug: still running after the stop: ${up[*]}" >&2
    exit 1
  fi
  echo "unplug: off, no server of the stack runs"
}

on() {
  local wait_s="$1" commit="$2" id ids h waited=0
  state helper
  if [[ "$ST" == none ]]; then
    echo "unplug: no helper container to start; deploy one with redeploy.sh <commit>" >&2
    exit 1
  fi
  echo "unplug: docker compose start helper (commit $commit)"
  docker compose start helper
  while :; do
    h=healthy
    ids="$(docker compose ps -q --status running helper)" || { echo "unplug: docker compose ps did not answer" >&2; exit 1; }
    [[ -z "$ids" ]] && h=waiting
    for id in $ids; do
      [[ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" == healthy ]] || h=waiting
    done
    [[ "$h" == healthy ]] && break
    if [[ $waited -ge $wait_s ]]; then
      status
      echo "unplug: the helper was not ready after $wait_s s; Caddy left stopped" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "unplug: docker compose start caddy"
  docker compose start caddy
  status
  state caddy
  if [[ "$ST" != running ]]; then
    echo "unplug: Caddy did not start" >&2
    exit 1
  fi
  echo "unplug: on, the helper ready at $commit behind Caddy"
}

main() {
  [[ $# -eq 1 && "$1" =~ ^(off|on|status)$ ]] || usage
  local wait_s="${UNPLUG_READY_S:-300}"
  [[ "$wait_s" =~ ^[1-9][0-9]{0,3}$ ]] || usage
  cd "$(dirname "${BASH_SOURCE[0]}")"
  # every compose command resolves the helper's image from HELPER_COMMIT (compose.yaml), so it is checked first
  local commit="${HELPER_COMMIT:-}"
  if [[ -z "$commit" && -f .env ]]; then commit="$(sed -n 's/^HELPER_COMMIT=//p' .env | head -n 1)"; fi
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "unplug: HELPER_COMMIT is not a 40-hex commit in this shell or deploy/.env; nothing changed" >&2
    exit 2
  fi
  case "$1" in
    status) status ;;
    off) off ;;
    on) on "$wait_s" "$commit" ;;
  esac
}

main "$@"
