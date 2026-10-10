ARG BASE_IMAGE=pocketcoder-workspace:dev
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY browser-harness.ts /opt/pocketcoder/browser-harness.ts
USER 10001:10001
