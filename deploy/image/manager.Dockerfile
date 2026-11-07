# Build from the repository root. Operator credentials are supplied at runtime.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/manager/src/index.ts --target bun --outdir /out \
  && mkdir -p /private/manager_data \
  && chown 10001:10001 /private/manager_data \
  && chmod 0700 /private/manager_data

# Rebuild kubectl with the Go, HTTP/2 and HTML parser security fixes.
FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS kubectl
ARG TARGETARCH
ENV GOWORK=off
WORKDIR /src
ADD --checksum=sha256:b390f0c5446a9414e8f0a7019ca54f858251187d193217a8051687bf7a960d01 https://github.com/kubernetes/kubernetes/archive/refs/tags/v1.35.9.tar.gz /tmp/kubernetes.tar.gz
RUN tar -xzf /tmp/kubernetes.tar.gz --strip-components=1 \
  && GOFLAGS=-mod=mod go get golang.org/x/net@v0.62.0 \
  && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH GOFLAGS=-mod=mod go build -trimpath \
    -ldflags='-s -w -X k8s.io/component-base/version.gitVersion=v1.35.9 -X k8s.io/component-base/version.gitMajor=1 -X k8s.io/component-base/version.gitMinor=35' \
    -o /out/kubectl ./cmd/kubectl

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

FROM scratch
COPY --from=glibc-runtime /rootfs/ /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.base.name="gcr.io/distroless/cc-debian13:nonroot" \
  org.opencontainers.image.base.digest="sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2" \
  dev.pstdio.pocketcoder.libc="glibc" \
  dev.pstdio.pocketcoder.bun.version="1.4.4" \
  dev.pstdio.pocketcoder.kubectl.version="1.35.9" \
  dev.pstdio.pocketcoder.kubectl.go.version="1.26.10" \
  dev.pstdio.pocketcoder.kubectl.x-net.version="0.62.0"
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=kubectl /out/kubectl /usr/local/bin/kubectl
COPY --from=build /out /opt/pocketcoder/manager
COPY deploy/image/kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml
COPY --from=build --chown=10001:10001 /private/manager_data /private/manager_data
ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml
ENV POCKETCODER_MANAGER_DIR=/private/manager_data
ENV POCKETCODER_MANAGER_HTTP=0.0.0.0:8092
WORKDIR /
USER 10001:10001
ENTRYPOINT ["bun", "/opt/pocketcoder/manager/index.js"]
