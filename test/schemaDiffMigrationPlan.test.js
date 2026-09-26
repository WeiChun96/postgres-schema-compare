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

function createService(localSqlByName) {
  let executedSql;
  const localObjects = Object.keys(localSqlByName).map((key) => {
    const [kind, name] = key.split(':');
    return object(kind, name);
  });
  const postgres = {
    executeSql: async (sql) => {
      executedSql = sql;
    },
    getCreateSchemaSql: (schema) => `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`,
    getDropObjectSql: (ref) => `DROP ${ref.kind.toUpperCase()} "${ref.schema}"."${ref.name}";\n`
  };
  const files = {
    getLocalObjectUri: (ref) => `${ref.kind}:${ref.name}`,
    listLocalObjects: async () => localObjects,
    readLocalFile: async (uri) => localSqlByName[uri],
    tryReadLocalFile: async (uri) => localSqlByName[uri]
  };
  const service = new SchemaDiffService(postgres, files, {});

  return {
    service,
    getExecutedSql: () => executedSql
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
