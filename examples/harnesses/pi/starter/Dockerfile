# Pi as a managed-session producer. Build from this directory, outside the PocketCoder repository:
#
#   docker build \
#     --build-arg POCKETCODER_WORKSPACE_IMAGE='ghcr.io/pufflyai/pocketcoder/workspace@sha256:<digest>' \
#     -t registry.example/pocketcoder-pi-starter:1 .
#
# The base is a published, digest-pinned PocketCoder workspace image: it supplies the supervisor
# at /opt/pocketcoder/supervisor.js. Pi comes from npm at the exact versions in bun.lock.
ARG POCKETCODER_WORKSPACE_IMAGE
FROM ${POCKETCODER_WORKSPACE_IMAGE}

USER 0:0
WORKDIR /opt/pi
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src/ /opt/pi/src/
COPY write-workload.ts /opt/pi/write-workload.ts
# Add your own tools, skills or AGENTS.md here; anything under /opt is hashed as image-owned code.
RUN bun build /opt/pi/src/execution-adapter.ts --target bun --outfile /opt/pocketcoder/pi-adapter.js \
  && bun /opt/pi/src/check-pi.ts

# The base image's entrypoint, recorded in the manifest the driver verifies.
ARG POCKETCODER_ENTRYPOINT='["/usr/local/bin/docker-entrypoint.sh"]'
RUN bun /opt/pi/write-workload.ts "$POCKETCODER_ENTRYPOINT"

WORKDIR /
USER 10001:10001
ENV HOME=/home/agent
CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
