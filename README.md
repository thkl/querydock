# QueryDock

QueryDock is a self-hostable database workbench. The Angular client is organized by feature under `apps/web/src/app/feature/`; component templates live in separate HTML files, and the root app component contains only the router outlet. The NestJS API owns database connections and schema migration planning.

## Requirements

- Node.js 24.15 or newer
- pnpm 11

## Development

```sh
pnpm install
pnpm start:dev
```

The Angular app runs on `http://localhost:4200`. The NestJS API runs on `http://localhost:3000`; its health endpoint is `http://localhost:3000/api/health`. The Angular dev server proxies `/api` requests to the API.

## Docker Compose

Build and start the production web and API containers:

```sh
docker compose up --build -d
```

Open `http://localhost:8080`. The web container serves the Angular app and proxies `/api` requests to the API container. The API health endpoint is available through `http://localhost:8080/api/health`. Set `QUERYDOCK_HTTP_PORT` to change the host port, for example `QUERYDOCK_HTTP_PORT=8090 docker compose up --build -d`.

Compose does not start a database; QueryDock connects to databases you choose in the app. For a database running on the host, use `host.docker.internal` as its host from the containerized app. Stop the containers with `docker compose down`.

## Commit hooks

`pnpm install` configures Husky. Install the Graphify CLI and generate the initial graph once before committing; the post-commit hook runs `graphify update` after each commit. Graph updates are produced after the commit and remain in the working tree for review and a later commit.

## Workspace commands

- `pnpm build` builds the client, server, and shared contracts.
- `pnpm typecheck` checks TypeScript across the workspace.

See [`docs/architecture-decisions.md`](docs/architecture-decisions.md) for technical direction and [`docs/mvp-implementation-plan.md`](docs/mvp-implementation-plan.md) for milestones.
