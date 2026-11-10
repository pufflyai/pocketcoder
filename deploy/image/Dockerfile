# Workspace image for pocketcoder development and doctor probes: the
# pocketcoder-supervisor and native structured session producers. Templates install
# their own coding-agent CLI.
#
# Build from the repository root:
#   bun build packages/supervisor/src/index.ts --target bun --outdir deploy/image/dist
#   docker build -t pocketcoder-workspace:dev deploy/image

# Bun embeds TLS and compression. Drop unused system OpenSSL and its zlib
# dependency rather than carrying their vulnerable code into the runtime.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2 AS glibc-base
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS glibc-runtime
COPY --from=glibc-base / /rootfs/
RUN rm /rootfs/usr/lib/*/libz.so.* \
    /rootfs/usr/lib/*/libcrypto.so.* /rootfs/usr/lib/*/libssl.so.* \
    /rootfs/var/lib/dpkg/status.d/zlib1g* /rootfs/var/lib/dpkg/status.d/libssl3t64* \
  && rm -rf /rootfs/usr/lib/*/engines-3 /rootfs/usr/lib/*/ossl-modules \
    /rootfs/usr/share/doc/zlib1g /rootfs/usr/share/doc/libssl3t64 \
    /rootfs/usr/share/lintian/overrides/libssl3t64

FROM scratch AS glibc
COPY --from=glibc-runtime /rootfs/ /
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun-glibc

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
ARG TARGETARCH
LABEL org.opencontainers.image.title="PocketCoder workspace" \
  org.opencontainers.image.source="https://github.com/pufflyai/pocketcoder" \
  io.pstdio.pocketcoder.bun.version="1.4.4" \
  dev.pstdio.pocketcoder.libc="glibc" \
  dev.pstdio.pocketcoder.glibc.root="/opt/glibc" \
  dev.pstdio.pocketcoder.glibc.base.digest="sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2"
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
COPY controller-probe.ts /opt/pocketcoder/controller-probe.ts
COPY pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
COPY write-session-image.ts quiesce.ts /opt/pocketcoder/
RUN chmod 0755 /usr/local/bin/pocketcoder-supervisor && bun /opt/pocketcoder/write-session-image.ts echo

# Non-root by default; templates pin uid/gid 10001 and the driver enforces
# it. WORKDIR must be accessible to that uid (the oven/bun default of
# /home/bun/app is not).
WORKDIR /
USER 10001:10001
ENV HOME=/tmp

# CMD, not ENTRYPOINT: the template's reviewed command is passed by the
# driver and must replace this default, never be appended to it.
CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
