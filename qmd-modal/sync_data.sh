#!/bin/bash
# Sync local qmd sources + config -> Modal Volume "qmd"
#   - tars ALL *.md (excl .git/node_modules) from /root/docs_config_memo
#   - uploads archive as volume file "src.tar"
#   - uploads active index.yml as "index/index.yml" (container uses identical abs paths)
#
# Usage: ./sync_data.sh
set -euo pipefail

REPO=/root/docs_config_memo
VOL=qmd
OUT=/tmp/qmd-src.tar

cd "$REPO"
echo "[1/3] building tarball of markdown sources..."
find . -name "*.md" -not -path "./.git/*" -not -path "*/node_modules/*" -type f -print0 \
  | tar -czf "$OUT" --null -T -
ls -lh "$OUT"

echo "[2/3] uploading $(basename "$OUT") + index.yml to volume $VOL..."
modal volume put --force "$VOL" "$OUT" src.tar >/dev/null
modal volume put --force "$VOL" /root/qmd-modal/index.modal.yml index/index.yml >/dev/null

echo "[3/3] extracting on Modal..."
modal run /root/qmd-modal/infra.py::sync_data
echo "DONE"
