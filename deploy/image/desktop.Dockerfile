ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
RUN apk update \
  && sha256sum /var/cache/apk/APKINDEX.*.tar.gz | cut -d ' ' -f 1 | sort | diff - /opt/apk-index-checksums \
  && apk add xvfb=21.1.25-r0 x11vnc=0.9.17-r1 openbox=3.6.1-r8 xterm=410-r0 \
    xwininfo=1.1.6-r0 xprop=1.2.8-r0 xrandr=1.5.4-r0 xsetroot=1.1.3-r1 font-dejavu=2.37-r6 \
  && rm -rf /var/cache/apk/*
COPY desktop-harness.ts desktop-readiness.ts /opt/pocketcoder/
USER 10001:10001
ENV DISPLAY=:99
