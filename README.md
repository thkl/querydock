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

## Docker Compose and Traefik

The production image contains one NestJS server process. It serves the built Angular app, falls back to `index.html` for client routes, and handles API requests under `/api`.

Connect QueryDock to the same Docker network as Traefik, then build and start it:

```sh
docker network create traefik # only if the network does not already exist
QUERYDOCK_HOST=querydock.example.com docker compose up --build -d
```

Compose attaches to the external `traefik` network and adds Docker-provider labels for the `websecure` entrypoint and `letsencrypt` certificate resolver. Set `TRAEFIK_DOCKER_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERT_RESOLVER`, or `TRAEFIK_TLS` to match your Traefik setup. The app also publishes port 8080 by default for direct access; set `QUERYDOCK_HTTP_PORT` to change it.

Compose does not start a database; QueryDock connects to databases selected in the app. For a database running on the Docker host, use `host.docker.internal` as its host from the container. Stop QueryDock with `docker compose down`.

## Commit hooks

`pnpm install` configures Husky. Install the Graphify CLI and generate the initial graph once before committing; the post-commit hook runs `graphify update` after each commit. Graph updates are produced after the commit and remain in the working tree for review and a later commit.

## Workspace commands

- `pnpm build` builds the client, server, and shared contracts.
- `pnpm typecheck` checks TypeScript across the workspace.

See [`docs/architecture-decisions.md`](docs/architecture-decisions.md) for technical direction and [`docs/mvp-implementation-plan.md`](docs/mvp-implementation-plan.md) for milestones.
