# RFXCom2Matter - build stage
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# runtime stage
FROM node:24-slim AS runtime
WORKDIR /app

# version from git tag (set by the GitHub Action build). Left empty for local
# builds so the image falls back to package.json's version instead of "dev".
ARG VERSION=
RUN if [ -n "$VERSION" ]; then printf '%s' "$VERSION" > /app/version.txt; fi

# USB serial access
RUN apt-get update \
    && apt-get install -y --no-install-recommends libudev-dev libusb-1.0-0 socat udev \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# config.yml + state.json live in the data directory (mount a volume here)
ENV RFXCOM_CONFIG=/app/data/config.yml
ENV RFXCOM_DATA_DIR=/app/data
RUN mkdir -p /app/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY config.example.yml ./config.example.yml
COPY RELEASE-NOTES.md ./RELEASE-NOTES.md
COPY frontend ./frontend

# Matter uses mDNS (UDP 5353) + UDP 5540; web UI on 3000; RFXmngr TCP gateway on 10001
EXPOSE 3000/tcp 5540/udp 5353/udp 10001/tcp

# RFXCOM USB stick passed through by the host
# docker run --device=/dev/ttyUSB0 ...

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/rfxcom/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

CMD ["node", "dist/index.js"]