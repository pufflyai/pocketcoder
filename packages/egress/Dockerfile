FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
  && bun build packages/egress/src/index.ts --compile --outfile /pocketcoder-egress

FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
LABEL org.opencontainers.image.base.name="alpine:3.24.2" \
  org.opencontainers.image.base.digest="sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6" \
  dev.pstdio.pocketcoder.libc="musl" \
  dev.pstdio.pocketcoder.bun.version="1.4.4"
RUN apk add --no-cache ca-certificates=20261020-r0 ca-certificates-bundle=20261020-r0 \
    iptables=1.8.13-r0 libxtables=1.8.13-r0 libmnl=1.0.5-r2 libnftnl=1.3.1-r0 \
    libgcc=15.2.0-r5 libstdc++=15.2.0-r5 libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.4-r0 \
  && adduser -D -H -u 999 -G ping pocketcoder-egress
COPY --from=build /pocketcoder-egress /usr/local/bin/pocketcoder-egress
ENTRYPOINT ["/usr/local/bin/pocketcoder-egress"]
