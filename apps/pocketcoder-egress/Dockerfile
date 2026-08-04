FROM oven/bun:1.3.14-alpine AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile \
	&& bun build apps/pocketcoder-egress/src/index.ts --compile --outfile /pocketcoder-egress

FROM alpine:3.22
RUN apk add --no-cache ca-certificates iptables libgcc libstdc++ \
	&& adduser -D -H -u 999 -G ping pocketcoder-egress
COPY --from=build /pocketcoder-egress /usr/local/bin/pocketcoder-egress
ENTRYPOINT ["/usr/local/bin/pocketcoder-egress"]
