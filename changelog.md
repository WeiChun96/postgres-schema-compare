# Changelog

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
