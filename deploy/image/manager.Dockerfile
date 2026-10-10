# Build from the repository root. Operator credentials are supplied at runtime.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/manager/src/index.ts --target bun --outdir /out

FROM registry.k8s.io/kubectl:v1.34.1@sha256:59bafa07ff3a6d4b417e7633ddb9d79a9606ca98bf64bac080b3e65748669250 AS kubectl

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=build /out /opt/pocketcoder/manager
COPY deploy/image/kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml
ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml
ENV POCKETCODER_MANAGER_DIR=/private/manager_data
ENV POCKETCODER_MANAGER_HTTP=0.0.0.0:8092
WORKDIR /
USER 10001:10001
ENTRYPOINT ["bun", "/opt/pocketcoder/manager/index.js"]
