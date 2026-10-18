# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .

FROM oven/bun:1.4.2-slim AS supervisor-build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js

# Keep examples on the same reviewed AgentAPI fix as the workspace image.
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS agentapi-build
ARG TARGETARCH
ENV GOTOOLCHAIN=local
WORKDIR /src
ADD --checksum=sha256:ac268b66c61be487bf3a3917a791abd10f3211b8ca8640897b884e2ba836d769 https://codeload.github.com/coder/agentapi/tar.gz/9ff117e231822f670305254ef24f6389f75953f4 /tmp/agentapi.tar.gz
COPY deploy/image/agentapi-identical-replies.patch /tmp/agentapi-identical-replies.patch
RUN apk add --no-cache patch \
  && tar -xzf /tmp/agentapi.tar.gz --strip-components=1 \
  && patch -p1 < /tmp/agentapi-identical-replies.patch \
  && go get golang.org/x/text@v0.41.0 \
  && go mod verify \
  && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -buildvcs=false -o /agentapi main.go

FROM oven/bun:1.4.2-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY examples/harnesses/pi/package.json examples/harnesses/pi/bun.lock ./
RUN bun install --production --frozen-lockfile

COPY --from=agentapi-build /agentapi /usr/local/bin/agentapi
COPY examples/harnesses/pi/agentapi-compat.ts /opt/pi/agentapi-compat.ts
COPY examples/harnesses/pi/persistent-pi.ts /opt/pi/persistent-pi.ts
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
