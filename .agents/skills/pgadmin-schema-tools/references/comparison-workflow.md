# Comparison workflow

Before approving a schema synchronization change, write down:

```text
SOURCE: authoritative state
TARGET: state to modify
DIRECTION: TARGET -> SOURCE state
```

Then classify every affected object:

| Relationship | Typical target operation |
| --- | --- |
| Only in source | CREATE |
| Only in target | DROP, after explicit destructive review |
| In both and semantically different | ALTER when safe; otherwise reviewed replacement |
| In both and equivalent | None |
| Plausible rename | Rename only when detection is supported and unambiguous |

Build a dependency graph before ordering. Create schemas and prerequisites before contained/dependent objects; create referenced tables or keys before foreign keys; create routines before triggers that call them. Reverse dependencies for drops. Keep owner, comment, privilege, and other post-create statements attached to the correct object phase.

When checking pgAdmin alignment, compare the operation's intent and completeness, not incidental whitespace. Record any deliberate divergence caused by PostgreSQL version support, safety, or the repository's established file format.

