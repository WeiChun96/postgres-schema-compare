export function stripSqlComments(sql: string): string {
  return scanSql(sql).withoutComments;
}

export function normalizeSqlForComparison(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/;+\s*$/, '')
    .trimEnd();
}

export function ensureSqlStatementTerminator(sql: string): string {
  const { lastCodeIndex } = scanSql(sql);

  if (lastCodeIndex === undefined || sql[lastCodeIndex] === ';') {
    return sql;
  }

  return `${sql.slice(0, lastCodeIndex + 1)};${sql.slice(lastCodeIndex + 1)}`;
}

interface SqlScanResult {
  readonly withoutComments: string;
  readonly lastCodeIndex?: number;
}

function scanSql(sql: string): SqlScanResult {
  let withoutComments = '';
  let lastCodeIndex: number | undefined;

  for (let index = 0; index < sql.length;) {
    if (sql.startsWith('--', index)) {
      withoutComments += ' ';
      index += 2;

      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') {
        index += 1;
      }

      continue;
    }

    if (sql.startsWith('/*', index)) {
      withoutComments += ' ';
      index = copyBlockCommentNewlines(sql, index + 2, (value) => {
        withoutComments += value;
      });
      continue;
    }

    const dollarQuote = readDollarQuoteDelimiter(sql, index);
    if (dollarQuote) {
      const endIndex = sql.indexOf(dollarQuote, index + dollarQuote.length);
      const tokenEndIndex = endIndex === -1 ? sql.length : endIndex + dollarQuote.length;
      withoutComments += sql.slice(index, tokenEndIndex);
      lastCodeIndex = tokenEndIndex - 1;
      index = tokenEndIndex;
      continue;
    }

    const char = sql[index];

    if (char === '\'' || char === '"') {
      const tokenEndIndex = copyQuotedToken(sql, index, char, isEscapeStringStart(sql, index), (value) => {
        withoutComments += value;
      });
      lastCodeIndex = tokenEndIndex - 1;
      index = tokenEndIndex;
      continue;
    }

    withoutComments += char;

    if (!/\s/.test(char)) {
      lastCodeIndex = index;
    }

    index += 1;
  }

  return { withoutComments, lastCodeIndex };
}

function copyBlockCommentNewlines(sql: string, startIndex: number, append: (value: string) => void): number {
  let depth = 1;

  for (let index = startIndex; index < sql.length;) {
    if (sql.startsWith('/*', index)) {
      depth += 1;
      index += 2;
      continue;
    }

    if (sql.startsWith('*/', index)) {
      depth -= 1;
      index += 2;

      if (depth === 0) {
        return index;
      }

      continue;
    }

    if (sql[index] === '\r') {
      if (sql[index + 1] === '\n') {
        append('\r\n');
        index += 2;
      } else {
        append('\r');
        index += 1;
      }
      continue;
    }

    if (sql[index] === '\n') {
      append('\n');
    }

    index += 1;
  }

  return sql.length;
}

function copyQuotedToken(
  sql: string,
  startIndex: number,
  quote: '\'' | '"',
  backslashEscapes: boolean,
  append: (value: string) => void
): number {
  append(sql[startIndex]);
  let index = startIndex + 1;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (backslashEscapes && char === '\\' && index + 1 < sql.length) {
      append(char);
      append(next);
      index += 2;
      continue;
    }

    if (char !== quote) {
      append(char);
      index += 1;
      continue;
    }

    if (next === quote) {
      append(char);
      append(next);
      index += 2;
      continue;
    }

    append(char);
    return index + 1;
  }

  return index;
}

function isEscapeStringStart(sql: string, quoteIndex: number): boolean {
  if (sql[quoteIndex] !== '\'' || !/[eE]/.test(sql[quoteIndex - 1] ?? '')) {
    return false;
  }

  return !/[a-zA-Z0-9_$]/.test(sql[quoteIndex - 2] ?? '');
}

function readDollarQuoteDelimiter(sql: string, index: number): string | undefined {
  if (sql[index] !== '$' || /[a-zA-Z0-9_$]/.test(sql[index - 1] ?? '')) {
    return undefined;
  }

  const match = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(index));
  return match?.[0];
}
