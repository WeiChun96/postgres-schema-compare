import { Client, ClientConfig } from 'pg';
import { ExtensionConfig } from '../config';
import { SchemaObjectDefinition, SchemaObjectKind, SchemaObjectRef } from '../model/schemaObject';

export class PostgresSchemaService {
  public constructor(private readonly config: Pick<ExtensionConfig, 'host' | 'port' | 'database' | 'username' | 'password'>) {}

  public async testConnection(): Promise<void> {
    await this.withClient(async (client) => {
      await client.query('select 1');
    });
  }

  public async getObjectDefinition(ref: SchemaObjectRef): Promise<SchemaObjectDefinition> {
    return this.withClient(async (client) => {
      const ddl = await this.queryDefinition(client, ref);

      return {
        ...ref,
        ddl: ensureTrailingNewline(ddl)
      };
    });
  }

  public async executeSql(sql: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(sql);
    });
  }

  public getSqlReplacingObject(ref: SchemaObjectRef, sql: string): string {
    const executableSql = ensureRoutineTerminator(ref, sql);

    if ((ref.kind === 'function' || ref.kind === 'procedure') && !ref.identityArguments) {
      return ensureTrailingNewline(executableSql);
    }

    return ensureTrailingNewline([
      'BEGIN;',
      getDropStatement(ref),
      executableSql.trim(),
      'COMMIT;'
    ].join('\n\n'));
  }

  public getDropObjectSql(ref: SchemaObjectRef): string {
    return ensureTrailingNewline(getDropStatement(ref));
  }

  public async executeSqlReplacingObject(ref: SchemaObjectRef, sql: string): Promise<void> {
    if ((ref.kind === 'function' || ref.kind === 'procedure') && !ref.identityArguments) {
      await this.executeSql(sql);
      return;
    }

    await this.withClient(async (client) => {
      await client.query('begin');

      try {
        await client.query(getDropStatement(ref));
        await client.query(sql);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  }

  public async dropObject(ref: SchemaObjectRef): Promise<void> {
    await this.executeSql(getDropStatement(ref));
  }

  public async listSchemaObjects(): Promise<SchemaObjectRef[]> {
    return this.withClient(async (client) => {
      const result = await client.query<SchemaObjectRef>(
        `
          select
            'table' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind in ('r', 'p')
          union all
          select
            'view' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind = 'v'
          union all
          select
            'materializedView' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind = 'm'
          union all
          select
            'index' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind in ('i', 'I')
            and not exists (
              select 1
              from pg_constraint constraint_index
              where constraint_index.conindid = c.oid
            )
          union all
          select
            'sequence' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind = 'S'
            and not exists (
              select 1
              from pg_depend sequence_dependency
              where sequence_dependency.classid = 'pg_class'::regclass
                and sequence_dependency.objid = c.oid
                and sequence_dependency.refclassid = 'pg_class'::regclass
                and sequence_dependency.deptype in ('a', 'i')
            )
          union all
          select
            'function' as kind,
            function_objects.schema,
            function_objects.name,
            case
              when count(*) over (partition by function_objects.schema, function_objects.name) > 1
              then function_objects.identity_arguments
              else null::text
            end as "identityArguments"
          from (
            select
              n.nspname as schema,
              p.proname as name,
              pg_get_function_identity_arguments(p.oid) as identity_arguments
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog', 'information_schema')
              and n.nspname not like 'pg_toast%'
              and p.prokind in ('f', 'a', 'w')
          ) function_objects
          union all
          select
            'procedure' as kind,
            procedure_objects.schema,
            procedure_objects.name,
            case
              when count(*) over (partition by procedure_objects.schema, procedure_objects.name) > 1
              then procedure_objects.identity_arguments
              else null::text
            end as "identityArguments"
          from (
            select
              n.nspname as schema,
              p.proname as name,
              pg_get_function_identity_arguments(p.oid) as identity_arguments
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog', 'information_schema')
              and n.nspname not like 'pg_toast%'
              and p.prokind = 'p'
          ) procedure_objects
          union all
          select
            'trigger' as kind,
            n.nspname as schema,
            t.tgname as name,
            c.relname as "identityArguments"
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and not t.tgisinternal
          union all
          select
            'type' as kind,
            n.nspname as schema,
            t.typname as name,
            null::text as "identityArguments"
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
          left join pg_class c on c.oid = t.typrelid
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and t.typtype in ('c', 'd', 'e')
            and not exists (
              select 1
              from pg_class owner_class
              where owner_class.reltype = t.oid
                and owner_class.relkind in ('r', 'p', 'v', 'm', 'c', 'f')
            )
          order by schema, kind, name
        `
      );

      return result.rows.map((row) => ({
        kind: row.kind as SchemaObjectKind,
        schema: row.schema,
        name: row.name,
        identityArguments: row.identityArguments
      }));
    });
  }

  public async listSchemas(): Promise<string[]> {
    return this.withClient(async (client) => {
      const result = await client.query<{ schema: string }>(
        `
          select nspname as schema
          from pg_namespace
          where nspname not in ('pg_catalog', 'information_schema')
            and nspname not like 'pg_toast%'
          order by nspname
        `
      );

      return result.rows.map((row) => row.schema);
    });
  }

  public getCreateSchemaSql(schema: string): string {
    return ensureTrailingNewline(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
  }

  public async createSchema(schema: string): Promise<void> {
    await this.executeSql(this.getCreateSchemaSql(schema));
  }

  public async listConstraintBackedIndexes(): Promise<SchemaObjectRef[]> {
    return this.withClient(async (client) => {
      const result = await client.query<SchemaObjectRef>(
        `
          select
            'index' as kind,
            n.nspname as schema,
            c.relname as name,
            null::text as "identityArguments"
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_constraint constraint_index on constraint_index.conindid = c.oid
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
            and c.relkind in ('i', 'I')
          order by schema, name
        `
      );

      return result.rows.map((row) => ({
        kind: row.kind as SchemaObjectKind,
        schema: row.schema,
        name: row.name,
        identityArguments: row.identityArguments
      }));
    });
  }

  private async withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    if (!this.config.host || !this.config.port || !this.config.database || !this.config.username) {
      throw new Error('Configure host, port, database, and username before connecting to PostgreSQL.');
    }

    const client = new Client(this.getClientConfig());

    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  private getClientConfig(): ClientConfig {
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.username,
      password: this.config.password || undefined
    };
  }

  private async queryDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    switch (ref.kind) {
      case 'function':
        return this.queryFunctionDefinition(client, ref);
      case 'procedure':
        return this.queryProcedureDefinition(client, ref);
      case 'view':
        return this.queryViewDefinition(client, ref);
      case 'materializedView':
        return this.queryMaterializedViewDefinition(client, ref);
      case 'index':
        return this.queryIndexDefinition(client, ref);
      case 'sequence':
        return this.querySequenceDefinition(client, ref);
      case 'trigger':
        return this.queryTriggerDefinition(client, ref);
      case 'type':
        return this.queryTypeDefinition(client, ref);
      case 'table':
        return this.queryTableDefinition(client, ref);
    }
  }

  private async queryFunctionDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select pg_get_functiondef(p.oid) as ddl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
          and p.proname = $2
          and ($3::text is null or pg_get_function_identity_arguments(p.oid) = $3)
          and p.prokind in ('f', 'a', 'w')
        order by p.oid
      `,
      [ref.schema, ref.name, ref.identityArguments ?? null]
    );

    if (result.rows.length === 0) {
      throw new Error(`Function ${formatQualifiedName(ref)} was not found.`);
    }

    if (!ref.identityArguments && result.rows.length > 1) {
      throw new Error(
        `Function name ${formatQualifiedName(ref)} is overloaded. Use unique file naming or add signature-aware resolution before diffing.`
      );
    }

    return ensureStatementTerminator(result.rows[0].ddl);
  }

  private async queryProcedureDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select pg_get_functiondef(p.oid) as ddl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
          and p.proname = $2
          and ($3::text is null or pg_get_function_identity_arguments(p.oid) = $3)
          and p.prokind = 'p'
        order by p.oid
      `,
      [ref.schema, ref.name, ref.identityArguments ?? null]
    );

    if (result.rows.length === 0) {
      throw new Error(`Procedure ${formatQualifiedName(ref)} was not found.`);
    }

    if (!ref.identityArguments && result.rows.length > 1) {
      throw new Error(
        `Procedure name ${formatQualifiedName(ref)} is overloaded. Use unique file naming or add signature-aware resolution before diffing.`
      );
    }

    return ensureStatementTerminator(result.rows[0].ddl);
  }

  private async queryViewDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select format(
          'CREATE OR REPLACE VIEW %I.%I AS%s%s',
          schemaname,
          viewname,
          chr(10),
          pg_get_viewdef(format('%I.%I', schemaname, viewname)::regclass, true)
        ) as ddl
        from pg_views
        where schemaname = $1
          and viewname = $2
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0) {
      throw new Error(`View ${formatQualifiedName(ref)} was not found.`);
    }

    return `${result.rows[0].ddl};`;
  }

  private async queryMaterializedViewDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select format(
          'CREATE MATERIALIZED VIEW %I.%I AS%s%s',
          schemaname,
          matviewname,
          chr(10),
          definition
        ) as ddl
        from pg_matviews
        where schemaname = $1
          and matviewname = $2
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0) {
      throw new Error(`Materialized view ${formatQualifiedName(ref)} was not found.`);
    }

    return `${result.rows[0].ddl};`;
  }

  private async queryIndexDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select pg_get_indexdef(c.oid) as ddl
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relname = $2
          and c.relkind in ('i', 'I')
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0) {
      throw new Error(`Index ${formatQualifiedName(ref)} was not found.`);
    }

    return `${result.rows[0].ddl};`;
  }

  private async querySequenceDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{
      ddl: string;
    }>(
      `
        select format(
          'CREATE SEQUENCE %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s',
          n.nspname,
          c.relname,
          pg_catalog.format_type(s.seqtypid, null),
          s.seqincrement,
          s.seqmin,
          s.seqmax,
          s.seqstart,
          s.seqcache,
          case when s.seqcycle then ' CYCLE' else '' end
        ) as ddl
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_sequence s on s.seqrelid = c.oid
        where n.nspname = $1
          and c.relname = $2
          and c.relkind = 'S'
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0) {
      throw new Error(`Sequence ${formatQualifiedName(ref)} was not found.`);
    }

    return `${result.rows[0].ddl};`;
  }

  private async queryTableDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        with target_table as (
          select c.oid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1
            and c.relname = $2
            and c.relkind in ('r', 'p')
        ),
        columns as (
          select
            a.attnum,
            format(
              '  %I %s%s%s',
              a.attname,
              pg_catalog.format_type(a.atttypid, a.atttypmod),
              case
                when a.attidentity <> '' then
                case a.attidentity when 'a' then ' GENERATED ALWAYS AS IDENTITY' else ' GENERATED BY DEFAULT AS IDENTITY' end
                when d.adbin is not null then ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
              else '' end,
              case when a.attnotnull then ' NOT NULL' else '' end
            ) as column_ddl
          from pg_attribute a
          join target_table t on t.oid = a.attrelid
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attnum > 0
            and not a.attisdropped
        ),
        constraints as (
          select
            100000 + row_number() over (order by conname) as attnum,
            format('  CONSTRAINT %I %s', conname, pg_get_constraintdef(oid, true)) as column_ddl
          from pg_constraint
          where conrelid = (select oid from target_table)
            and contype in ('p', 'u', 'c', 'f')
        )
        select format(
          'CREATE TABLE %I.%I (%s%s%s);',
          $1,
          $2,
          chr(10),
          string_agg(column_ddl, ',' || chr(10) order by attnum),
          chr(10)
        ) as ddl
        from (
          select * from columns
          union all
          select * from constraints
        ) definition_parts,
        target_table
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0 || !result.rows[0].ddl) {
      throw new Error(`Table ${formatQualifiedName(ref)} was not found.`);
    }

    return result.rows[0].ddl;
  }

  private async queryTriggerDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select pg_get_triggerdef(t.oid, true) as ddl
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and t.tgname = $2
          and ($3::text is null or c.relname = $3)
          and not t.tgisinternal
        order by c.relname, t.oid
      `,
      [ref.schema, ref.name, ref.identityArguments ?? null]
    );

    if (result.rows.length === 0) {
      throw new Error(`Trigger ${formatQualifiedName(ref)} was not found.`);
    }

    if (!ref.identityArguments && result.rows.length > 1) {
      throw new Error(
        `Trigger name ${formatQualifiedName(ref)} exists on multiple relations. Refresh from the database object tree before diffing.`
      );
    }

    return `${result.rows[0].ddl};`;
  }

  private async queryTypeDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{ ddl: string }>(
      `
        select
          case t.typtype
            when 'e' then format(
              'CREATE TYPE %I.%I AS ENUM (%s)',
              n.nspname,
              t.typname,
              string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
            )
            when 'd' then format(
              'CREATE DOMAIN %I.%I AS %s%s%s',
              n.nspname,
              t.typname,
              pg_catalog.format_type(t.typbasetype, t.typtypmod),
              case when t.typnotnull then ' NOT NULL' else '' end,
              coalesce(' DEFAULT ' || pg_get_expr(t.typdefaultbin, 0), '')
            )
            when 'c' then format(
              'CREATE TYPE %I.%I AS (%s%s%s)',
              n.nspname,
              t.typname,
              chr(10),
              string_agg(format('  %I %s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)), ',' || chr(10) order by a.attnum),
              chr(10)
            )
          end as ddl
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        left join pg_enum e on e.enumtypid = t.oid
        left join pg_class c on c.oid = t.typrelid
        left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = $1
          and t.typname = $2
          and t.typtype in ('c', 'd', 'e')
        group by n.nspname, t.typname, t.typtype, t.typbasetype, t.typtypmod, t.typnotnull, t.typdefaultbin
      `,
      [ref.schema, ref.name]
    );

    if (result.rows.length === 0 || !result.rows[0].ddl) {
      throw new Error(`Type ${formatQualifiedName(ref)} was not found.`);
    }

    return `${result.rows[0].ddl};`;
  }
}

function formatQualifiedName(ref: SchemaObjectRef): string {
  return `${ref.schema}.${ref.name}`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function ensureStatementTerminator(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function ensureRoutineTerminator(ref: SchemaObjectRef, sql: string): string {
  return ref.kind === 'function' || ref.kind === 'procedure'
    ? ensureStatementTerminator(sql)
    : sql;
}

function getDropStatement(ref: SchemaObjectRef): string {
  switch (ref.kind) {
    case 'function':
      if (!ref.identityArguments) {
        throw new Error(`Function ${formatQualifiedName(ref)} needs identity arguments before it can be dropped safely.`);
      }

      return `DROP FUNCTION IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)}(${ref.identityArguments});`;
    case 'procedure':
      if (!ref.identityArguments) {
        throw new Error(`Procedure ${formatQualifiedName(ref)} needs identity arguments before it can be dropped safely.`);
      }

      return `DROP PROCEDURE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)}(${ref.identityArguments});`;
    case 'index':
      return `DROP INDEX IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'materializedView':
      return `DROP MATERIALIZED VIEW IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'sequence':
      return `DROP SEQUENCE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'table':
      return `DROP TABLE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'trigger':
      if (!ref.identityArguments) {
        throw new Error(`Trigger ${formatQualifiedName(ref)} needs a relation name before it can be dropped safely.`);
      }

      return `DROP TRIGGER IF EXISTS ${quoteIdentifier(ref.name)} ON ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.identityArguments)};`;
    case 'type':
      return `DROP TYPE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'view':
      return `DROP VIEW IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
