#!/bin/bash
# Fast sync: push ONLY the pi-memory directory (~100KB) to Modal and rebuild its index.
# Use after memory writes so memory_search sees fresh content.
# (qmd 2.8.3 neumí FTS update u změněných dokumentů -> nutný rebuild kolekce)
set -euo pipefail
REPO=/root/docs_config_memo
OUT=/tmp/qmd-mem.tar

cd "$REPO"
find .pi/agent/memory -name "*.md" -type f -print0 | tar -czf "$OUT" --null -T -
modal volume put --force qmd "$OUT" src.tar >/dev/null
modal run /root/qmd-modal/infra.py::sync_data >/dev/null
modal run /root/qmd-modal/infra.py::rebuild_pi_memory >/dev/null
echo "✓ pi-memory synced + rebuilt on Modal"
