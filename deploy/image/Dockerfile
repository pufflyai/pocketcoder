# Workspace image for pocketcoder development and doctor probes: the
# pocketcoder-agent supervisor plus the echo harness. Real deployments extend
# this pattern with AgentAPI and a coding-agent CLI installed by checksum.
#
# Build from the repository root:
#   bun build apps/pocketcoder-agent/src/index.ts --target bun --outdir deploy/image/dist
#   docker build -t pocketcoder-workspace:dev deploy/image

FROM oven/bun:1.3-slim AS agentapi-download
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

FROM oven/bun:1.3-slim

COPY dist/index.js /opt/pocketcoder/agent.js
COPY echo-harness.ts /opt/pocketcoder/echo-harness.ts
COPY pocketcoder-agent /usr/local/bin/pocketcoder-agent
COPY --from=agentapi-download /agentapi /usr/local/bin/agentapi
RUN chmod 0755 /usr/local/bin/pocketcoder-agent /usr/local/bin/agentapi \
	&& agentapi --version

# Non-root by default; templates pin uid/gid 10001 and the driver enforces
# it. WORKDIR must be accessible to that uid (the oven/bun default of
# /home/bun/app is not).
WORKDIR /
USER 10001:10001
ENV HOME=/tmp

# CMD, not ENTRYPOINT: the template's reviewed command is passed by the
# driver and must replace this default, never be appended to it.
CMD ["pocketcoder-agent", "supervise", "--launch-input", "/run/pocketcoder/input"]
