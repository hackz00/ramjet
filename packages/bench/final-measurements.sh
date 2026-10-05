#!/usr/bin/env bash
# The measurement matrix behind docs/perf/RESULTS.md (sequential, one browser at a time, interleaved A/B inside each run).
# usage: bash final-measurements.sh <scenario>   (from packages/bench; results land in results/final/<scenario>/)
# scenarios: headline | shared-link | cpu4 | interaction | proxy-tax | post-rename
set -u
cd "$(dirname "$0")"
OUT=results/final
run() { # name, then bench args
  local name="$1"; shift
  mkdir -p "$OUT/$name"
  echo "=== $name: $*"
  node --no-warnings src/run.ts "$@" > "$OUT/$name/run.log" 2>&1
  for f in results/*-typical-cpu*.json; do
    [ -e "$f" ] && mv "$f" "$OUT/$name/$(basename "$f")"
  done
  tail -1 "$OUT/$name/run.log"
}
# move stray results of earlier runs out of the way so they cannot be mistaken for this scenario's
mkdir -p results/old; for f in results/*-typical-cpu*.json; do [ -e "$f" ] && mv "$f" results/old/; done
case "${1:-}" in
  headline)    run headline --dist baseline --dist current+assisted --profile typical --runs 7 --modes cold,warm,revisit ;;
  shared-link) run shared-link --dist baseline --dist current+assisted --profile typical --runs 5 --modes cold,warm --shared-link ;;
  cpu4)        run cpu4 --dist baseline --dist current+assisted --profile typical --runs 5 --modes cold,warm --cpu 4 ;;
  post-rename) run post-rename --dist measured+assisted --dist current+assisted --profile typical --runs 7 --modes cold,warm,revisit ;;
  proxy-tax)   run proxy-tax --dist current+native --dist current+assisted --profile typical --runs 7 --modes cold,warm --retention ;;
  interaction) run interaction --dist baseline --dist current+assisted --profile typical --runs 10 --fixtures interactive,frames,spa --modes cold --retention ;;
  *) echo "usage: $0 headline|shared-link|cpu4|interaction"; exit 2 ;;
esac
echo SCENARIO DONE
