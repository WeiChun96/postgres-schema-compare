import { SchemaObjectKind } from '../model/schemaObject';
import { stripSqlComments } from './sqlTextUtils';

/** Canonicalize spelling and layout without changing quoted values or identifiers. */
export function normalizeDefinition(kind: SchemaObjectKind, sql: string): string {
  const definition = kind === 'function' || kind === 'procedure' ? stripMatchingRoutineDrop(kind, sql) : sql;
  const tokens = tokenize(stripSqlComments(definition), kind === 'function' || kind === 'procedure');
  while (tokens[tokens.length - 1] === ';') {
    tokens.pop();
  }

  if (tokens[0] === 'create') {
    if (['view', 'function', 'procedure', 'trigger'].includes(kind) && tokens[1] === 'or' && tokens[2] === 'replace') {
      tokens.splice(1, 2);
    }
    const objectWord = kind === 'materializedView' ? 'view' : kind === 'type' && tokens[1] === 'domain' ? 'domain' : kind.toLowerCase();
    const nameIndex = tokens.indexOf(objectWord) + 1;
    if (nameIndex > 0 && tokens[nameIndex] === 'if' && tokens[nameIndex + 1] === 'not' && tokens[nameIndex + 2] === 'exists') {
      tokens.splice(nameIndex, 3);
    }
  }

  if (kind === 'index') {
    const onIndex = tokens.indexOf('on');
    if (onIndex >= 0) {
      const relationEnd = tokens[onIndex + 2] === '.' ? onIndex + 4 : onIndex + 2;
      if (tokens[relationEnd] === '(') { tokens.splice(relationEnd, 0, 'using', 'btree'); }
    }
  }
  if (kind === 'trigger') {
    const executeIndex = tokens.indexOf('execute');
    if (executeIndex >= 0 && tokens[executeIndex + 1] === 'procedure') { tokens[executeIndex + 1] = 'function'; }
  }

  if (kind === 'sequence') {
    const sequence = normalizeSequence(tokens);
    if (sequence) {
      return sequence;
    }
  }

  if (kind === 'function' || kind === 'procedure') {
    const argumentsClose = findRoutineArgumentsClose(tokens);
    const languageIndex = tokens.indexOf('language', argumentsClose + 1);
    if (languageIndex >= 0 && /^'[a-z_][a-z_0-9]*'$/i.test(tokens[languageIndex + 1] ?? '')) {
      tokens[languageIndex + 1] = tokens[languageIndex + 1].slice(1, -1).toLowerCase();
    }
    if (kind === 'function') { removeDefaultFunctionOptions(tokens, argumentsClose, languageIndex); }
  }

  return JSON.stringify(tokens);
}

/** Remove pgAdmin's deployment prelude only when it names the routine that follows. */
export function stripMatchingRoutineDrop(kind: 'function' | 'procedure', sql: string): string {
  const withoutComments = stripSqlComments(sql).trimStart();
  if (!/^DROP\s+(?:FUNCTION|PROCEDURE)\b/i.test(withoutComments)) { return sql; }
  const terminator = withoutComments.indexOf(';');
  if (terminator < 0) { return sql; }
  const dropTokens = tokenize(withoutComments.slice(0, terminator), false);
  const createSql = withoutComments.slice(terminator + 1).trimStart();
  const createTokens = tokenize(createSql, false);
  const drop = readRoutineHeader(dropTokens, kind, 'drop');
  const create = readRoutineHeader(createTokens, kind, 'create');
  if (!drop || !create || drop.end !== dropTokens.length - 1
    || JSON.stringify(drop.name) !== JSON.stringify(create.name)
    || drop.arguments.length !== create.arguments.length) {
    return sql;
  }
  for (let index = 0; index < drop.arguments.length; index += 1) {
    const target = JSON.stringify(drop.arguments[index]);
    const source = create.arguments[index];
    if (target !== JSON.stringify(source) && target !== JSON.stringify(source.slice(1))) {
      return sql;
    }
  }
  return createSql;
}

interface RoutineHeader {
  readonly name: readonly string[];
  readonly arguments: readonly string[][];
  readonly end: number;
}

function readRoutineHeader(tokens: string[], kind: 'function' | 'procedure', verb: 'drop' | 'create'): RoutineHeader | undefined {
  if (tokens[0] !== verb) { return undefined; }
  let index = 1;
  if (verb === 'drop' && tokens[index] === kind && tokens[index + 1] === 'if'
    && tokens[index + 2] === 'exists') { index += 3; }
  else if (verb === 'create' && tokens[index] === 'or' && tokens[index + 1] === 'replace'
    && tokens[index + 2] === kind) { index += 3; }
  else if (tokens[index] === kind) { index += 1; }
  else { return undefined; }

  const open = tokens.indexOf('(', index);
  if (open < 0 || open === index) { return undefined; }
  const name = tokens.slice(index, open);
  const close = findClosingParenthesis(tokens, open);
  if (close < 0) { return undefined; }
  return { name, arguments: splitRoutineArguments(tokens.slice(open + 1, close)), end: close };
}

function findClosingParenthesis(tokens: readonly string[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index] === '(') { depth += 1; }
    else if (tokens[index] === ')' && --depth === 0) { return index; }
  }
  return -1;
}

function splitRoutineArguments(tokens: readonly string[]): string[][] {
  if (tokens.length === 0) { return []; }
  const argumentsList: string[][] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '(') { depth += 1; }
    else if (tokens[index] === ')') { depth -= 1; }
    else if (tokens[index] === ',' && depth === 0) {
      argumentsList.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  argumentsList.push(tokens.slice(start));
  return argumentsList;
}

function findRoutineArgumentsClose(tokens: string[]): number {
  const argumentsOpen = tokens.indexOf('(');
  if (argumentsOpen < 0) { return -1; }
  let depth = 0;
  for (let index = argumentsOpen; index < tokens.length; index += 1) {
    if (tokens[index] === '(') { depth += 1; }
    if (tokens[index] === ')') {
      depth -= 1;
      if (depth === 0) { return index; }
    }
  }
  return -1;
}

function removeDefaultFunctionOptions(tokens: string[], argumentsClose: number, languageIndex: number): void {
  if (argumentsClose < 0 || languageIndex < 0) { return; }
  const language = tokens[languageIndex + 1];
  const defaultCost = language === 'c' || language === 'internal' ? '1' : '100';
  let depth = 0;
  for (let index = argumentsClose + 1; index < tokens.length;) {
    if (tokens[index] === '(') { depth += 1; index += 1; continue; }
    if (tokens[index] === ')') { depth -= 1; index += 1; continue; }
    if (depth > 0) { index += 1; continue; }
    const pair = `${tokens[index]} ${tokens[index + 1]}`;
    const triple = `${pair} ${tokens[index + 2]}`;
    const width = triple === 'called on null' && tokens[index + 3] === 'input' ? 4
      : pair === 'parallel unsafe' || pair === 'security invoker' || pair === `cost ${defaultCost}` ? 2
        : tokens[index] === 'volatile' ? 1 : 0;
    if (width) { tokens.splice(index, width); }
    else { index += 1; }
  }
}

export function normalizeIdentityClause(value: string, type: string): string {
  const tokens = tokenize(value, false);
  const open = tokens.indexOf('(');
  if (open < 0 || tokens[tokens.length - 1] !== ')') {
    return JSON.stringify(tokens);
  }
  const identityOptions = splitIdentitySequenceName(tokens.slice(open + 1, -1));
  if (!identityOptions) { return JSON.stringify(tokens); }
  const sequenceType = type === 'smallint' || type === 'integer' ? type : 'bigint';
  const normalizedOptions = normalizeSequenceOptions(identityOptions.options, sequenceType);
  // The identity sequence inherits the column's integer type.
  const defaults = normalizeSequenceOptions([], sequenceType);
  if (normalizedOptions === undefined) { return JSON.stringify(tokens); }
  return JSON.stringify(tokens.slice(0, open).concat(
    identityOptions.name ? [JSON.stringify(identityOptions.name)] : [],
    normalizedOptions === defaults ? [] : [normalizedOptions]
  ));
}

export function getIdentitySequenceName(value: string): { readonly schema?: string; readonly name: string } | undefined {
  const tokens = tokenize(value, false);
  const open = tokens.indexOf('(');
  if (open < 0 || tokens[tokens.length - 1] !== ')') { return undefined; }
  const identityOptions = splitIdentitySequenceName(tokens.slice(open + 1, -1));
  if (!identityOptions?.name) { return undefined; }
  const identifiers = identityOptions.name.filter((token) => token !== '.');
  return {
    schema: identifiers.length === 2 ? decodeIdentifier(identifiers[0]) : undefined,
    name: decodeIdentifier(identifiers[identifiers.length - 1])
  };
}

function splitIdentitySequenceName(tokens: string[]): { readonly options: string[]; readonly name?: string[] } | undefined {
  const index = tokens.findIndex((token, position) => token === 'sequence' && tokens[position + 1] === 'name');
  if (index < 0) { return { options: tokens }; }
  const first = tokens[index + 2];
  if (!isIdentifierToken(first)) { return undefined; }
  const name = [first];
  if (tokens[index + 3] === '.') {
    const second = tokens[index + 4];
    if (!isIdentifierToken(second)) { return undefined; }
    name.push('.', second);
  }
  return { options: tokens.slice(0, index).concat(tokens.slice(index + 2 + name.length)), name };
}

function isIdentifierToken(value: string | undefined): value is string {
  return value !== undefined && (/^[a-z_][a-z_0-9$]*$/.test(value) || /^"(?:[^"]|"")+"$/.test(value));
}

function decodeIdentifier(value: string): string {
  return value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value;
}

export function normalizeForeignKeyDefinition(value: string): string {
  const tokens = tokenize(stripSqlComments(value), false);
  const referencesIndex = tokens.indexOf('references');
  if (referencesIndex < 0) { return JSON.stringify(tokens); }

  const remaining: string[] = [];
  const options = new Map<'match' | 'update' | 'delete', string>();
  let depth = 0;
  for (let index = 0; index < tokens.length;) {
    const word = tokens[index];
    if (word === '(') { depth += 1; }
    if (word === ')') { depth -= 1; }
    if (index > referencesIndex && depth === 0 && word === 'match'
      && ['simple', 'full', 'partial'].includes(tokens[index + 1])) {
      if (options.has('match')) { return JSON.stringify(tokens); }
      options.set('match', tokens[index + 1]);
      index += 2;
      continue;
    }
    if (index > referencesIndex && depth === 0 && word === 'on'
      && (tokens[index + 1] === 'update' || tokens[index + 1] === 'delete')) {
      const action = tokens[index + 1] as 'update' | 'delete';
      if (options.has(action)) { return JSON.stringify(tokens); }
      let actionEnd = index + 3;
      if (tokens[actionEnd - 1] === 'no' && tokens[actionEnd] === 'action') { actionEnd += 1; }
      else if (tokens[actionEnd - 1] === 'set' && (tokens[actionEnd] === 'null' || tokens[actionEnd] === 'default')) {
        actionEnd += 1;
        if (tokens[actionEnd] === '(') {
          let columnDepth = 0;
          do {
            if (tokens[actionEnd] === '(') { columnDepth += 1; }
            if (tokens[actionEnd] === ')') { columnDepth -= 1; }
            actionEnd += 1;
          } while (actionEnd < tokens.length && columnDepth > 0);
        }
      } else if (tokens[actionEnd - 1] !== 'cascade' && tokens[actionEnd - 1] !== 'restrict') {
        remaining.push(word);
        index += 1;
        continue;
      }
      options.set(action, JSON.stringify(tokens.slice(index + 2, actionEnd)));
      index = actionEnd;
      continue;
    }
    remaining.push(word);
    index += 1;
  }
  return JSON.stringify([
    remaining,
    options.get('match') ?? 'simple',
    options.get('update') ?? JSON.stringify(['no', 'action']),
    options.get('delete') ?? JSON.stringify(['no', 'action'])
  ]);
}

function normalizeSequence(tokens: string[]): string | undefined {
  if (tokens[0] !== 'create' || tokens[1] !== 'sequence') {
    return undefined;
  }
  let index = 2;
  const name: string[] = [];
  name.push(tokens[index++]);
  if (tokens[index] === '.') { name.push(tokens[index++], tokens[index++]); }
  if (name.length !== 1 && name.length !== 3) {
    return undefined;
  }
  const options = tokens.slice(index);
  let type = 'bigint';
  if (options[0] === 'as' && ['smallint', 'integer', 'bigint'].includes(options[1])) {
    type = options[1];
    options.splice(0, 2);
  }
  const normalized = normalizeSequenceOptions(options, type);
  return normalized === undefined ? undefined : JSON.stringify(['sequence', ...name, normalized]);
}

function normalizeSequenceOptions(tokens: string[], type: string): string | undefined {
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length;) {
    const word = tokens[index++];
    if (word === 'increment' || word === 'start') {
      if (tokens[index] === 'by' || tokens[index] === 'with') { index++; }
      const sign = tokens[index] === '-' || tokens[index] === '+' ? tokens[index++] : '';
      values.set(word, sign + (tokens[index++] ?? ''));
    } else if (word === 'minvalue' || word === 'maxvalue' || word === 'cache') {
      const sign = tokens[index] === '-' || tokens[index] === '+' ? tokens[index++] : '';
      values.set(word, sign + (tokens[index++] ?? ''));
    } else if (word === 'no' && (tokens[index] === 'minvalue' || tokens[index] === 'maxvalue' || tokens[index] === 'cycle')) {
      values.set(tokens[index++], 'no');
    } else if (word === 'cycle') {
      values.set('cycle', 'yes');
    } else if (word === 'owned' && tokens[index++] === 'by') {
      const owner: string[] = [];
      owner.push(tokens[index++] ?? '');
      while (tokens[index] === '.') { owner.push(tokens[index++], tokens[index++] ?? ''); }
      values.set('owned', owner.join(''));
    } else {
      return undefined;
    }
  }
  if ([...values.values()].some((value) => !value)) { return undefined; }
  const increment = values.get('increment') ?? '1';
  const ascending = !increment.startsWith('-');
  const bounds: Record<string, [string, string]> = {
    smallint: ['-32768', '32767'], integer: ['-2147483648', '2147483647'], bigint: ['-9223372036854775808', '9223372036854775807']
  };
  const min = values.get('minvalue') && values.get('minvalue') !== 'no'
    ? values.get('minvalue')! : ascending ? '1' : bounds[type][0];
  const max = values.get('maxvalue') && values.get('maxvalue') !== 'no'
    ? values.get('maxvalue')! : ascending ? bounds[type][1] : '-1';
  const start = values.get('start') ?? (ascending ? min : max);
  return JSON.stringify([type, increment, min, max, start, values.get('cache') ?? '1', values.get('cycle') ?? 'no', values.get('owned') ?? 'none']);
}

function tokenize(sql: string, normalizeDollarBodies: boolean): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === quote && sql[end + 1] === quote) { end += 2; continue; }
        if (sql[end] === '\\' && quote === "'" && /[eE]/.test(sql[index - 1] ?? '') && end + 1 < sql.length) { end += 2; continue; }
        if (sql[end++] === quote) { break; }
      }
      const quoted = sql.slice(index, end);
      const name = quoted.slice(1, -1);
      tokens.push(quote === '"' && /^[a-z_][a-z_0-9]*$/.test(name) ? name : quoted);
      index = end;
      continue;
    }
    if (char === '$') {
      const match = /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/.exec(sql.slice(index));
      if (match) {
        const end = sql.indexOf(match[0], index + match[0].length);
        if (end >= 0) {
          const body = sql.slice(index + match[0].length, end);
          tokens.push(normalizeDollarBodies ? JSON.stringify(tokenize(stripSqlComments(body), false)) : sql.slice(index, end + match[0].length));
          index = end + match[0].length;
          continue;
        }
      }
    }
    const word = /^[a-zA-Z_][a-zA-Z_0-9$]*|^\d+(?:\.\d+)?/.exec(sql.slice(index));
    if (word) {
      tokens.push(word[0].toLowerCase());
      index += word[0].length;
    } else {
      tokens.push(char);
      index++;
    }
  }
  return tokens;
}
