# The Claudeflow relay: forwards sealed messages between Macs and their phones, and serves the phone page.
# Build from the repository root:  docker build -f relay/Dockerfile -t claudeflow-relay .
FROM oven/bun:1-alpine
WORKDIR /app
COPY relay/server.ts relay/server.ts
COPY plugins/streams/bridge/app.html plugins/streams/bridge/seal.js plugins/streams/bridge/
ENV PORT=8787
EXPOSE 8787
USER bun
CMD ["bun", "relay/server.ts"]
