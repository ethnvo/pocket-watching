#!/usr/bin/env bash
# Builds dist/pocket-watching-<version>.zip for the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
node scripts/validate-community.mjs
mkdir -p dist
OUT="dist/pocket-watching-$VERSION.zip"
rm -f "$OUT"
zip -q -r "$OUT" manifest.json background.js content.js content.css options.html options.css options.js \
  community-pay.json seed-pay.json seed-companies.json icons LICENSE PRIVACY.md
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
