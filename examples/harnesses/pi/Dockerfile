# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .

FROM oven/bun:1.3.14-slim AS supervisor-build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
	&& bun build apps/pocketcoder-agent/src/index.ts --target bun --outfile /out/agent.js

FROM oven/bun:1.3.14-slim

WORKDIR /opt/pi-harness
COPY examples/harnesses/pi/package.json examples/harnesses/pi/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY examples/harnesses/pi/app.ts examples/harnesses/pi/session.ts examples/harnesses/pi/index.ts ./
COPY --from=supervisor-build /out/agent.js /opt/pocketcoder/agent.js
COPY deploy/image/pocketcoder-agent /usr/local/bin/pocketcoder-agent
RUN chmod 0755 /usr/local/bin/pocketcoder-agent

WORKDIR /
USER 10001:10001
ENV HOME=/home/agent

CMD ["pocketcoder-agent", "supervise", "--launch-input", "/run/pocketcoder/input"]
