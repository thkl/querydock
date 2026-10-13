# QueryDock

QueryDock is a self-hostable database workbench. The current repository contains the Milestone A workspace scaffold and an aGrid shell preview with sample customer rows. The Angular client is organized by feature under `apps/web/src/app/feature/`; component templates live in separate HTML files, and the root app component contains only the router outlet. Database connection, query editing, and database writes are not implemented yet; sample cell edits stay in memory.

## Requirements

- Node.js 24.15 or newer
- pnpm 11

## Development

```sh
pnpm install
pnpm dev
```

The Angular app runs on `http://localhost:4200`. The NestJS API runs on `http://localhost:3000`; its health endpoint is `http://localhost:3000/api/health`. The Angular dev server proxies `/api` requests to the API.

## Commit hooks

`pnpm install` configures Husky. Install the Graphify CLI and generate the initial graph once before committing; the post-commit hook runs `graphify update` after each commit. Graph updates are produced after the commit and remain in the working tree for review and a later commit.

## Workspace commands

- `pnpm build` builds the client, server, and shared contracts.
- `pnpm typecheck` checks TypeScript across the workspace.

See [`docs/architecture-decisions.md`](docs/architecture-decisions.md) for technical direction and [`docs/mvp-implementation-plan.md`](docs/mvp-implementation-plan.md) for milestones.
