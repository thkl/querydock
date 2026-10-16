# Repository Guidelines

## Project Structure & Module Organization

The repository is a pnpm workspace:

- `apps/web/src/app/app.component.html` contains only the root router outlet. Organize client code by feature under `apps/web/src/app/feature/<feature>/`; workspace UI belongs under `feature/workspace/` (for example `sidebar/`, `table-data/`, `table-schema/`, `query/`, and `runbook/`). Keep component templates and styles in separate `.html` and `.css` files.
- `apps/server/src/feature/<feature>/` contains NestJS feature code; keep the root module focused on composition.
- `packages/contracts` holds shared Zod schemas and TypeScript types.
- `docs/architecture-decisions.md` records the current product and technical direction; `docs/contracts-plan.md` and `docs/mvp-implementation-plan.md` describe proposed contracts and milestones.

Treat architecture decisions as authoritative when plans differ. Contract names and routes remain proposals until implemented and verified.

## Build, Test, and Development Commands

Run `pnpm install` to install dependencies. `pnpm start:dev` starts Angular and NestJS; the web server proxies `/api` to port 3000. `pnpm build` builds workspace packages; `pnpm typecheck` checks application TypeScript. Run `pnpm --filter @querydock/web test` or `pnpm --filter @querydock/server test` for package-local Vitest suites; `pnpm test` type-checks all specs and runs those suites plus contract tests. Set `QUERYDOCK_TEST_DATABASE_URL` to a dedicated database with `test` in its name, then run `pnpm test:integration` for PostgreSQL migration integration coverage. Run browser workflow tests with `pnpm --filter @querydock/web test:e2e`; they mock the API and need no database. Install Chromium once with `pnpm --filter @querydock/web exec playwright install chromium`. Docker packaging is not configured yet.

## Coding Style & Naming Conventions

Use TypeScript, external Angular templates, plain CSS, and semantic custom properties. Set every Angular component to `ChangeDetectionStrategy.OnPush`; use signal-based `input()` and `output()` APIs instead of `@Input()` and `@Output()`. Keep `AppComponent` limited to the root router outlet; put shell chrome and pages in feature components. Keep database behavior in adapters and avoid an ORM. Validate shared contracts with Zod, keep them independent of UI and driver code, and minimize dependencies.

## Testing Guidelines

Place application specs under `apps/web/test/` or `apps/server/test/` with the `.spec.ts` suffix; shared contract specs belong under `tests/contracts/`. Keep unit suites database-free. Integration tests must use a disposable PostgreSQL database provided through `QUERYDOCK_TEST_DATABASE_URL`. Put Playwright specs under `apps/web/e2e/` with the `.spec.ts` suffix and stub `/api` requests unless a test specifically requires a real service. No coverage threshold is set.

## Commit & Pull Request Guidelines

No Git history is available to establish a commit convention. Use concise imperative commit subjects. Pull requests should describe the change, link relevant issues, report verification, and include UI screenshots when useful.

## Security & Configuration

Never commit database credentials. Keep them in expiring server sessions; do not persist credentials or fetched rows in browser runbooks. Use disposable test databases and bind local Docker access to loopback.
