#!/usr/bin/env bash
# Exercise fetch-index's staleness detection against three fixture states.
set -u
cd "$(dirname "$0")/.."
export BEVY_MCP_OFFLINE=1
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A real tarball to download from, so the happy path is genuinely exercised.
# Staged per-case inside each fixture dir: a shared staging dir gets overwritten
# by the re-download in case 2, which would silently invalidate case 3.
TARBALL=/tmp/opencode/bevy-index-0.20.0.tar.gz

install_fixture() { # $1 = data dir, $2 = cache_version to stamp ("" = none)
  local dir="$1"
  mkdir -p "$dir/versions/0.20.0"
  # Unpack straight from the tarball so every case starts from the same bytes.
  tar -xzf "$TARBALL" -C "$dir"
  if [ -z "${2:-}" ]; then
    # Simulate a pre-format-version index: no cache_version in meta.json, and no
    # usable registry entry either.
    python3 - "$dir/versions/0.20.0/meta.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p)); m.pop("cache_version", None)
json.dump(m, open(p, "w"), indent=2)
PY
    echo '{"cache_version":4,"versions":{}}' > "$dir/registry.json"
  else
    python3 - "$dir/versions/0.20.0/meta.json" "$2" <<'PY'
import json, sys
p, cv = sys.argv[1], int(sys.argv[2])
m = json.load(open(p)); m["cache_version"] = cv
json.dump(m, open(p, "w"), indent=2)
PY
    echo "{\"cache_version\":$2,\"versions\":{}}" > "$dir/registry.json"
  fi
}

run() { # $1 = label, $2 = data dir, $3.. extra args
  echo "--- $1 ---"
  local label="$1" dir="$2"; shift 2
  BEVY_MCP_DATA_DIR="$dir" timeout 120 node scripts/fetch-index.mjs 0.20.0 \
    --from "file://$TARBALL" "$@" 2>&1 \
    | grep -Ev '^bevy-mcp (config|shared)' | head -6
}

# 1. current format -> should decline
D="$WORK/current"; install_fixture "$D" 5
run "current (v5): expect 'Nothing to do'" "$D"

# 2. stale format -> should re-download
D="$WORK/stale"; install_fixture "$D" 4
run "stale (v4): expect re-download" "$D"

# 3. no recorded format -> should re-download
D="$WORK/unknown"; install_fixture "$D" ""
run "unknown format: expect re-download" "$D"

# 4. unknown format but --no-recheck -> should decline
D="$WORK/nr"; install_fixture "$D" ""
run "unknown + --no-recheck: expect 'Nothing to do'" "$D" --no-recheck