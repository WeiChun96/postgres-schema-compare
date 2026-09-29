# Repository context

Recheck this map before relying on it because the repository can evolve.

- `src/extension.ts`: activation, registrations, shared provider lifecycle, and context keys.
- `src/commands/`: VS Code command handlers and Webview UI. Keep these thin.
- `src/views/databaseObjectsProvider.ts`: database object TreeView integration and refresh behavior.
- `src/services/serviceFactory.ts`: constructs services from VS Code/workspace context.
- `src/services/schemaFileService.ts`: schema-folder discovery and file I/O.
- `src/services/postgresSchemaService.ts`: PostgreSQL connections, catalog introspection, object scripting, and execution.
- `src/services/schemaDiffService.ts`: comparison, migration planning, SQL parsing/normalization, and virtual diff documents.
- `src/services/diffSessionState.ts`: active diff state and direction.
- `src/model/schemaObject.ts`: shared schema-object model.
- `package.json`: commands, menus, settings, views, activation events, VS Code engine, and scripts.

Current compiler settings use strict TypeScript, CommonJS, ES2022, and `src` to `out`. The extension targets VS Code `^1.90.0`.

There is currently no automated test or lint script in `package.json`; compilation is the defined local verification command. Do not interpret that absence as permission to skip tests when introducing logic that warrants them.

The worktree may contain user changes. Inspect `git status` and the relevant diff, preserve unrelated edits, and avoid broad formatting churn.

