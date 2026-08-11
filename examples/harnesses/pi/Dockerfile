# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .

FROM oven/bun:1.3.14-slim AS supervisor-build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js

ARG TARGETARCH

FROM scratch AS agentapi-amd64
ADD --checksum=sha256:fcc9318c50183c22e5fcbda1fa5a4838dc082b36fc91b6f01172730e86813125 \
  https://github.com/coder/agentapi/releases/download/v0.12.2/agentapi-linux-amd64 /agentapi

FROM scratch AS agentapi-arm64
ADD --checksum=sha256:d4f76702f1ce852c4ba2027f51dae1a94d5b27e02b4aee20cd37eda8a8996c11 \
  https://github.com/coder/agentapi/releases/download/v0.12.2/agentapi-linux-arm64 /agentapi

FROM agentapi-${TARGETARCH} AS agentapi-download

FROM oven/bun:1.3.14-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY examples/harnesses/pi/package.json examples/harnesses/pi/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --from=agentapi-download /agentapi /usr/local/bin/agentapi
COPY examples/harnesses/pi/agentapi-compat.ts /opt/pi/agentapi-compat.ts
COPY examples/harnesses/pi/workspace/ /opt/pocketcoder-fixtures/
COPY examples/harnesses/pi/run-pi /usr/local/bin/run-pi
COPY --from=supervisor-build /out/supervisor.js /opt/pocketcoder/supervisor.js
COPY deploy/image/pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
RUN chmod 0755 /usr/local/bin/agentapi /usr/local/bin/run-pi /usr/local/bin/pocketcoder-supervisor \
  && agentapi --version \
  && /opt/pi/node_modules/.bin/pi --version

WORKDIR /
USER 10001:10001
ENV HOME=/home/agent

CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
