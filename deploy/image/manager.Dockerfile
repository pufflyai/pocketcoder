# Build from the repository root. Operator credentials are supplied at runtime.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/manager/src/index.ts --target bun --outdir /out \
  && mkdir -p /private/manager_data \
  && chown 10001:10001 /private/manager_data \
  && chmod 0700 /private/manager_data

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

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
LABEL org.opencontainers.image.base.name="gcr.io/distroless/cc-debian13:nonroot" \
  org.opencontainers.image.base.digest="sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2" \
  dev.pstdio.pocketcoder.libc="glibc" \
  dev.pstdio.pocketcoder.bun.version="1.4.3" \
  dev.pstdio.pocketcoder.kubectl.version="1.35.9" \
  dev.pstdio.pocketcoder.kubectl.go.version="1.26.9" \
  dev.pstdio.pocketcoder.kubectl.x-net.version="0.60.0"
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
