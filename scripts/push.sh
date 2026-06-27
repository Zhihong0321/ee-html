#!/usr/bin/env bash
# Push a folder of HTML files to the host as one app.
#
# Usage:
#   HOST=https://your-app.up.railway.app API_KEY=xxx \
#     ./scripts/push.sh ./my-app-dir [slug] [name]
#
# Requires: zip, curl

set -euo pipefail

DIR="${1:?Usage: push.sh <dir> [slug] [name]}"
SLUG="${2:-}"
NAME="${3:-}"
HOST="${HOST:?Set HOST to your host base URL}"
API_KEY="${API_KEY:?Set API_KEY}"

if [ ! -f "$DIR/index.html" ]; then
  echo "Error: $DIR must contain index.html at its root." >&2
  exit 1
fi

TMP="$(mktemp -d)"
ZIP="$TMP/bundle.zip"
( cd "$DIR" && zip -qr "$ZIP" . )

ARGS=(-sS -X POST "$HOST/api/apps"
  -H "Authorization: Bearer $API_KEY"
  -F "bundle=@$ZIP;type=application/zip")
[ -n "$SLUG" ] && ARGS+=(-F "slug=$SLUG")
[ -n "$NAME" ] && ARGS+=(-F "name=$NAME")

curl "${ARGS[@]}"
echo
rm -rf "$TMP"
