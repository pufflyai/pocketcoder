# Workspace image for pocketcoder development and doctor probes: the
# pocketcoder-supervisor plus the echo harness. Real deployments extend
# this pattern with AgentAPI and a coding-agent CLI installed by checksum.
#
# Build from the repository root:
#   bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
#   docker build -t pocketcoder-workspace:dev deploy/image

ARG TARGETARCH

FROM scratch AS agentapi-amd64
ADD --checksum=sha256:fcc9318c50183c22e5fcbda1fa5a4838dc082b36fc91b6f01172730e86813125 \
  https://github.com/coder/agentapi/releases/download/v0.12.2/agentapi-linux-amd64 /agentapi

FROM scratch AS agentapi-arm64
ADD --checksum=sha256:d4f76702f1ce852c4ba2027f51dae1a94d5b27e02b4aee20cd37eda8a8996c11 \
  https://github.com/coder/agentapi/releases/download/v0.12.2/agentapi-linux-arm64 /agentapi

FROM agentapi-${TARGETARCH} AS agentapi-download

FROM oven/bun:1.3-slim

COPY dist/index.js /opt/pocketcoder/supervisor.js
COPY echo-harness.ts /opt/pocketcoder/echo-harness.ts
COPY pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
COPY --from=agentapi-download /agentapi /usr/local/bin/agentapi
RUN chmod 0755 /usr/local/bin/pocketcoder-supervisor /usr/local/bin/agentapi \
  && agentapi --version

# Non-root by default; templates pin uid/gid 10001 and the driver enforces
# it. WORKDIR must be accessible to that uid (the oven/bun default of
# /home/bun/app is not).
WORKDIR /
USER 10001:10001
ENV HOME=/tmp

# CMD, not ENTRYPOINT: the template's reviewed command is passed by the
# driver and must replace this default, never be appended to it.
CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
