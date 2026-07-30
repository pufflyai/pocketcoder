# pocketcoder-server image: the Hono control plane plus pcd and the
# docker CLI (for the Docker workspace driver via a mounted socket).
#
# Build from the repository root:
#   docker build -f deploy/image/server.Dockerfile -t pocketcoder-server:dev .

FROM oven/bun:1.3-slim AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
	&& bun build apps/pocketcoder-server/src/index.ts --target bun --outdir /out/server \
	&& bun build packages/cli/src/index.ts --target bun --outdir /out/pcd

FROM registry.k8s.io/kubectl:v1.34.1 AS kubectl

FROM oven/bun:1.3-slim
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=build /out/server/index.js /opt/pocketcoder/server.js
COPY --from=build /out/pcd/index.js /opt/pocketcoder/pcd.js
RUN chmod 0755 /opt/pocketcoder/pcd.js \
	&& ln -s /opt/pocketcoder/pcd.js /usr/local/bin/pcd

CMD ["bun", "/opt/pocketcoder/server.js"]
