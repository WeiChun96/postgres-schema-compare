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
    if (ref.kind === 'function' && !ref.identityArguments) {
      return ensureTrailingNewline(sql);
    }

    return ensureTrailingNewline([
      'BEGIN;',
      getDropStatement(ref),
      sql.trim(),
      'COMMIT;'
    ].join('\n\n'));
  }

  public getDropObjectSql(ref: SchemaObjectRef): string {
    return ensureTrailingNewline(getDropStatement(ref));
  }

  public async executeSqlReplacingObject(ref: SchemaObjectRef, sql: string): Promise<void> {
    if (ref.kind === 'function' && !ref.identityArguments) {
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
            schemaname as schema,
            viewname as name,
            null::text as "identityArguments"
          from pg_views
          where schemaname not in ('pg_catalog', 'information_schema')
            and schemaname not like 'pg_toast%'
          union all
          select
            'sequence' as kind,
            sequence_schema as schema,
            sequence_name as name,
            null::text as "identityArguments"
          from information_schema.sequences
          where sequence_schema not in ('pg_catalog', 'information_schema')
            and sequence_schema not like 'pg_toast%'
          union all
          select
            'function' as kind,
            n.nspname as schema,
            p.proname as name,
            pg_get_function_identity_arguments(p.oid) as "identityArguments"
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg_toast%'
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
      case 'view':
        return this.queryViewDefinition(client, ref);
      case 'sequence':
        return this.querySequenceDefinition(client, ref);
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

    return result.rows[0].ddl;
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

  private async querySequenceDefinition(client: Client, ref: SchemaObjectRef): Promise<string> {
    const result = await client.query<{
      ddl: string;
    }>(
      `
        select format(
          'CREATE SEQUENCE %I.%I INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s%s',
          sequence_schema,
          sequence_name,
          increment,
          minimum_value,
          maximum_value,
          start_value,
          case when cycle_option = 'YES' then ' CYCLE' else '' end
        ) as ddl
        from information_schema.sequences
        where sequence_schema = $1
          and sequence_name = $2
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
}

function formatQualifiedName(ref: SchemaObjectRef): string {
  return `${ref.schema}.${ref.name}`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function getDropStatement(ref: SchemaObjectRef): string {
  switch (ref.kind) {
    case 'function':
      if (!ref.identityArguments) {
        throw new Error(`Function ${formatQualifiedName(ref)} needs identity arguments before it can be dropped safely.`);
      }

      return `DROP FUNCTION IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)}(${ref.identityArguments});`;
    case 'sequence':
      return `DROP SEQUENCE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'table':
      return `DROP TABLE IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
    case 'view':
      return `DROP VIEW IF EXISTS ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};`;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
