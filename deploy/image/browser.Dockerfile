ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
ARG TARGETARCH
USER root
RUN case "$TARGETARCH" in \
      amd64) chromium_version=152.0.7977.82-r0 ;; \
      arm64) chromium_version=155.0.8059.39-r0 ;; \
      *) exit 1 ;; \
    esac \
  && apk update \
  && sha256sum /var/cache/apk/APKINDEX.*.tar.gz | cut -d ' ' -f 1 | sort | diff - /opt/apk-index-checksums \
  && apk add "chromium=$chromium_version" font-dejavu=2.37-r6 \
  && rm -rf /var/cache/apk/*
COPY browser-harness.ts /opt/pocketcoder/browser-harness.ts
USER 10001:10001
