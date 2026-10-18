ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
ARG TARGETARCH
COPY apk-indexes/$TARGETARCH/ /var/cache/apk/
# apk must use the reviewed indexes even when their source timestamps are old.
RUN cd /var/cache/apk \
  && sha256sum -c SHA256SUMS \
  && touch APKINDEX.*.tar.gz \
  && apk add chromium=155.0.8059.39-r0 font-dejavu=2.37-r6 \
  && rm -rf /var/cache/apk/*
COPY browser-harness.ts /opt/pocketcoder/browser-harness.ts
USER 10001:10001
