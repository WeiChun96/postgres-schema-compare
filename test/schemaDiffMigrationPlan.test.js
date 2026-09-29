const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { SchemaDiffService, areDefinitionsEquivalent } = require('../out/services/schemaDiffService');
Module._load = originalLoad;

function object(kind, name) {
  return { kind, schema: 'public', name };
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function createService(localSqlByName, liveSqlByName = {}, listedDatabaseObjects) {
  let executedSql;
  let plannedSql;
  const localObjects = Object.keys(localSqlByName).map((key) => {
    const [kind, name] = key.split(':');
    return object(kind, name);
  });
  const postgres = {
    executeSql: async (sql) => {
      executedSql = sql;
    },
    getCreateSchemaSql: (schema) => `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`,
    getDropObjectSql: (ref) => `DROP ${ref.kind.toUpperCase()} ${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)};\n`,
    getObjectDefinition: async (ref) => {
      const ddl = liveSqlByName[`${ref.kind}:${ref.name}`];
      if (ddl === undefined) {
        throw new Error(`${ref.kind} ${ref.schema}.${ref.name} was not found.`);
      }
      return { ddl };
    },
    listSchemaObjects: async () => listedDatabaseObjects ?? localObjects,
    listSchemas: async () => ['public'],
    listConstraintBackedIndexes: async () => []
  };
  const files = {
    getLocalObjectUri: (ref) => `${ref.kind}:${ref.name}`,
    listLocalSchemas: async () => ['public'],
    listLocalObjects: async () => localObjects,
    readLocalFile: async (uri) => localSqlByName[uri],
    tryReadLocalFile: async (uri) => localSqlByName[uri]
  };
  const service = new SchemaDiffService(postgres, files, {
    setDocument: (sql, fileName) => {
      plannedSql = sql;
      return fileName;
    }
  });

  return {
    service,
    getExecutedSql: () => executedSql,
    getPlannedSql: () => plannedSql
  };
}

function assertOrdered(sql, values) {
  let previousIndex = -1;

  for (const value of values) {
    const index = sql.indexOf(value);
    assert.ok(index > previousIndex, `Expected ${JSON.stringify(value)} after the previous migration phase.`);
    previousIndex = index;
  }
}

test('database comparison ignores local comments and an omitted final terminator', () => {
  assert.equal(
    areDefinitionsEquivalent(
      object('view', 'item_view'),
      'CREATE OR REPLACE VIEW public.item_view AS\nSELECT 1;',
      '-- maintained locally\nCREATE OR REPLACE VIEW public.item_view AS\nSELECT 1 /* explanation */'
    ),
    true
  );
  assert.equal(
    areDefinitionsEquivalent(
      object('table', 'item'),
      'CREATE TABLE public.item (\n  id integer NOT NULL\n);',
      '/* table notes */\nCREATE TABLE public.item (\n  id integer /* column notes */ NOT NULL\n)'
    ),
    true
  );
});

test('apply-all plans create prerequisites and dependents in explicit phases', async () => {
  const localSql = {
    'type:status': "CREATE TYPE public.status AS ENUM ('new')",
    'sequence:item_id_seq': 'CREATE SEQUENCE public.item_id_seq',
    'table:item': 'CREATE TABLE public.item (id integer DEFAULT nextval(\'public.item_id_seq\'))',
    'function:item_name': 'CREATE FUNCTION public.item_name() RETURNS text AS $$ SELECT \'item\' $$ LANGUAGE sql',
    'index:item_id_idx': 'CREATE INDEX item_id_idx ON public.item (id)',
    'view:item_view': 'CREATE VIEW public.item_view AS SELECT id FROM public.item',
    'trigger:item_trigger': 'CREATE TRIGGER item_trigger BEFORE INSERT ON public.item EXECUTE FUNCTION public.item_name()'
  };
  const { service, getExecutedSql } = createService(localSql);
  const results = Object.keys(localSql).map((key) => {
    const [kind, name] = key.split(':');
    return { ref: object(kind, name), status: 'localOnly', localUri: key };
  });

  await service.updateDatabaseFromMigrationPlan(results);
  const sql = getExecutedSql();

  assertOrdered(sql, [
    '-- 8. Create prerequisite types',
    '-- 9. Create prerequisite sequences',
    '-- 16. Create tables',
    '-- 19. Create or replace routines',
    '-- 20. Create indexes',
    '-- 21. Create views',
    '-- 22. Create triggers'
  ]);
  assert.match(sql, /CREATE TYPE public\.status AS ENUM \('new'\);/);
  assert.match(sql, /CREATE SEQUENCE public\.item_id_seq;/);
  assert.match(sql, /CREATE TABLE public\.item[\s\S]*\);/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.item_name/);
  assert.match(sql, /CREATE OR REPLACE VIEW public\.item_view/);
});

test('apply-all plans drops in reverse dependency order', async () => {
  const { service, getExecutedSql } = createService({});
  const kinds = ['type', 'sequence', 'table', 'function', 'index', 'view', 'trigger'];
  const results = kinds.map((kind) => ({ ref: object(kind, `${kind}_object`), status: 'missingLocal' }));

  await service.updateDatabaseFromMigrationPlan(results);
  const sql = getExecutedSql();

  assertOrdered(sql, [
    '-- 1. Drop dependent triggers',
    '-- 2. Drop dependent views',
    '-- 3. Drop dependent indexes',
    '-- 4. Drop dependent routines',
    '-- 12. Drop tables',
    '-- 13. Drop sequences',
    '-- 14. Drop types'
  ]);
});

test('modified sequences are altered in place instead of dropped while dependents exist', async () => {
  const localSql = {
    'sequence:item_id_seq': '/* local settings */ CREATE SEQUENCE "Odd Schema"."Order Seq" INCREMENT BY 5'
  };
  const { service, getExecutedSql } = createService(localSql);

  await service.updateDatabaseFromMigrationPlan([{
    ref: object('sequence', 'item_id_seq'),
    status: 'modified',
    localUri: 'sequence:item_id_seq'
  }]);
  const sql = getExecutedSql();

  assert.match(sql, /ALTER SEQUENCE "Odd Schema"\."Order Seq" INCREMENT BY 5;/);
  assert.doesNotMatch(sql, /DROP SEQUENCE/);
});

test('folder comparison recognizes an owned sequence omitted from the catalog object list', async () => {
  const sequenceSql = 'CREATE SEQUENCE public.trans_col_action_btn_id_seq AS integer INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;';
  const { service } = createService(
    { 'sequence:trans_col_action_btn_id_seq': sequenceSql },
    { 'sequence:trans_col_action_btn_id_seq': sequenceSql },
    []
  );

  const results = await service.compareFolderWithDatabase();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'same');
  assert.equal(results[0].ref.kind, 'sequence');
});

test('a stale local-only sequence result does not create an existing sequence again', async () => {
  const localSql = {
    'sequence:owned_seq': 'CREATE SEQUENCE public.owned_seq INCREMENT BY 1',
    'sequence:changed_seq': 'CREATE SEQUENCE public.changed_seq INCREMENT BY 5',
    'sequence:new_seq': 'CREATE SEQUENCE public.new_seq INCREMENT BY 1'
  };
  const liveSql = {
    'sequence:owned_seq': 'CREATE SEQUENCE public.owned_seq INCREMENT BY 1;',
    'sequence:changed_seq': 'CREATE SEQUENCE public.changed_seq INCREMENT BY 1;'
  };
  const { service, getExecutedSql } = createService(localSql, liveSql, []);

  await service.updateDatabaseFromMigrationPlan(Object.keys(localSql).map((key) => ({
    ref: object('sequence', key.slice('sequence:'.length)),
    status: 'localOnly',
    localUri: key
  })));

  const sql = getExecutedSql();
  assert.doesNotMatch(sql, /CREATE SEQUENCE public\.owned_seq/);
  assert.match(sql, /ALTER SEQUENCE public\.changed_seq INCREMENT BY 5;/);
  assert.match(sql, /CREATE SEQUENCE public\.new_seq INCREMENT BY 1;/);
});

test('single-object database update rechecks a local-only sequence', async () => {
  const sql = 'CREATE SEQUENCE public.owned_seq INCREMENT BY 1;';
  const { service, getExecutedSql } = createService(
    { 'sequence:owned_seq': sql },
    { 'sequence:owned_seq': sql },
    []
  );

  await service.updateDatabaseFromFolder(object('sequence', 'owned_seq'));
  assert.equal(getExecutedSql(), undefined);
});

test('table recreation is an explicit plan separate from the default ALTER plan', async () => {
  const localSql = { 'table:item': 'CREATE TABLE public.item (id integer NOT NULL, name text)' };
  const liveSql = { 'table:item': 'CREATE TABLE public.item (id integer NOT NULL)' };
  const { service, getPlannedSql, getExecutedSql } = createService(localSql, liveSql);
  const result = { ref: object('table', 'item'), status: 'modified', localUri: 'table:item' };

  await service.prepareDatabaseMigrationPlan(result);
  assert.match(getPlannedSql(), /ALTER TABLE "public"\."item" ADD COLUMN "name" text;/);
  assert.doesNotMatch(getPlannedSql(), /DROP TABLE/);

  const uri = await service.prepareDatabaseMigrationPlan(result, 'recreate');
  const plan = getPlannedSql();
  assert.match(uri, /\.recreate\.migration\.sql$/);
  assertOrdered(plan, ['DROP TABLE "public"."item";', 'CREATE TABLE public.item']);
  assert.match(plan, /WARNING: Recreating this table removes its rows/);
  assert.doesNotMatch(plan, /ALTER TABLE "public"\."item" ADD COLUMN/);
  assert.doesNotMatch(plan, /CASCADE/);

  await service.updateDatabaseFromMigrationPlan([result], 'recreate');
  assert.match(getExecutedSql(), /DROP TABLE "public"\."item";/);
  assert.match(getExecutedSql(), /CREATE TABLE public\.item/);
});

test('table recreation rebuilds local foreign keys that reference it', async () => {
  const localSql = {
    'table:item': 'CREATE TABLE public.item (id integer NOT NULL, CONSTRAINT item_pkey PRIMARY KEY (id))',
    'table:child': 'CREATE TABLE public.child (id integer, item_id integer, CONSTRAINT child_item_fkey FOREIGN KEY (item_id) REFERENCES public.item(id))'
  };
  const { service, getExecutedSql } = createService(localSql);

  await service.updateDatabaseFromMigrationPlan([{
    ref: object('table', 'item'),
    status: 'modified',
    localUri: 'table:item'
  }], 'recreate');

  assertOrdered(getExecutedSql(), [
    'ALTER TABLE "public"."child" DROP CONSTRAINT IF EXISTS "child_item_fkey";',
    'DROP TABLE "public"."item";',
    'CREATE TABLE public.item',
    'ALTER TABLE "public"."child" ADD CONSTRAINT "child_item_fkey" FOREIGN KEY'
  ]);
});

test('table recreation restores local indexes and triggers in their dependency phases', async () => {
  const localSql = {
    'table:Order" Items': 'CREATE TABLE public."Order"" Items" (id integer NOT NULL)',
    'index:Order Items id idx': 'CREATE INDEX "Order Items id idx" ON public."Order"" Items" (id)',
    'trigger:Order Items audit': 'CREATE TRIGGER "Order Items audit" AFTER INSERT ON public."Order"" Items" FOR EACH ROW EXECUTE FUNCTION public.audit()'
  };
  const { service, getExecutedSql } = createService(localSql);

  await service.updateDatabaseFromMigrationPlan([{
    ref: object('table', 'Order" Items'),
    status: 'modified',
    localUri: 'table:Order" Items'
  }], 'recreate');

  assertOrdered(getExecutedSql(), [
    'DROP TABLE "public"."Order"" Items";',
    'CREATE TABLE public."Order"" Items"',
    'CREATE INDEX "Order Items id idx" ON public."Order"" Items" (id);',
    'CREATE TRIGGER "Order Items audit" AFTER INSERT ON public."Order"" Items"'
  ]);
});

test('bulk recreation emits a table-owned index once when it is also selected', async () => {
  const localSql = {
    'table:item': 'CREATE TABLE public.item (id integer)',
    'index:item_id_idx': 'CREATE INDEX item_id_idx ON public.item (id)'
  };
  const { service, getExecutedSql } = createService(localSql);

  await service.updateDatabaseFromMigrationPlan([
    { ref: object('table', 'item'), status: 'modified', localUri: 'table:item' },
    { ref: object('index', 'item_id_idx'), status: 'localOnly', localUri: 'index:item_id_idx' }
  ], 'recreate');

  assert.equal((getExecutedSql().match(/CREATE INDEX item_id_idx ON public\.item \(id\);/g) ?? []).length, 1);
});

test('table recreation rejects indexes that cannot run in its transaction', async () => {
  const localSql = {
    'table:item': 'CREATE TABLE public.item (id integer)',
    'index:item_id_idx': 'CREATE INDEX CONCURRENTLY item_id_idx ON public.item (id)'
  };
  const { service } = createService(localSql);

  await assert.rejects(
    service.prepareDatabaseMigrationPlan({
      ref: object('table', 'item'),
      status: 'modified',
      localUri: 'table:item'
    }, 'recreate'),
    /CONCURRENTLY, which cannot run inside the table recreation transaction/
  );
});
