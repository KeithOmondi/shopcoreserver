#!/usr/bin/env bash
# Fails if any k6-operator runner of the given TestRun exited non-zero.
# k6 exits 99 when a threshold (SLO) fails, so this turns SLO breaches into a failed deploy.
set -euo pipefail
name="$1"; ns="${2:-loadtest}"
codes=$(kubectl -n "$ns" get pods -l "k6_cr=$name,runner=true" \
  -o jsonpath='{range .items[*]}{.status.containerStatuses[0].state.terminated.exitCode}{"\n"}{end}')
[ -n "$codes" ] || { echo "no runner pods found for $name"; exit 1; }
if echo "$codes" | grep -qv '^0$'; then
  echo "load gate FAILED (runner exit codes: $(echo $codes | tr '\n' ' '))"
  kubectl -n "$ns" logs -l "k6_cr=$name,runner=true" --tail=60 || true
  exit 1
fi
echo "load gate passed ($(echo "$codes" | wc -l) runners)"
