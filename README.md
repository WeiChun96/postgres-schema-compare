# PostgreSQL Schema Compare

PostgreSQL Schema Compare is a Visual Studio Code extension for comparing and synchronizing PostgreSQL schema objects with local SQL files.

It provides a database object explorer, local-vs-live diff views, full folder comparison, migration plan generation, and guarded update actions for keeping a schema folder and a live PostgreSQL database in sync.

## Features

- Configure PostgreSQL connection settings from the extension sidebar.
- Browse schemas, tables, views, materialized views, indexes, functions, procedures, sequences, triggers, and types in the **Database Objects** view.
- Compare a local `.sql` file with the live database definition.
- Compare an object from the sidebar with its matching local schema file.
- Compare the whole schema folder with the live database in the **Schema Folder vs Database** view.
- Show detailed change summaries for folder comparison rows.
- Generate a migration plan for one difference or all folder differences.
- Update the schema folder from the database.
- Update the live database from local SQL using generated migration plans.
- Write/export database objects to the schema folder.
- Reveal configured schema folders and object folders in the OS file explorer.

## Requirements

- Visual Studio Code `1.90.0` or newer.
- A reachable PostgreSQL database.
- A workspace folder, unless `postgresSchemaCompare.schemaFolder` is configured as an absolute path.

## Configuration

Open the PostgreSQL Schema Compare sidebar and select **Configure Connection**.

The extension stores these settings:

| Setting | Description |
| --- | --- |
| `postgresSchemaCompare.host` | PostgreSQL server host. |
| `postgresSchemaCompare.port` | PostgreSQL server port. Defaults to `5432`. |
| `postgresSchemaCompare.database` | Database name. |
| `postgresSchemaCompare.username` | PostgreSQL username. |
| `postgresSchemaCompare.password` | PostgreSQL password. Prefer workspace-local settings outside source control. |
| `postgresSchemaCompare.schemaFolder` | Relative or absolute folder used for local schema files. |

## Schema Folder Layout

Preferred layout:

```text
schema/
  public/
    Tables/
      users.sql
    Views/
      active_users.sql
    Materialized Views/
      user_rollups.sql
    Indexes/
      users_email_idx.sql
    Functions/
      refresh_user_stats.sql
    Procedures/
      archive_users.sql
    Sequences/
      user_id_seq.sql
    Triggers/
      users_audit_trigger.sql
    Types/
      user_status.sql
  app/
    Tables/
    Views/
    Materialized Views/
    Indexes/
    Functions/
    Procedures/
    Sequences/
    Triggers/
    Types/
```

Set `postgresSchemaCompare.schemaFolder` to `schema` for the example above.

The extension also supports the older single-schema layout:

```text
schema/
  Tables/
    public.users.sql
  Views/
  Materialized Views/
  Indexes/
  Functions/
  Procedures/
  Sequences/
  Triggers/
  Types/
```

## Usage

### Configure and Load the Object Explorer

1. Open the **PostgreSQL Schema Compare** activity bar view.
2. Select **Configure Connection**.
3. Enter the PostgreSQL connection values and schema folder.
4. Save and test the connection.
5. Use **Refresh from Live Database** if you need to reload the sidebar.

The object explorer shows each object status when a schema folder is configured:

- `same`: local file and database object match.
- `modified`: local file and database object differ.
- `missing local`: object exists in the database but not in the folder.
- `local only`: local file exists but the object is not in the database.
- `compare error`: the object could not be compared.

### Compare One Local File

Right-click a `.sql` file in the VS Code file explorer and select **Compare with Live Database**.

After a diff is open, the editor title actions can:

- **Swap Compare Direction**
- **Update Folder from Live Database**
- **Update Live Database from Folder**

### Compare One Sidebar Object

In **Database Objects**, select or right-click a supported object and choose **Compare with Live Database**.

For tables, the comparison is table-aware. Column order alone is ignored, so a reordered table definition is not treated as modified.

### Compare the Whole Folder

Use **Compare Folder with Database** from the object explorer title bar.

The **Schema Folder vs Database** view lists every difference and provides an action dropdown for each row:

- **Compare**: open the VS Code diff view.
- **Migration Plan**: open the generated SQL plan for that row.
- **Update Folder**: write the live database definition to the local folder, or delete local-only files after confirmation.
- **Update Database**: apply the local SQL or generated migration plan to the live database after confirmation.

The header action dropdown targets all differences:

- **Migration Plan - All Differences**: opens one combined SQL script for all actionable differences.
- **Update Folder - All Differences**: updates the folder for every actionable difference.
- **Update Database - All Differences**: generates the full migration plan and executes that script once.

After update actions, the webview and sidebar refresh.

### Write Database to Folder

Use **Write Database to Folder** from the object explorer title bar or connection context menu.

This exports database object definitions into the configured schema folder using the preferred schema layout.

### Reveal in File Explorer

Right-click a connection, schema, object folder, or object in the sidebar and choose **Reveal in File Explorer**.

This opens the matching local folder in the operating system file explorer.

## Migration Plans

For modified tables, the extension tries to generate `ALTER TABLE` statements instead of replacing the table.

Supported table changes include:

- Add columns.
- Drop columns.
- Change column type.
- Set or drop column defaults.
- Set or drop `NOT NULL`.
- Add, drop, or replace named constraints.

When changing text-like columns to `jsonb`, generated SQL includes a `USING` clause so PostgreSQL can perform the conversion.

For modified non-table objects, the migration plan replaces the object using drop-and-create style SQL where supported by the extension.

Review generated migration plans before applying them to important databases.

## Development

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```
