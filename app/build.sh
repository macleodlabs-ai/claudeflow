#!/usr/bin/env bash
# Builds the phone/tablet app into the relay's static assets (relay/cloudflare/public), which `wrangler deploy` serves.
set -euo pipefail
cd "$(dirname "$0")"
out=../relay/cloudflare/public
bun install --frozen-lockfile
rm -rf "$out"
mkdir -p "$out"
bun build src/main.ts --outfile "$out/app.js" --target browser --minify
bun build src/pair.ts --outfile "$out/pair.js" --target browser --minify
# The service worker shows pushes (kind only) and opens the app on tap; served from the root so its scope is the app.
bun build src/sw.ts --outfile "$out/sw.js" --target browser --minify
cp index.html pair.html styles.css manifest.webmanifest icon.svg icon.png mark.svg strands.svg "$out/"
echo "built $(ls "$out" | tr '\n' ' ')into $out"
