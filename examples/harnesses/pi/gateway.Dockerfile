FROM oven/bun:1.3.14-slim

WORKDIR /opt/pi-gateway
COPY examples/harnesses/pi/openai-gateway.ts examples/harnesses/pi/gateway.ts ./

USER 10001:10001
ENV PORT=8080

CMD ["bun", "/opt/pi-gateway/gateway.ts"]
