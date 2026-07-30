# Workspace image for pocketcoder development and doctor probes: the
# pocketcoder-agent supervisor plus the echo harness. Real deployments extend
# this pattern with AgentAPI and a coding-agent CLI installed by checksum.
#
# Build from the repository root:
#   bun build apps/pocketcoder-agent/src/index.ts --target bun --outdir deploy/image/dist
#   docker build -t pocketcoder-workspace:dev deploy/image

FROM oven/bun:1.3-slim

COPY dist/index.js /opt/pocketcoder/agent.js
COPY echo-harness.ts /opt/pocketcoder/echo-harness.ts
COPY pocketcoder-agent /usr/local/bin/pocketcoder-agent
RUN chmod 0755 /usr/local/bin/pocketcoder-agent

# Non-root by default; templates pin uid/gid 10001 and the driver enforces
# it. WORKDIR must be accessible to that uid (the oven/bun default of
# /home/bun/app is not).
WORKDIR /
USER 10001:10001
ENV HOME=/tmp

# CMD, not ENTRYPOINT: the template's reviewed command is passed by the
# driver and must replace this default, never be appended to it.
CMD ["pocketcoder-agent", "supervise", "--launch-input", "/run/pocketcoder/input"]
