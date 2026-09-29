---
name: vscode-extension-typescript
description: Repository specialist for TypeScript and Visual Studio Code extension work. Use for any change to activation, commands, providers, TreeViews, Webviews/WebviewViews, configuration, workspace APIs, progress, cancellation, diagnostics, disposables, extension lifecycle, or package.json contributions in this PostgreSQL Schema Compare repository. Also use for TypeScript refactors that cross the extension UI and service boundaries. This skill does not determine PostgreSQL SQL correctness.
---

# VS Code Extension and TypeScript

## Start with the repository

1. Read `references/repository-context.md`.
2. Inspect the files being changed, adjacent services, `package.json`, `tsconfig.json`, and relevant tests before designing the change.
3. Preserve existing contracts and architecture unless the task explicitly requires a breaking change.
4. If behavior depends on uncertain or recently changed VS Code APIs, consult the current [official VS Code Extension API documentation](https://code.visualstudio.com/api) before implementing it.

## Implement within the existing boundaries

- Keep command handlers and UI components focused on VS Code orchestration, user interaction, and presentation.
- Put application workflows and schema comparison behavior in services; keep PostgreSQL access and SQL generation out of commands, TreeViews, and Webviews.
- Prefer official VS Code APIs for commands, configuration, workspace I/O, virtual documents, progress, cancellation, diagnostics, and lifecycle management.
- Use strict TypeScript types. Avoid `any`; if an external boundary truly requires it, narrow immediately and document why.
- Model Webview messages as discriminated unions, validate untrusted messages, use a restrictive content security policy, and escape interpolated HTML values.
- Register resources in `context.subscriptions` or dispose them explicitly. Cover event emitters, listeners, providers, panels, processes, database connections, and other owned resources.
- Propagate or surface actionable errors. Log useful context without exposing credentials; do not silently swallow failures.
- Prefer small services and pure functions where they make behavior testable. Do not introduce abstractions that the repository does not yet need.
- Preserve command identifiers, contribution points, settings, persisted values, and public behavior unless a change explicitly updates them.

## Coordinate with other skills

- Use `postgresql-expert` for SQL, PostgreSQL catalogs, DDL, quoting, or migration semantics.
- Use `pgadmin-schema-tools` when reproducing pgAdmin-style scripting or schema comparison behavior.
- After any SQL-sensitive change, finish with `sql-change-supervisor` and resolve its findings.

## Verify

- Add or update tests when behavior changes. If the repository lacks a test harness for the affected logic, extract testable logic where proportionate and report the coverage gap.
- Run the repository's relevant checks. At minimum for the current repository, run `npm run compile`.
- Review activation, disposal, cancellation, error paths, configuration scope, and backward compatibility before handing off.

