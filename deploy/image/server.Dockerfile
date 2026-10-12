# pocketcoder-server image: the Hono control plane plus pocketcoder and the
# docker CLI (for the Docker workspace driver via a mounted socket).
#
# Build from the repository root:
#   docker build -f deploy/image/server.Dockerfile -t pocketcoder-server:dev .

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/server/src/index.ts --target bun --outdir /out/server \
  && bun build packages/cli/src/index.ts --target bun --outdir /out/cli \
  && sed -i '1s|#!/usr/bin/env bun|#!/usr/local/bin/bun|' /out/cli/index.js \
  && chmod 0755 /out/cli/index.js \
  && mkdir -p /out/bin \
  && ln -s /opt/pocketcoder/cli/index.js /out/bin/pocketcoder \
  && ln -s pocketcoder /out/bin/pcd \
  && mkdir -p /out/packages \
  && dpkg-query -s coreutils > /out/packages/coreutils

# Rebuild kubectl until upstream ships the October Go and HTTP/2 fixes.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS kubectl
ARG TARGETARCH
ENV GOWORK=off
WORKDIR /src
ADD --checksum=sha256:b390f0c5446a9414e8f0a7019ca54f858251187d193217a8051687bf7a960d01 https://github.com/kubernetes/kubernetes/archive/refs/tags/v1.35.9.tar.gz /tmp/kubernetes.tar.gz
RUN tar -xzf /tmp/kubernetes.tar.gz --strip-components=1 \
  && GOFLAGS=-mod=mod go get golang.org/x/net@v0.60.0 \
  && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH GOFLAGS=-mod=mod go build -trimpath \
    -ldflags='-s -w -X k8s.io/component-base/version.gitVersion=v1.35.9 -X k8s.io/component-base/version.gitMajor=1 -X k8s.io/component-base/version.gitMinor=35' \
    -o /out/kubectl ./cmd/kubectl

FROM docker:29.9.0-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00 AS docker

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
LABEL org.opencontainers.image.base.name="gcr.io/distroless/cc-debian13:nonroot" \
  org.opencontainers.image.base.digest="sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2" \
  dev.pstdio.pocketcoder.libc="glibc" \
  dev.pstdio.pocketcoder.bun.version="1.4.3" \
  dev.pstdio.pocketcoder.coreutils.version="9.7-3" \
  dev.pstdio.pocketcoder.kubectl.version="1.35.9" \
  dev.pstdio.pocketcoder.kubectl.go.version="1.26.9" \
  dev.pstdio.pocketcoder.kubectl.x-net.version="0.60.0"
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
# The manager measures allocated volume bytes with GNU du, including hard-link deduplication.
COPY --from=build /usr/bin/du /usr/bin/du
COPY --from=build /out/packages/coreutils /var/lib/dpkg/status.d/coreutils
COPY --from=build /usr/share/doc/coreutils/copyright /usr/share/doc/coreutils/copyright
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=kubectl /out/kubectl /usr/local/bin/kubectl
COPY --from=build /out/server /opt/pocketcoder/server
COPY --from=build /out/bin /usr/local/bin
COPY --from=build /out/cli /opt/pocketcoder/cli
COPY deploy/image/kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml
USER 0:0

ENV POCKETCODER_DIR=/pc_data
ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml
WORKDIR /

ENTRYPOINT []
CMD ["bun", "/opt/pocketcoder/server/index.js"]
