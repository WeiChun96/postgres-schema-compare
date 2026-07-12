# Changelog

## v0.2.0

Major update.

- Add schema-level folder comparison so local schema folders missing from the live database appear as local-only differences.
- Generate `CREATE SCHEMA IF NOT EXISTS` migration steps for missing schemas before dependent object changes.
- Add schema and object-type filters to folder comparisons alongside status filters, preserve the selected filters while results refresh, and scope bulk folder, migration-plan, and database actions to the visible changes.
- Improve synchronization feedback by removing completed comparison rows immediately and refreshing affected explorer folders once per schema and object type, with a full refresh when schemas change.
- Load and cache Database Objects explorer comparisons by schema and object type, show per-folder diff counts, and support targeted folder refreshes for faster navigation.
- Include local SQL objects when loading individual explorer folders and continue ignoring dot-prefixed files.
- Show local-only schemas in the Database Objects explorer and strengthen the folder comparison webview content security policy with nonce-protected styles and scripts.
- Generate dependency-safe migration plans for local-only objects by creating types and standalone sequences before tables, creating tables before foreign keys, and deferring new-table foreign keys until their dependencies exist.
- Exclude constraint-backed indexes, table-owned indexes, and identity-owned sequences from standalone comparisons and migration steps, and omit database sequences owned by table columns from object discovery.
- Ensure function and procedure definitions end with statement terminators when they are exported, compared, included in migration plans, or executed.
- Preserve routine bodies when removing migration transaction wrappers, including lines containing transaction-like text.
- Normalize PostgreSQL `varchar`/`character varying` and `char`/`character` aliases during column comparison to avoid false type differences.

## v0.1.0

Major update.

- Expand PostgreSQL object support beyond tables, views, functions, and sequences to include materialized views, indexes, procedures, triggers, and types.
- Enhance database object discovery, object tree grouping, context menu targeting, and schema folder conventions for the expanded object set.
- Add definition extraction and drop statement generation for the newly supported object types.
- Improve schema comparison and migration plan ordering for non-table objects, dependency-sensitive table changes, indexes, triggers, views, materialized views, functions, procedures, sequences, and types.
- Avoid treating constraint-backed indexes as standalone local-only differences during folder comparison.
- Improve table migration plans by rebuilding affected foreign keys around referenced key or changed-column constraints instead of falling back to broad table rebuilds.
- Add loading, empty, and error states to the folder comparison webview.
- Refactor the connection settings webview with stronger validation, clearer user feedback, stricter content security policy handling, and improved password and schema folder controls.
- Hide diff-related editor title actions from webviews where they are not relevant, including connection settings.
- Update README documentation and extension configuration descriptions for the expanded schema object coverage.

## v0.0.4

Minor update.

- Fix bugs in schema comparison for sequences.
- Enhance schema comparison and migration plan generation.

## v0.0.3

Feature update for schema file services and related components.

- Add `SchemaFileService` for managing local SQL files and schema object references.
- Introduce `ServiceFactory` to create instances of `SchemaDiffService` and `SchemaFileService`.
- Implement `DatabaseObjectsProvider` for managing and displaying database objects in the UI.
- Create TypeScript configuration file for project compilation settings.
