# PostgreSQL implementation review

Apply the portions relevant to the change.

## Object fidelity

- Cover the affected object's complete identity, including schema qualification and routine signatures where applicable.
- Check databases, schemas, tables, columns, data types, domains, enums, sequences, identity/generated behavior, defaults, nullability, constraints, indexes, views/materialized views, routines, triggers/rules, collations, operators, partitioning/inheritance, storage/tablespaces, RLS/policies, publications/subscriptions, extensions, ownership, comments, and privileges when relevant.
- Preserve PostgreSQL distinctions such as constraint-backed indexes, owned/identity sequences, expression and partial indexes, materialized views, and function versus procedure semantics.

## Comparison and migration

- Classify source-only, target-only, changed, and unchanged objects.
- Prove source, target, and transformation direction at the call site.
- Decide whether `ALTER` is valid before drop/recreate.
- Order prerequisites before dependents and reverse that order for drops.
- Treat foreign keys and other cross-object dependencies as graph edges, not alphabetical decorations.
- Consider transaction eligibility, locks, long-running rewrites, implicit casts, truncation, and data loss.

## Quoting and safety cases

Exercise lowercase, `MixedCase`, spaces, reserved keywords, embedded double quotes, and schema-qualified names. Exercise strings containing single quotes, `NULL`, booleans, numbers, defaults, and expressions. Use query parameters for values where PostgreSQL permits them; use a dedicated identifier-quoting function for syntax positions where it does not.

## Documentation checks

Link the exact PostgreSQL manual page used for any non-obvious syntax or catalog assumption. Prefer the manual matching the supported server version; use `/docs/current/` only when the project intentionally targets current PostgreSQL.
