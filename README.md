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

The production image contains one NestJS server process. It serves the built Angular app, falls back to `index.html` for client routes, and handles API requests under `/api`. In development, the API listens on `127.0.0.1`; the container listens on its private container interface.

Build and start the local instance:

```sh
docker compose up --build -d
```

The published port is `8080` by default; set `QUERYDOCK_HTTP_PORT` to change it. The port mapping omits a fixed host IP so it works with Docker Swarm's routing mesh. In standalone Docker, it is published on all host interfaces; use a firewall or reverse proxy to control reachability. The Nest server marks session cookies `Secure` in production; set `QUERYDOCK_COOKIE_SECURE=false` only for an intentional plain-HTTP local setup where the browser does not treat localhost as secure.

For Traefik or another reverse proxy, attach QueryDock to a private network reachable by the proxy and configure TLS. This Compose file does not configure Traefik routes or authentication. QueryDock has no application-account login by design: users provide PostgreSQL credentials, and PostgreSQL authorizes database access. For deployments that should connect only to fixed database hosts, set `QUERYDOCK_ALLOWED_DATABASE_HOSTS` to a comma-separated exact host allowlist (for example, `db.internal,host.docker.internal`); unlisted hosts are rejected before PostgreSQL connects. Leave it unset when users are expected to choose database hosts dynamically.

Compose does not start a database; QueryDock connects to databases selected in the app. For a database running on the Docker host, use `host.docker.internal` as its host from the container. Stop QueryDock with `docker compose down`.

## Commit hooks

`pnpm install` configures Husky. Install the Graphify CLI and generate the initial graph once before committing; the post-commit hook runs `graphify update` after each commit. Graph updates are produced after the commit and remain in the working tree for review and a later commit.

## Workspace commands

- `pnpm build` builds the client, server, and shared contracts.
- `pnpm typecheck` checks TypeScript across the workspace.

See [`docs/architecture-decisions.md`](docs/architecture-decisions.md) for technical direction and [`docs/mvp-implementation-plan.md`](docs/mvp-implementation-plan.md) for milestones.
