# Browser Test Coverage: Milestones B–D

Run with `pnpm --filter @querydock/web test:e2e`. Tests start the Angular development server and intercept `/api` with deterministic PostgreSQL-shaped fixtures. They verify browser interactions, routing, and client/server request contracts; they do not execute SQL or replace the PostgreSQL integration suite.

## Covered flows

- **Milestone B:** connection success and sanitized failure, resource discovery and schema inspection, two simultaneous sessions with per-session disconnect, and read-only schema controls.
- **Milestone C:** new-table draft and adapter options, `CREATE TABLE IF NOT EXISTS`, review and confirmed Apply presentation, pending field changes after failed Apply, and runbook visibility while switching workspace pages.
- **Milestone D:** grid-based primary-key staging, table rename and workspace-tab update after Apply, table-drop warning acknowledgement, and existing table-creation field options including identity generation.

## Still requires unit, integration, or manual coverage

Mocks cannot prove PostgreSQL SQL semantics, transaction rollback, drift detection, permission enforcement, connection expiry, export executability, unknown Apply outcomes, IndexedDB privacy, or constraint compatibility. Keep those checks in contract/server tests and the disposable-PostgreSQL integration suite. Browser coverage for unique, foreign-key, and CHECK editing; field alteration and constraint removal; staged-plan review invalidation; successful existing-field Apply; and rename/drop edge cases remains to be added if MS B–D UI coverage is required at sign-off.
