# Remote test runner workspace: the supervisor plus a Pi-protocol test runner.
# Build from the PocketCoder repository root:
#   docker build -f examples/harnesses/test-runner/Dockerfile -t pocketcoder-test-runner .
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js \
  && bun build examples/harnesses/test-runner/runner.ts --target bun --outfile /out/test-runner.js

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# Test suites need Git, tar and gzip to unpack the uploaded source, strace for process
# tests and Chromium for browser tests.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git strace chromium \
  && rm -rf /var/lib/apt/lists/* \
  # Chromium's own sandbox needs privileges a workspace never has; the workspace is the boundary.
  && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox"' > /etc/chromium.d/no-sandbox
COPY --from=build /out/supervisor.js /opt/pocketcoder/supervisor.js
COPY --from=build /out/test-runner.js /opt/pocketcoder/test-runner.js
COPY deploy/image/write-session-image.ts deploy/image/quiesce.ts /opt/pocketcoder/
COPY deploy/image/pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
RUN chmod 0755 /usr/local/bin/pocketcoder-supervisor && bun /opt/pocketcoder/write-session-image.ts test-runner --env POCKETCODER_RUNTIME_IMAGE --env POCKETCODER_RUNTIME_PLACEMENT
WORKDIR /
USER 10001:10001
ENV HOME=/tmp
CMD ["pocketcoder-supervisor", "supervise", "--launch-input", "/run/pocketcoder/input"]
