#!/usr/bin/env bash
# Rebuild every persisted index at the current CACHE_VERSION.
#
# Each build is ~10 min (HTML parse -> NDJSON -> FlexSearch), so six run
# sequentially: they are CPU-bound and each needs ~4 GB of heap, and running
# them in parallel would thrash rather than help.
#
# Usage: scripts/rebuild-all-indexes.sh [version ...]
set -u

cd "$(dirname "$0")/.."
export BEVY_MCP_OFFLINE=1
export NODE_OPTIONS=--max-old-space-size=6144

VERSIONS=("$@")
if [ ${#VERSIONS[@]} -eq 0 ]; then
  VERSIONS=(0.15.3 0.16.1 0.17.3 0.18.1 0.19.1 0.20.0)
fi

for v in "${VERSIONS[@]}"; do
  # 0.19.1 keeps its mirror inside the repo; the rest live in the cache dir.
  if [ "$v" = "0.19.1" ]; then
    doc_dir="$PWD/bevy-docs-$v"
  else
    doc_dir="$HOME/.cache/bevy-mcp/bevy-$v"
  fi

  if [ ! -d "$doc_dir" ]; then
    echo "!! $v: no rustdoc mirror at $doc_dir -- skipping"
    continue
  fi

  echo "=== $v ($(find "$doc_dir" -name '*.html' | wc -l) pages) ==="
  start=$(date +%s)
  BEVY_VERSION="$v" BEVY_DOC_DIR="$doc_dir" BEVY_MCP_DATA_DIR="$PWD/data" \
    node scripts/build-index.mjs "$v" --force 2>&1 | grep -E "wrote|loaded|build complete|Error|error"
  status=$?
  echo "    $v finished in $(( $(date +%s) - start ))s (exit $status)"
done

echo
echo "=== registry summary ==="
node -e '
const r = require("./data/registry.json");
for (const [k, v] of Object.entries(r.versions)) {
  console.log(
    `  ${k.padEnd(8)} cache_version=${v.cache_version ?? "MISSING"} ` +
    `records=${String(v.records).padStart(7)} fields=${String(v.by_kind?.field ?? 0).padStart(5)}`
  );
}
'