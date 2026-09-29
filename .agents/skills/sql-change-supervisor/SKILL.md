---
name: sql-change-supervisor
description: Mandatory final reviewer for this repository after any implementation that may affect SQL strings or templates, .sql files, PostgreSQL catalogs or connections, introspection, schema comparison, migration generation or execution, identifier/literal handling, dependencies, ordering, or pgAdmin-equivalent behavior. Use only as the final review gate after implementation; it is not the primary implementation skill.
---

# SQL Change Supervisor

Review the final diff, not only the files the implementer expected to affect. Determine first whether SQL-sensitive behavior changed.

If SQL was not touched, report exactly:

`SQL Supervisor: No SQL-sensitive changes detected.`

If SQL was touched, read `references/review-checklist.md`, inspect relevant callers and tests, and verify uncertain claims against the appropriate-version [PostgreSQL documentation](https://www.postgresql.org/docs/). When pgAdmin behavior is modeled, also check the applicable [pgAdmin documentation](https://www.pgadmin.org/docs/).

Do not approve correctness by assumption. Run relevant tests and compilation where available. Require focused tests for material SQL-generation changes. Fix findings, then repeat the review and affected checks before final handoff.

## Required report

Use this concise structure:

```text
SQL Supervisor Review

SQL touched: YES/NO

PostgreSQL correctness: PASS / ISSUES FOUND
pgAdmin alignment: PASS / NOT APPLICABLE / ISSUES FOUND
Identifier/literal safety: PASS / ISSUES FOUND
Dependency/order safety: PASS / ISSUES FOUND
Destructive/data-loss risk: NONE / LOW / REVIEW REQUIRED
Tests: SUFFICIENT / MISSING CASES

Issues:
- <file and function/section>: <problem>; <why it matters>; <recommended correction>; <documentation reference when appropriate>
```

For `SQL touched: NO`, use the exact no-change sentence instead of manufacturing the full report. Do not mark a category `PASS` until it was actually checked. If issues remain, make them prominent and do not describe the change as approved.

