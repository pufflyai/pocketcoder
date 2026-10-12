ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
RUN apk update \
  && sha256sum /var/cache/apk/APKINDEX.*.tar.gz | cut -d ' ' -f 1 | sort | diff - /opt/apk-index-checksums \
  && apk add chromium=152.0.7977.82-r0 font-dejavu=2.37-r6 \
  && rm -rf /var/cache/apk/*
COPY browser-harness.ts /opt/pocketcoder/browser-harness.ts
USER 10001:10001
