---
name: postgresql-expert
description: Authoritative PostgreSQL specialist for this repository. Use whenever work touches SQL, DDL, catalog or information_schema queries, database introspection, PostgreSQL object definitions, schema comparison semantics, dependencies, identifier or literal quoting, generated migrations, or connection/execution behavior. Use even when PostgreSQL is only one part of a VS Code feature. PostgreSQL documentation is the source of truth.
---

# PostgreSQL Expert

Use the appropriate version of the [official PostgreSQL documentation](https://www.postgresql.org/docs/) whenever exact syntax, catalog behavior, transactional behavior, or version differences are uncertain. Do not infer PostgreSQL behavior from another database system or from tests alone.

## Establish the contract

1. Inspect the implementation, callers, tests, README, and package metadata.
2. Determine the supported PostgreSQL versions. This repository currently declares no explicit server-version range, so do not invent one; avoid version-sensitive syntax or document and test the chosen boundary.
3. State the comparison operands and transformation direction before changing synchronization logic. In this repository, a database update generally transforms the live database (target) to match local schema files (source), while a folder update transforms local files (target) to match the live database (source). Verify each call path rather than assuming.
4. Identify all metadata that must survive: ownership, comments, privileges, constraints, indexes, sequence relationships/state, tablespaces, policies, and other PostgreSQL-specific properties.

## Implement PostgreSQL semantics

- Compare semantic structure where PostgreSQL rules matter; do not rely only on normalized raw SQL text.
- Distinguish absent, create, alter, drop, and supported/detectable rename cases.
- Prefer a data-preserving `ALTER` when it accurately reaches the desired state; use drop/recreate only when required and explicitly assess dependent objects.
- Generate dependency-safe, deterministic SQL. Treat types, sequences, tables, constraints, routines, triggers, views, partitions, ownership, comments, and privileges according to their actual dependencies.
- Use `pg_catalog` when PostgreSQL-specific metadata is required. Do not assume `information_schema` exposes everything needed by a schema comparison tool.
- Verify catalog columns and helper functions for every supported server version.
- Quote identifiers and literals by their different rules. Never build a qualified name with unsafe string concatenation, and never interpolate untrusted values into executable SQL.
- Preserve expressions as expressions where appropriate; do not quote defaults, predicates, or generated expressions as ordinary string literals.
- Avoid `CASCADE` as a convenience. Explain destructive or lossy operations and their transactional constraints.

Read `references/postgresql-review.md` when changing introspection, comparison, or generated SQL.

## Coordinate and verify

- Use `pgadmin-schema-tools` when pgAdmin behavior is the presentation or scripting reference; PostgreSQL documentation still decides correctness.
- Use `vscode-extension-typescript` for extension integration.
- Add focused tests for changed SQL semantics and edge cases. A test expectation that conflicts with PostgreSQL documentation must be corrected or explicitly challenged, not blindly satisfied.
- After implementation, invoke `sql-change-supervisor`, fix its findings, and rerun affected checks.

