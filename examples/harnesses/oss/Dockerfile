# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/oss/Dockerfile -t pocketcoder-oss:dev .

FROM oven/bun:1.3.14-slim AS supervisor-build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
	&& bun build apps/pocketcoder-agent/src/index.ts --target bun --outfile /out/agent.js

FROM oven/bun:1.3.14-slim AS agentapi-download
ARG TARGETARCH
ARG AGENTAPI_VERSION=0.12.2
RUN case "$TARGETARCH" in \
		amd64) AGENTAPI_SHA256="fcc9318c50183c22e5fcbda1fa5a4838dc082b36fc91b6f01172730e86813125" ;; \
		arm64) AGENTAPI_SHA256="d4f76702f1ce852c4ba2027f51dae1a94d5b27e02b4aee20cd37eda8a8996c11" ;; \
		*) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac \
	&& AGENTAPI_URL="https://github.com/coder/agentapi/releases/download/v${AGENTAPI_VERSION}/agentapi-linux-${TARGETARCH}" \
	&& bun -e 'const response = await fetch(process.argv[1]); if (!response.ok) throw new Error(`download failed: ${response.status}`); await Bun.write(process.argv[2], response);' "$AGENTAPI_URL" /agentapi \
	&& echo "$AGENTAPI_SHA256  /agentapi" | sha256sum -c - \
	&& chmod 0755 /agentapi

FROM oven/bun:1.3.14-slim

WORKDIR /opt/oss
COPY examples/harnesses/oss/package.json examples/harnesses/oss/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --from=agentapi-download /agentapi /usr/local/bin/agentapi
COPY --from=supervisor-build /out/agent.js /opt/pocketcoder/agent.js
COPY deploy/image/pocketcoder-agent /usr/local/bin/pocketcoder-agent
COPY examples/harnesses/oss/run-codex /usr/local/bin/run-codex
COPY examples/harnesses/oss/run-opencode /usr/local/bin/run-opencode
RUN chmod 0755 /usr/local/bin/agentapi /usr/local/bin/pocketcoder-agent /usr/local/bin/run-codex /usr/local/bin/run-opencode \
	&& install -d -o 10001 -g 10001 /home/agent /workspace \
	&& agentapi --version \
	&& /opt/oss/node_modules/.bin/codex --version \
	&& /opt/oss/node_modules/.bin/opencode --version

WORKDIR /
USER 10001:10001
ENV HOME=/home/agent

CMD ["pocketcoder-agent", "supervise", "--launch-input", "/run/pocketcoder/input"]
