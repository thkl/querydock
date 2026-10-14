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
  && pnpm --filter @querydock/web build \
  && pnpm --filter @querydock/server --prod deploy \
    --config.inject-workspace-packages=true /deploy/server

FROM node:24.15-alpine AS server

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=build /deploy/server/package.json ./package.json
COPY --from=build /deploy/server/node_modules ./node_modules
COPY --from=build /deploy/server/dist ./dist
COPY --from=build /workspace/apps/web/dist/web/browser ./dist/client

EXPOSE 3000
CMD ["node", "dist/main.js"]
