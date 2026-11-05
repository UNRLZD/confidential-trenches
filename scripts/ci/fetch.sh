#!/usr/bin/env bash
# Card ci-cargo-near-cached: a pinned release file, from the cache when the cache holds it, so a download host's 504 or
# crawl never turns a job red once the file is cached. PR #293's vault-sandbox-build (job 127307073012) died on seven
# 504s over 63 s from github.com/near/cargo-near/releases, past curl's six tries.
#   bash scripts/ci/fetch.sh <file> <sha256> <url>
# The workflow restores <file> with actions/cache/restore (its key names the file's version and this sha256) before it,
# and saves it with actions/cache/save after it on a miss. Here the file is checked against the sha256 first: a cached
# file that matches is used with no request at all; one that does not is refused (a warning names it), deleted and
# fetched again. A fetch is curl with its own retry (--retry 6 --retry-all-errors, a doubling wait of 63 s in all), and
# the fetched bytes must match the sha256 too, or the step fails and nothing is left at <file> for the save.
# scripts/ci/download-retry.mjs refuses a workflow's curl to a file and a fetch.sh with no cache in front of it.
set -euo pipefail
[ "$#" = 3 ] || { echo "usage: fetch.sh <file> <sha256> <url>" >&2; exit 2; }
file=$1 sum=$2 url=$3
[[ $sum =~ ^[0-9a-f]{64}$ ]] || { echo "fetch.sh: not a sha256: $sum" >&2; exit 2; }
if [ -e "$file" ]; then
  if echo "$sum  $file" | sha256sum -c --status -; then
    echo "fetch.sh: $file from the cache, sha256 $sum"
    exit 0
  fi
  echo "::warning::fetch.sh: the cached $file is not sha256 $sum: refused and fetched again (gh cache delete the entry)"
  rm -f "$file"
fi
mkdir -p "$(dirname "$file")"
rm -f "$file.part"
curl -sSfL --retry 6 --retry-all-errors -o "$file.part" "$url"
if ! echo "$sum  $file.part" | sha256sum -c --status -; then
  rm -f "$file.part"
  echo "fetch.sh: $url is not sha256 $sum" >&2
  exit 1
fi
mv "$file.part" "$file"
echo "fetch.sh: $file fetched from $url, sha256 $sum"
