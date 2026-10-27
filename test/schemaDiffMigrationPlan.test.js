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

const { SchemaDiffService, areDefinitionsEquivalent, getTableOwnedLocalObjectKeys } = require('../out/services/schemaDiffService');
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

test('pgAdmin table identity defaults and default collation compare with catalog DDL', () => {
  const database = 'CREATE TABLE "ces"."employment" (id integer GENERATED ALWAYS AS IDENTITY NOT NULL, employer character varying(150), CONSTRAINT "employment_pkey" PRIMARY KEY (id));';
  const pgadmin = `CREATE TABLE IF NOT EXISTS ces.employment (
    id integer NOT NULL GENERATED ALWAYS AS IDENTITY (INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1),
    employer character varying(150) COLLATE pg_catalog."default",
    CONSTRAINT employment_pkey PRIMARY KEY (id)
  );`;
  assert.equal(areDefinitionsEquivalent(object('table', 'employment'), database, pgadmin), true);
  assert.equal(areDefinitionsEquivalent(object('table', 'employment'), database, pgadmin.replace('CACHE 1', 'CACHE 20')), false);
  assert.equal(areDefinitionsEquivalent(object('table', 'employment'), database, pgadmin.replace('character varying(150)', 'character varying(100)')), false);
  const nondefault = database.replace('AS IDENTITY', 'AS IDENTITY (INCREMENT BY 2 START WITH 10 MINVALUE 1 MAXVALUE 2147483647 CACHE 5)');
  const nondefaultPgadmin = pgadmin.replace('INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1',
    'START 10 MINVALUE 1 INCREMENT 2 CACHE 5 MAXVALUE 2147483647');
  assert.equal(areDefinitionsEquivalent(object('table', 'employment'), nondefault, nondefaultPgadmin), true);
});

test('pgAdmin foreign key default clauses match reconstructed table DDL', () => {
  const local = `CREATE TABLE IF NOT EXISTS ces.coe_applicant_employment
(
    id integer NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 ),
    coe_id uuid NOT NULL,
    period_from character varying(20) COLLATE pg_catalog."default",
    period_to character varying(20) COLLATE pg_catalog."default",
    employer character varying(150) COLLATE pg_catalog."default",
    job_description text COLLATE pg_catalog."default",
    display_order integer NOT NULL,
    CONSTRAINT pk_coe_applicant_employment PRIMARY KEY (id),
    CONSTRAINT uq_coe_applicant_employment_display_order UNIQUE (coe_id, display_order),
    CONSTRAINT fk_coe_applicant_employment_coe FOREIGN KEY (coe_id)
        REFERENCES ces.coe (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
);

ALTER SEQUENCE ces.coe_applicant_employment_id_seq
RENAME TO seq_coe_applicant_employment;`;
  const live = `CREATE TABLE ces.coe_applicant_employment (
  id integer GENERATED ALWAYS AS IDENTITY (INCREMENT BY 1 START WITH 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1) NOT NULL,
  coe_id uuid NOT NULL,
  period_from character varying(20),
  period_to character varying(20),
  employer character varying(150),
  job_description text,
  display_order integer NOT NULL,
  CONSTRAINT fk_coe_applicant_employment_coe FOREIGN KEY (coe_id) REFERENCES ces.coe(id) ON DELETE CASCADE,
  CONSTRAINT pk_coe_applicant_employment PRIMARY KEY (id),
  CONSTRAINT uq_coe_applicant_employment_display_order UNIQUE (coe_id, display_order)
);`;
  const ref = { kind: 'table', schema: 'ces', name: 'coe_applicant_employment' };
  assert.equal(areDefinitionsEquivalent(ref, live, local), true);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('MATCH SIMPLE', 'MATCH FULL')), false);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('ON UPDATE NO ACTION', 'ON UPDATE RESTRICT')), false);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('ON DELETE CASCADE', 'ON DELETE SET NULL')), false);
  assert.equal(areDefinitionsEquivalent(ref, live.replace(' ON DELETE CASCADE', ''),
    local.replace('ON DELETE CASCADE', 'ON DELETE NO ACTION')), true);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('ON UPDATE NO ACTION', 'ON UPDATE CASCADE')), false);
});

test('pgAdmin GENERATED BY DEFAULT identity matches reconstructed table DDL', () => {
  const local = `CREATE TABLE IF NOT EXISTS ces.coe_service_period
(
    id integer NOT NULL GENERATED BY DEFAULT AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 ),
    coe_id uuid NOT NULL,
    period_number integer NOT NULL,
    office_or_position character varying(150) COLLATE pg_catalog."default",
    presently_serving boolean,
    CONSTRAINT pk_coe_service_period PRIMARY KEY (id),
    CONSTRAINT uq_coe_id_period_number UNIQUE (coe_id, period_number),
    CONSTRAINT fk_coe_service_period_coe FOREIGN KEY (coe_id)
        REFERENCES ces.coe (id) MATCH SIMPLE
        ON UPDATE NO ACTION
        ON DELETE CASCADE
);

ALTER SEQUENCE ces.coe_service_period_id_seq
RENAME TO seq_coe_service_period;`;
  const live = `CREATE TABLE ces.coe_service_period (
  id integer GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY 1 START WITH 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1) NOT NULL,
  coe_id uuid NOT NULL,
  period_number integer NOT NULL,
  office_or_position character varying(150),
  presently_serving boolean,
  CONSTRAINT fk_coe_service_period_coe FOREIGN KEY (coe_id) REFERENCES ces.coe(id) ON DELETE CASCADE,
  CONSTRAINT pk_coe_service_period PRIMARY KEY (id),
  CONSTRAINT uq_coe_id_period_number UNIQUE (coe_id, period_number)
);`;
  const ref = { kind: 'table', schema: 'ces', name: 'coe_service_period' };
  assert.equal(areDefinitionsEquivalent(ref, live, local), true);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('GENERATED BY DEFAULT AS IDENTITY', 'GENERATED ALWAYS AS IDENTITY')), false);
  assert.equal(areDefinitionsEquivalent(ref,
    'CREATE TABLE ces.defaults (value integer DEFAULT 1);',
    'CREATE TABLE ces.defaults (value integer DEFAULT 2);'), false);
});

test('employee identity compares with and without a sequence name', () => {
  const ref = object('table', 'employee');
  const local = (sequenceName) => `CREATE TABLE public.employee (
    employee_id BIGINT GENERATED BY DEFAULT AS IDENTITY (${sequenceName}START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 999999999 CACHE 1) PRIMARY KEY,
    employee_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`;
  const live = (sequenceName) => `CREATE TABLE public.employee (
    employee_id bigint GENERATED BY DEFAULT AS IDENTITY (${sequenceName}INCREMENT BY 1 START WITH 1 MINVALUE 1 MAXVALUE 999999999 CACHE 1) NOT NULL,
    employee_name character varying(100) NOT NULL,
    email character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT employee_pkey PRIMARY KEY (employee_id)
  );`;

  assert.equal(areDefinitionsEquivalent(ref, live('SEQUENCE NAME public.seq_employee_id '), local('SEQUENCE NAME public.seq_employee_id ')), true);
  assert.equal(areDefinitionsEquivalent(ref, live(''), local('')), true);
  assert.equal(areDefinitionsEquivalent(ref, live('SEQUENCE NAME public.seq_employee_id '), local('')), false);
  assert.equal(areDefinitionsEquivalent(ref, live(''), local('SEQUENCE NAME public.seq_employee_id ')), false);
  assert.equal(areDefinitionsEquivalent(ref, live('SEQUENCE NAME public.seq_employee_id '),
    local('SEQUENCE NAME public.other_seq ')), false);
  assert.equal(areDefinitionsEquivalent(ref, live('SEQUENCE NAME public.seq_employee_id '),
    local('').replace('CACHE 1)', 'CACHE 1 SEQUENCE NAME "public"."seq_employee_id")')), true);
});

test('named identity sequences are recognized as table-owned local objects', async () => {
  const table = `CREATE TABLE "Odd Schema"."Employee" (
    "Id" bigint GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME "Odd Schema"."Seq""Id"),
    name text
  );`;
  const files = {
    listLocalObjects: async () => [{ kind: 'table', schema: 'Odd Schema', name: 'Employee' }],
    getLocalObjectUri: () => 'employee.sql',
    tryReadLocalFile: async () => table
  };
  const owned = await getTableOwnedLocalObjectKeys(files);
  assert.ok(owned.has('sequence:Odd Schema.Seq"Id'));
});

test('adding an inline primary key column emits the constraint once', async () => {
  const local = 'CREATE TABLE public.employee (email text, employee_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);';
  const live = 'CREATE TABLE public.employee (email text);';
  const { service, getPlannedSql } = createService({ 'table:employee': local }, { 'table:employee': live });

  await service.prepareDatabaseMigrationPlan({ ref: object('table', 'employee'), status: 'modified', localUri: 'table:employee' });
  const plan = getPlannedSql();
  assert.match(plan, /ADD COLUMN "employee_id" bigint GENERATED BY DEFAULT AS IDENTITY;/);
  assert.match(plan, /ADD CONSTRAINT "employee_pkey" PRIMARY KEY \("employee_id"\);/);
  assert.equal((plan.match(/PRIMARY KEY/g) ?? []).length, 1);
});

test('pgAdmin ALTER TABLE constraints participate in comparison and remain deferred in create plans', async () => {
  const live = 'CREATE TABLE public.child (id integer NOT NULL, parent_id integer, CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES public.parent(id));';
  const local = 'CREATE TABLE public.child (id integer NOT NULL, parent_id integer);\nALTER TABLE public.child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES public.parent(id);';
  assert.equal(areDefinitionsEquivalent(object('table', 'child'), live, local), true);
  assert.equal(areDefinitionsEquivalent(object('table', 'child'), live, local.replace('ALTER TABLE public.child', 'ALTER TABLE IF EXISTS ONLY public.child')), true);
  assert.equal(areDefinitionsEquivalent(object('table', 'child'), live, local.replace('REFERENCES public.parent(id)', 'REFERENCES public.other(id)')), false);

  const { service, getPlannedSql } = createService({ 'table:child': local });
  await service.prepareDatabaseMigrationPlan({ ref: object('table', 'child'), status: 'localOnly', localUri: 'table:child' });
  const plan = getPlannedSql();
  assert.equal((plan.match(/ADD CONSTRAINT/g) ?? []).length, 1);
  assert.ok(plan.indexOf('CREATE TABLE public.child') < plan.indexOf('ADD CONSTRAINT'));
});

test('pgAdmin sequence clauses compare by effective settings', () => {
  const live = 'CREATE SEQUENCE "public"."orders_seq" AS bigint INCREMENT BY 1 MINVALUE 0 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;';
  const local = 'CREATE SEQUENCE IF NOT EXISTS public.orders_seq START 1 MINVALUE 0 INCREMENT 1 CACHE 1;';
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'), live, local), true);
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'), live, local.replace('INCREMENT 1', 'INCREMENT 2')), false);
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'), live, local.replace('MINVALUE 0', 'MINVALUE 1')), false);
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'),
    'CREATE SEQUENCE "Mixed Schema"."Order Seq" AS smallint INCREMENT BY -1 MINVALUE -32768 MAXVALUE -1 START WITH -1 CACHE 1 NO CYCLE;',
    'CREATE SEQUENCE "Mixed Schema"."Order Seq" AS smallint START -1 INCREMENT -1;'), true);
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'),
    'CREATE SEQUENCE public.orders_seq OWNED BY public.orders.id;',
    'CREATE SEQUENCE public.orders_seq OWNED BY NONE;'), false);
  assert.equal(areDefinitionsEquivalent(object('sequence', 'orders_seq'),
    'CREATE SEQUENCE public.orders_seq AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 OWNED BY "public"."orders"."id";',
    'CREATE SEQUENCE public.orders_seq OWNED BY public.orders.id;'), true);
});

test('pgAdmin formatting and equivalent syntax compare across supported object kinds', () => {
  const cases = [
    ['view', 'CREATE OR REPLACE VIEW "public"."v" AS SELECT id FROM public.items;', 'CREATE VIEW public.v AS\nSELECT id FROM public.items;'],
    ['materializedView', 'CREATE MATERIALIZED VIEW public.mv AS SELECT id FROM public.items;', 'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT id FROM public.items;'],
    ['index', 'CREATE INDEX items_id_idx ON public.items USING btree (id);', 'CREATE INDEX IF NOT EXISTS "items_id_idx" ON public.items (id);'],
    ['function', 'CREATE OR REPLACE FUNCTION public.f() RETURNS text LANGUAGE plpgsql AS $function$ BEGIN RETURN \'X\'; END; $function$;', 'CREATE FUNCTION "public"."f"() RETURNS text LANGUAGE \'plpgsql\' COST 100 VOLATILE PARALLEL UNSAFE AS $BODY$\nBEGIN\n RETURN \'X\';\nEND;\n$BODY$;'],
    ['procedure', 'CREATE OR REPLACE PROCEDURE public.p() LANGUAGE plpgsql AS $procedure$ BEGIN NULL; END; $procedure$;', 'CREATE PROCEDURE public.p() LANGUAGE \'plpgsql\' AS $$\nBEGIN NULL; END;\n$$;'],
    ['trigger', 'CREATE TRIGGER items_audit AFTER INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.audit();', 'CREATE OR REPLACE TRIGGER items_audit AFTER INSERT ON public.items FOR EACH ROW EXECUTE PROCEDURE public.audit();'],
    ['type', 'CREATE TYPE "public"."status" AS ENUM (\'open\', \'closed\');', 'CREATE TYPE public.status AS ENUM(\'open\',\'closed\');']
  ];
  for (const [kind, live, local] of cases) {
    assert.equal(areDefinitionsEquivalent(object(kind, 'example'), live, local), true, kind);
  }
  assert.equal(areDefinitionsEquivalent(object('type', 'status'), cases[6][1], cases[6][2].replace("'closed'", "'done'")), false);
  assert.equal(areDefinitionsEquivalent(object('function', 'f'), cases[3][1], cases[3][2].replace("'X'", "'Y'")), false);
  assert.equal(areDefinitionsEquivalent(object('function', 'f'), cases[3][1], cases[3][2].replace('COST 100', 'COST 10')), false);
  assert.equal(areDefinitionsEquivalent(object('index', 'items_id_idx'), cases[2][1], cases[2][2].replace('(id)', '(other_id)')), false);
  assert.equal(areDefinitionsEquivalent(object('view', 'v'),
    'CREATE VIEW public.v AS SELECT "Mixed Case", \'Hello\' FROM public.items;',
    'CREATE VIEW public.v AS SELECT "mixed case", \'Hello\' FROM public.items;'), false);
  assert.equal(areDefinitionsEquivalent(object('view', 'v'),
    'CREATE VIEW public.v AS SELECT \'Hello\';',
    'CREATE VIEW public.v AS SELECT \'hello\';'), false);
});

test('pgAdmin function drop prelude does not make the same definition modified', async () => {
  const body = `
    SELECT CASE
        WHEN p_module = 'MA' THEN
        (
            SELECT status
            FROM ces.minority_app
            WHERE cand_uin = p_user_id
              AND status <> 8
            ORDER BY updated_date DESC
            LIMIT 1
        )
        WHEN p_module = 'CD' THEN
        (
            SELECT status
            FROM ces.community_app
            WHERE cand_uin = p_user_id
              AND status <> 8
            ORDER BY updated_date DESC
            LIMIT 1
        )
        WHEN p_module = 'EA' THEN
        (
            SELECT rad.status
            FROM core.role_appointment ra
            INNER JOIN core.role_appointment_detail rad
                ON rad.app_id = ra.app_id
            WHERE rad.cand_uin = p_user_id
              AND rad.status <> 8
            ORDER BY rad.updated_date DESC
            LIMIT 1
        )
        WHEN p_module = 'VL' THEN
        (
            SELECT status
            FROM ces.vernacular_language
            WHERE cand_uin = p_user_id
              AND status <> 8
            ORDER BY updated_date DESC
            LIMIT 1
        )
        ELSE NULL
    END
`;
  const local = `DROP FUNCTION IF EXISTS config.fn_get_module_status(character varying, character varying);
CREATE OR REPLACE FUNCTION config.fn_get_module_status(
    p_module character varying,
    p_user_id character varying)
    RETURNS integer
    LANGUAGE 'sql'
    COST 100
    VOLATILE PARALLEL UNSAFE
AS $BODY$${body}$BODY$;`;
  const live = `CREATE OR REPLACE FUNCTION config.fn_get_module_status(p_module character varying, p_user_id character varying)
 RETURNS integer
 LANGUAGE sql
AS $function$${body}$function$;`;
  const ref = { kind: 'function', schema: 'config', name: 'fn_get_module_status' };
  assert.equal(areDefinitionsEquivalent(ref, live, local), true);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('character varying, character varying', 'integer, character varying')), false);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('DROP FUNCTION IF EXISTS config.', 'DROP FUNCTION IF EXISTS other.')), false);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('character varying, character varying);', 'character varying, character varying) CASCADE;')), false);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace("WHEN p_module = 'VL'", "WHEN p_module = 'XX'")), false);

  const { service, getPlannedSql } = createService({ 'function:fn_get_module_status': local }, { 'function:fn_get_module_status': live });
  await service.prepareDatabaseMigrationPlan({ ref, status: 'modified', localUri: 'function:fn_get_module_status' });
  assert.doesNotMatch(getPlannedSql(), /DROP FUNCTION/i);
});

test('matching procedure drop preludes are ignored without masking another signature', () => {
  const live = 'CREATE OR REPLACE PROCEDURE "public"."refresh_items"(item_id integer) LANGUAGE sql AS $$ SELECT item_id; $$;';
  const local = 'DROP PROCEDURE IF EXISTS public.refresh_items(integer);\nCREATE PROCEDURE public.refresh_items(item_id integer) LANGUAGE \'sql\' AS $BODY$ SELECT item_id; $BODY$;';
  const ref = object('procedure', 'refresh_items');
  assert.equal(areDefinitionsEquivalent(ref, live, local), true);
  assert.equal(areDefinitionsEquivalent(ref, live, local.replace('refresh_items(integer)', 'refresh_items(text)')), false);
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

test('new-table migration separates a following sequence statement from CREATE TABLE', async () => {
  const localSql = [
    'CREATE TABLE IF NOT EXISTS public.item (',
    '  id integer GENERATED ALWAYS AS IDENTITY',
    ')',
    '',
    'ALTER SEQUENCE public.item_id_seq RENAME TO item_seq;'
  ].join('\n');
  const { service, getExecutedSql } = createService({ 'table:item': localSql });

  await service.updateDatabaseFromFolder(object('table', 'item'));

  assert.match(getExecutedSql(), /CREATE TABLE IF NOT EXISTS public\.item \([\s\S]*?\);\s+ALTER SEQUENCE public\.item_id_seq RENAME TO item_seq;/);
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
