#!/bin/sh
# Runs the claudeflow phone bridge at login (a launchd agent), then prints the link that pairs your phone.
# Remove it with: launchctl bootout gui/$(id -u)/ai.macleodlabs.claudeflow-bridge && rm ~/Library/LaunchAgents/ai.macleodlabs.claudeflow-bridge.plist
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bun=$(command -v bun) || { echo "bun is needed: https://bun.sh" >&2; exit 1; }
label=ai.macleodlabs.claudeflow-bridge
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claudeflow"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$bun</string><string>$here/server.ts</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CLAUDEFLOW_HOST</key><string>${CLAUDEFLOW_HOST:-127.0.0.1}</string>
    <key>CLAUDEFLOW_PORT</key><string>${CLAUDEFLOW_PORT:-7878}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.claudeflow/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.claudeflow/bridge.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Bridge running at login (log: ~/.claudeflow/bridge.log)."
"$bun" "$here/server.ts" pair
