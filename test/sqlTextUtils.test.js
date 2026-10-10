const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ensureSqlStatementTerminator,
  normalizeSqlForComparison,
  stripSqlComments
} = require('../out/services/sqlTextUtils');

test('strips PostgreSQL comments without changing quoted content', () => {
  const sql = [
    '-- local heading',
    "SELECT '--not a comment', '/*also not*/'; /* outer /* nested */ comment */",
    'CREATE FUNCTION f() RETURNS text AS $body$',
    'BEGIN',
    '  -- function-body comment',
    "  RETURN 'ok';",
    'END',
    '$body$ LANGUAGE plpgsql;'
  ].join('\n');

  const stripped = stripSqlComments(sql);

  assert.doesNotMatch(stripped, /local heading|outer|nested/);
  assert.match(stripped, /'--not a comment'/);
  assert.match(stripped, /'\/\*also not\*\/'/);
  assert.match(stripped, /-- function-body comment/);
  assert.equal(stripSqlComments("SELECT '', \"\", foo$tag$bar -- removed\n"), "SELECT '', \"\", foo$tag$bar  \n");
  assert.equal(stripSqlComments("SELECT 'C:\\' -- removed\n"), "SELECT 'C:\\'  \n");
  assert.equal(stripSqlComments("SELECT E'it\\'s -- inside' -- removed\n"), "SELECT E'it\\'s -- inside'  \n");
});

test('comparison normalization ignores comments and an optional final semicolon', () => {
  const databaseSql = 'CREATE VIEW public.example AS\nSELECT 1;';
  const localSql = '-- explanation\nCREATE VIEW public.example AS\nSELECT 1 /* note */';

  assert.equal(normalizeSqlForComparison(localSql), normalizeSqlForComparison(databaseSql));
});

test('adds a missing terminator before trailing comments', () => {
  assert.equal(
    ensureSqlStatementTerminator('CREATE TABLE example (id integer) -- trailing note\n'),
    'CREATE TABLE example (id integer); -- trailing note\n'
  );
  assert.equal(
    ensureSqlStatementTerminator('CREATE TABLE example (id integer); -- trailing note\n'),
    'CREATE TABLE example (id integer); -- trailing note\n'
  );
});

test('does not mistake semicolons in strings or dollar-quoted bodies for the command terminator', () => {
  assert.equal(ensureSqlStatementTerminator("SELECT ';'"), "SELECT ';';");
  assert.equal(
    ensureSqlStatementTerminator('CREATE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql'),
    'CREATE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql;'
  );
});

test('terminates each statement in a pgAdmin table script', () => {
  const sql = [
    'CREATE TABLE IF NOT EXISTS ces.coe_applicant_employment',
    '(',
    '  id integer NOT NULL GENERATED ALWAYS AS IDENTITY ( INCREMENT 1 START 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1 ),',
    '  coe_id uuid NOT NULL,',
    '  CONSTRAINT pk_coe_applicant_employment PRIMARY KEY (id)',
    ') ',
    '',
    'ALTER SEQUENCE ces.seq_coe_applicant_employment_id',
    'RENAME TO seq_coe_applicant_employment;'
  ].join('\n');
  const expected = sql.replace(') \n\nALTER SEQUENCE', '); \n\nALTER SEQUENCE');

  assert.equal(ensureSqlStatementTerminator(sql), expected);
  assert.equal(ensureSqlStatementTerminator(expected), expected);
});

test('terminates multiple DDL statements without changing quoted bodies or trailing comments', () => {
  const sql = [
    'CREATE FUNCTION public.f() RETURNS text AS $body$',
    'BEGIN',
    "  RETURN 'ALTER TABLE t';",
    'END',
    '$body$ LANGUAGE plpgsql -- function ends here',
    'ALTER TABLE public.t ADD COLUMN label text',
    'COMMENT ON COLUMN public.t.label IS \';\' -- final comment'
  ].join('\n');

  assert.equal(
    ensureSqlStatementTerminator(sql),
    sql.replace('LANGUAGE plpgsql --', 'LANGUAGE plpgsql; --')
      .replace('ADD COLUMN label text\n', 'ADD COLUMN label text;\n')
      .replace("IS ';' --", "IS ';'; --")
  );
});

test('keeps multiline ALTER TABLE clauses within one statement', () => {
  const sql = [
    'ALTER TABLE public.t',
    '  ALTER COLUMN label TYPE text,',
    '  ADD COLUMN note text',
    'CREATE INDEX t_note_idx ON public.t (note)'
  ].join('\n');

  assert.equal(
    ensureSqlStatementTerminator(sql),
    sql.replace('ADD COLUMN note text\n', 'ADD COLUMN note text;\n') + ';'
  );
});
