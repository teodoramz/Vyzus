# Worker — Playwright executor. Official image ships Chromium + all OS deps.
# Keep the tag's Playwright version in lockstep with the `playwright` version
# in apps/worker/package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @vyzus/worker... --filter @vyzus/shared...
COPY packages/shared packages/shared
COPY apps/worker apps/worker
COPY tsconfig.base.json ./
RUN pnpm --filter @vyzus/shared build && pnpm --filter @vyzus/worker build \
 && pnpm --filter @vyzus/worker deploy --prod /out

FROM mcr.microsoft.com/playwright:v1.62.1-noble
# npm and corepack are build-time tools; the runtime only ever runs `node`.
# Dropping them removes their bundled dependencies from the image, and with
# them a standing source of CVE findings in code this service never calls.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
# `ping` for the ICMP check mode. iputils uses an unprivileged ICMP datagram
# socket, which Docker permits by default (net.ipv4.ping_group_range), so this
# needs no CAP_NET_RAW — the container still runs as non-root pwuser below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# run as the unprivileged user the Playwright image provides
USER pwuser
CMD ["node", "dist/index.js"]
