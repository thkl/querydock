# QueryDock — Post-MVP Ideas

This document records product ideas intentionally outside the MVP milestones. Each idea needs its own scope, privacy review, and acceptance criteria before implementation.

## AI-assisted schema drafting

Let a user describe a table in natural language and have an AI agent prepare a new-table draft in the workspace. For example:

> Create a table named `customers` for customer contact details, including name, address, city, phone, and email.

The agent should translate the request into a structured draft with a table name and fields. The user can review and edit that draft in the existing table-creation UI, then send it through the active database adapter for validation and into the runbook for SQL preview and Apply.

The agent proposes a draft only. It does not execute SQL or apply schema changes directly. Database-specific types and capabilities should come from the active adapter rather than being assumed by the agent.

### Questions to resolve before implementation

- Which AI provider or local model should be supported, and how are credentials configured?
- What database context may be sent to the model: adapter capabilities only, or selected schema metadata as well?
- How are sensitive schema names and user prompts protected, retained, and disclosed?
- How should the agent handle ambiguous requests, unsupported field types, and requests spanning multiple tables?
- What structured output schema and validation flow keep proposals editable and safe?

## Additional color themes

Offer users a choice of color palettes beyond the current light and dark modes. Themes should use the existing semantic CSS custom properties so the workspace, aGrid, and CodeMirror remain consistent when a palette changes. Keep contrast and readable status colors across every theme, and persist the user's selection as a setting.

### Questions to resolve before implementation

- Which palette choices should ship first, and should users be able to create custom palettes?
- Should theme selection be independent from the light/dark appearance mode, or should each palette define both variants?
- Which contrast and accessibility checks should be part of acceptance?

## Database role and user management

Explore guided management of database users and roles, beginning with least-privilege connection accounts such as a PostgreSQL read-only role. The feature should show the permissions it will grant, distinguish database-specific behavior through the active adapter, and avoid implying that app-level user management replaces database authorization.

### Questions to resolve before implementation

- Should QueryDock create and rotate database roles, or only explain and validate externally provisioned credentials?
- Which engines and role capabilities can the adapter describe safely?
- How should elevated credentials be requested, used, and discarded without retaining them in browser storage or runbooks?
- What confirmation, audit, and recovery steps are required before changing database privileges?
