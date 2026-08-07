# Worker — Playwright executor. Official image ships Chromium + all OS deps.
# Keep the tag's Playwright version in lockstep with the `playwright` version
# in apps/worker/package.json.
FROM mcr.microsoft.com/playwright:v1.55.1-noble AS build
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

FROM mcr.microsoft.com/playwright:v1.55.1-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# run as the unprivileged user the Playwright image provides
USER pwuser
CMD ["node", "dist/index.js"]
