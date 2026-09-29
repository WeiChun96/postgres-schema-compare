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
