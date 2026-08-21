# Dashboard — build the React SPA, serve with nginx (also reverse-proxies /api and /ws)
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @vyzus/dashboard... --filter @vyzus/shared...
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
COPY tsconfig.base.json ./
RUN pnpm --filter @vyzus/shared build && pnpm --filter @vyzus/dashboard build

FROM nginx:1.31-alpine
# vyzus-common.conf is included from inside a server block, so it must NOT sit
# in conf.d/ — nginx loads everything there at http level and would reject it.
COPY infra/nginx-common.conf /etc/nginx/vyzus-common.conf
COPY infra/nginx-security-headers.conf /etc/nginx/vyzus-security-headers.conf
COPY infra/nginx-hsts-map.conf /etc/nginx/conf.d/00-hsts.conf
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80 443
