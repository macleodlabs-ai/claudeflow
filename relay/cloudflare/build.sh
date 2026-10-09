#!/bin/sh
# Copies the phone page and its sealing code from the plugin into ./public, which the Worker serves as static assets.
#   ./build.sh && npx wrangler dev          (local, no account needed)
#   ./build.sh && npx wrangler deploy       (needs `npx wrangler login` once)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/public"
cp "$here/../../plugins/streams/bridge/app.html" "$here/public/index.html"
cp "$here/../../plugins/streams/bridge/seal.js" "$here/public/seal.js"
echo "public/ ready"
