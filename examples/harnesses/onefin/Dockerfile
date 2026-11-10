# Build from the PocketCoder repository root. Copy only Onefin tools and assets.
ARG ONEFIN_TOOLS=onefin-pstdio:local
FROM ${ONEFIN_TOOLS} AS tools
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js && bun build examples/harnesses/onefin/start.ts --target bun --outfile /out/onefin.js
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*
COPY --from=tools /opt/pi /opt/pi
COPY --from=tools /opt/onefin-cli /opt/onefin-cli
COPY --from=tools /opt/onefin/gateway-provider.mjs /opt/onefin/native-payload.mjs /opt/onefin/agent-tracing.mjs /opt/onefin/turn-context.mjs /opt/onefin/AGENTS.md /opt/onefin/
COPY --from=tools /opt/onefin/skills /opt/onefin/skills
COPY --from=tools /usr/local/bin/docufin /usr/local/bin/docufin
COPY --from=build /out/supervisor.js /opt/pocketcoder/supervisor.js
COPY --from=build /out/onefin.js /opt/pocketcoder/onefin.js
COPY deploy/image/write-session-image.ts deploy/image/quiesce.ts /opt/pocketcoder/
COPY deploy/image/pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
COPY examples/harnesses/onefin/ /opt/pocketcoder/onefin/
RUN ln -s /usr/local/bin/bun /usr/local/bin/node && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi && ln -s /opt/pi/node_modules /opt/onefin/node_modules && ln -s /opt/onefin-cli/node_modules/.bin/onefin /usr/local/bin/onefin && ln -s /opt/pocketcoder/onefin/docufin-token.ts /usr/local/bin/docufin-token && chmod 0755 /usr/local/bin/pocketcoder-supervisor /opt/pocketcoder/onefin/docufin-token.ts
RUN bun /opt/pocketcoder/write-session-image.ts onefin
WORKDIR /
USER 10001:10001
CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
