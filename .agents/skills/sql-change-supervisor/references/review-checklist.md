# SQL supervisor checklist

## Correctness and versions

- Validate PostgreSQL syntax and semantics against the supported versions. The repository currently has no explicit server-version range; flag version-sensitive behavior until that contract is established.
- Check catalog queries, object identity, schema qualification, overload signatures, and metadata completeness.
- When pgAdmin is the behavior model, verify reasonable alignment without overriding PostgreSQL correctness.

## Safety

- Test identifier quoting for lowercase, mixed case, spaces, keywords, embedded quotes, and qualification.
- Test literal escaping, `NULL`, booleans, numbers, strings, defaults, and expressions. Look for injection paths and malformed concatenation.
- Scrutinize `DROP`, `CASCADE`, column removal/type changes, constraint/index replacement, object recreation, owner/privilege changes, and sequence changes.
- Identify implicit casts, table rewrites, truncation, loss of data or metadata, and whether `ALTER` can preserve state.
- Assess transaction eligibility and failure cleanup; do not assume all DDL can run in the same transaction context.

## Direction and ordering

Explicitly record:

```text
SOURCE:
TARGET:
DIRECTION OF TRANSFORMATION:
```

- Ensure the generated SQL modifies the target, not the source.
- Validate create and drop dependency graphs. Alphabetical order alone is not evidence of safety.
- Check schemas before contained objects, types/sequences before consuming columns, tables and keys before foreign keys, routines before triggers, and dependents before destructive dependency removal.

## Tests

Expect relevant cases among: CREATE, ALTER, DROP, unchanged objects, schema qualification, quoting edge cases, defaults and `NULL`, dependency chains, destructive confirmation/risk, and PostgreSQL-version-specific behavior. A missing test harness is a gap to report, not proof that manual inspection is sufficient.
