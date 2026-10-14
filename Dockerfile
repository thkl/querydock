FROM node:24.15-alpine AS workspace

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

FROM workspace AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN HUSKY=0 pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @querydock/contracts build \
  && pnpm --filter @querydock/server build \
  && pnpm --filter @querydock/web build

FROM workspace AS server

ENV NODE_ENV=production PORT=3000

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN HUSKY=0 pnpm install --prod --frozen-lockfile --filter '@querydock/server...'

COPY --from=build /workspace/apps/server/dist ./apps/server/dist
COPY --from=build /workspace/packages/contracts/dist ./packages/contracts/dist

WORKDIR /workspace/apps/server
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM nginx:alpine AS web

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
