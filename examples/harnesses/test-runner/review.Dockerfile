# The pinned Prompt Studio review toolchain. Build at the repository root.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
 && bun build packages/supervisor/src/index.ts --target bun --outfile /out/supervisor.js \
 && bun build examples/harnesses/test-runner/runner.ts --target bun --outfile /out/test-runner.js \
 && bun build examples/harnesses/test-runner/engine.ts --target bun --outfile /out/engine.js \
 && bun build examples/harnesses/test-runner/display-session.ts --target bun --outfile /out/display-session.js
FROM docker:28.5.2-dind AS engine
FROM node:24.22.1-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v1.60.0-noble
LABEL dev.pocketcoder.bun="1.4.4" dev.pocketcoder.node="24.22.1" dev.pocketcoder.playwright="1.60.0" dev.pocketcoder.docker="28.5.2"
ENV POCKETCODER_PLAYWRIGHT_VERSION=1.60.0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright POCKETCODER_VIRTUAL_DISPLAY=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git strace xvfb sudo openbox x11-utils iptables iproute2 kmod e2fsprogs util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 runner && useradd --uid 10001 --gid 10001 --home-dir /workspace/home runner
# The candidate configures Electron's sandbox inside its VM, as its Linux CI does.
RUN printf '%s\n' 'runner ALL=(root) NOPASSWD: /usr/bin/chown, /usr/bin/chmod' > /etc/sudoers.d/pocketcoder-runner \
 && chmod 0440 /etc/sudoers.d/pocketcoder-runner
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=engine /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/ctr /usr/local/bin/runc /usr/local/bin/docker-proxy /usr/local/bin/
COPY --from=engine /usr/local/bin/docker-init /usr/local/bin/docker-init
COPY --from=engine /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=engine /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /out/ /opt/pocketcoder/
COPY examples/harnesses/test-runner/engine.conformance.test.ts /opt/pocketcoder/engine.conformance.test.ts
RUN mkdir -p /opt/pocketcoder/browser \
 && cd /opt/pocketcoder/browser && bun add --exact playwright@1.60.0
COPY deploy/image/write-session-image.ts deploy/image/quiesce.ts /opt/pocketcoder/
COPY deploy/image/pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
RUN chmod 0755 /usr/local/bin/pocketcoder-supervisor && bun /opt/pocketcoder/write-session-image.ts test-runner --engine --env DOCKER_HOST --env POCKETCODER_PLAYWRIGHT_VERSION --env PLAYWRIGHT_BROWSERS_PATH --env POCKETCODER_RUNTIME_IMAGE --env POCKETCODER_RUNTIME_PLACEMENT
ENV TMPDIR=/workspace/tmp
WORKDIR /
USER 0:0
ENTRYPOINT ["/usr/local/bin/docker-init", "--", "/usr/local/bin/bun", "/opt/pocketcoder/engine.js"]
CMD ["/usr/local/bin/bun", "/opt/pocketcoder/supervisor.js", "supervise", "--launch-input", "/run/pocketcoder/input"]
