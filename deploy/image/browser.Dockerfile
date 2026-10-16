ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
ARG TARGETARCH
RUN apk update \
  && sha256sum /var/cache/apk/APKINDEX.*.tar.gz | cut -d ' ' -f 1 | sort | diff - /opt/apk-index-checksums \
  && case "$TARGETARCH" in \
      amd64) apk add chromium=152.0.7977.82-r0 font-dejavu=2.37-r6 ;; \
      arm64) apk add chromium=155.0.8059.39-r0 font-dejavu=2.37-r6 ;; \
      *) exit 1 ;; \
    esac \
  && rm -rf /var/cache/apk/*
COPY browser-harness.ts /opt/pocketcoder/browser-harness.ts
USER 10001:10001
