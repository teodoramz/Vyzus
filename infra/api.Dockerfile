# API — Fastify server (no browsers needed here)
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# The api devDepends on @vyzus/worker (testkit), so its manifest must exist
# for workspace resolution; browsers are never needed in this image.
COPY apps/worker/package.json apps/worker/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @vyzus/api... --filter @vyzus/shared...
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY tsconfig.base.json ./
RUN pnpm --filter @vyzus/shared build && pnpm --filter @vyzus/api build \
 && pnpm --filter @vyzus/api deploy --prod /out

FROM node:24-slim
# npm and corepack are build-time tools; the runtime only ever runs `node`.
# Dropping them removes their bundled dependencies from the image, and with
# them a standing source of CVE findings in code this service never calls.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# drizzle migrations run on boot (entrypoint: migrate, then serve)
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
