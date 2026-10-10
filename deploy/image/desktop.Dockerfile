ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc openbox xterm x11-utils x11-xserver-utils fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY desktop-harness.ts desktop-readiness.ts /opt/pocketcoder/
USER 10001:10001
ENV DISPLAY=:99
