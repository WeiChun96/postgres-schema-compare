---
name: pgadmin-schema-tools
description: pgAdmin behavior and reference specialist for schema scripting and comparison in this repository. Use when implementing or reviewing CREATE, ALTER, DROP, update, or diff scripts intended to reproduce or approximate pgAdmin behavior; object comparison and ordering; owner, comment, privilege, constraint, index, sequence, routine, trigger, view, materialized-view, or table scripting; and source-versus-target synchronization UX.
---

# pgAdmin Schema Tools

Treat the [pgAdmin documentation](https://www.pgadmin.org/docs/) and relevant pgAdmin examples or implementation behavior as the administration-tooling reference. Treat the [PostgreSQL documentation](https://www.postgresql.org/docs/) as authoritative for SQL correctness.

## Workflow

1. Inspect the existing implementation and tests before changing semantics.
2. Identify the pgAdmin operation being modeled and the applicable pgAdmin/PostgreSQL versions.
3. Establish source, target, and direction using `references/comparison-workflow.md`. Never infer direction from labels alone.
4. Determine how pgAdmin represents or scripts the object: qualification, clauses, owner, comments, privileges, dependencies, formatting, and create/alter/drop strategy.
5. Compare that behavior with the PostgreSQL manual. Adapt version-specific output to the versions this repository supports; do not blindly copy pgAdmin SQL.
6. Generate deterministic output that reaches the intended state without losing PostgreSQL-specific metadata.

## Repository expectations

- Database-to-folder operations make local files reflect the live database.
- Folder-to-database operations make the live database reflect local schema files.
- `missingLocal` means database-only; `localOnly` means folder-only. Verify these contracts in `SchemaComparisonResult` consumers before modifying them.
- Combined plans must distinguish source-only, target-only, changed, and unchanged objects, then sequence creates, alters, and drops by dependency.
- Inspect `src/services/postgresSchemaService.ts` for introspection/scripting and `src/services/schemaDiffService.ts` for comparison and migration planning. Keep VS Code UI orchestration outside these database rules.

Use `postgresql-expert` alongside this skill for every SQL-sensitive implementation. After changes, run `sql-change-supervisor` as the final gate and correct issues it finds.

