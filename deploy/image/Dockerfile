# Workspace image for pocketcoder development and doctor probes: the
# pocketcoder-supervisor, AgentAPI and the echo harness. Templates install
# their own coding-agent CLI.
#
# Build from the repository root:
#   bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
#   docker build -t pocketcoder-workspace:dev deploy/image

FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS agentapi-chat
# Rebuild the same signed v0.12.2 source: its released binaries contain
# vulnerable Go and x/text versions. Keep its embedded chat UI.
ADD --checksum=sha256:ac268b66c61be487bf3a3917a791abd10f3211b8ca8640897b884e2ba836d769 \
  https://codeload.github.com/coder/agentapi/tar.gz/9ff117e231822f670305254ef24f6389f75953f4 /tmp/agentapi.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/agentapi.tar.gz --strip-components=1
WORKDIR /src/chat
RUN bun install --frozen-lockfile \
  && sed -i '/const nextConfig: NextConfig = {/a\  generateBuildId: async () => "9ff117e231822f670305254ef24f6389f75953f4",' next.config.ts \
  && NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_BASE_PATH=/magic-base-path-placeholder bun --bun run build \
  && cp -r out/. /src/lib/httpapi/chat/ \
  && rm -rf node_modules .next out

FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS agentapi-build
ARG TARGETARCH
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY --from=agentapi-chat /src/ /src/
RUN go get golang.org/x/text@v0.39.0 \
  && go mod verify \
  && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -buildvcs=false -o /agentapi main.go

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2 AS glibc
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS bun-glibc

FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373
ARG TARGETARCH
LABEL org.opencontainers.image.title="PocketCoder workspace" \
  org.opencontainers.image.source="https://github.com/pufflyai/pocketcoder" \
  io.pstdio.pocketcoder.bun.version="1.4.3" \
  io.pstdio.pocketcoder.agentapi.version="0.12.2" \
  io.pstdio.pocketcoder.agentapi.revision="9ff117e231822f670305254ef24f6389f75953f4" \
  io.pstdio.pocketcoder.agentapi.go.version="1.27.2" \
  io.pstdio.pocketcoder.agentapi.x-text.version="0.39.0" \
  dev.pstdio.pocketcoder.libc="glibc" \
  dev.pstdio.pocketcoder.glibc.root="/opt/glibc" \
  dev.pstdio.pocketcoder.glibc.base.digest="sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2"
# Desktop/browser installs fail closed if the signed package indexes change.
# The indexes pin all package versions, including indirect dependencies.
RUN case "$TARGETARCH" in \
      amd64) printf '%s\n' \
        '42c9134738be2d87c35ebdabdaa23b72b79160c3dfa8bfbee727612cf5c04329' \
        '24fc2ccb08f3125429a38b31bd6c76a7b394c6236df0975760dc8259e50dfbd5' ;; \
      arm64) printf '%s\n' \
        '1f16499aa3c91409911de0d6cc0f9d3afddafec96dfa6924479ed9d0b1228b64' \
        '28053719c18be2ee9cf4dfaa9703450225628ed1f2bded0f3758d72b4fb57634' ;; \
      *) exit 1 ;; \
    esac | sort > /opt/apk-index-checksums
# Openbox needs a passwd record for the UID enforced by the workspace driver.
RUN addgroup -g 10001 pocketcoder \
  && adduser -D -H -u 10001 -G pocketcoder -h /tmp pocketcoder
# Checkpoint FFI needs glibc's real directory ABI. Keep Debian metadata with
# its exact runtime bytes so the release gate can scan this root separately.
# Alpine desktop/browser programs keep their musl library search paths.
COPY --from=glibc / /opt/glibc/
COPY --from=bun-glibc /usr/local/bin/bun /usr/local/bin/bun
RUN case "$TARGETARCH" in \
      amd64) ln -s /opt/glibc/usr/lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu \
        && mkdir -p /lib64 \
        && ln -s /opt/glibc/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2 ;; \
      arm64) ln -s /opt/glibc/usr/lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu \
        && ln -s /opt/glibc/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1 ;; \
      *) exit 1 ;; \
    esac

COPY dist/index.js /opt/pocketcoder/supervisor.js
COPY echo-harness.ts /opt/pocketcoder/echo-harness.ts
COPY pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
COPY --from=agentapi-build /agentapi /usr/local/bin/agentapi
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
