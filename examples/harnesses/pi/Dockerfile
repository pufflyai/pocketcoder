# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .

FROM oven/bun:1.4.2-slim AS supervisor-build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js


FROM oven/bun:1.4.2-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY examples/harnesses/pi/package.json examples/harnesses/pi/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY examples/harnesses/pi/persistent-pi.ts /opt/pi/persistent-pi.ts
COPY examples/harnesses/pi/workspace/ /opt/pocketcoder-fixtures/
COPY examples/harnesses/pi/run-pi /usr/local/bin/run-pi
COPY --from=supervisor-build /out/supervisor.js /opt/pocketcoder/supervisor.js
COPY deploy/image/pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
COPY deploy/image/write-session-image.ts deploy/image/quiesce.ts /opt/pocketcoder/
RUN chmod 0755 /usr/local/bin/run-pi /usr/local/bin/pocketcoder-supervisor \
  && /opt/pi/node_modules/.bin/pi --version && bun /opt/pocketcoder/write-session-image.ts pi

WORKDIR /
USER 10001:10001
ENV HOME=/home/agent

CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
