import * as vscode from 'vscode';
import { SchemaObjectKind, SchemaObjectRef } from '../model/schemaObject';
import { PostgresSchemaService } from './postgresSchemaService';
import { SchemaFileService } from './schemaFileService';

export interface PreparedSchemaDiff {
  readonly leftUri: vscode.Uri;
  readonly rightUri: vscode.Uri;
  readonly title: string;
}

export type DiffDirection = 'databaseToLocal' | 'localToDatabase';

export type SchemaComparisonStatus = 'modified' | 'missingLocal' | 'localOnly' | 'same' | 'error';

export interface SchemaComparisonResult {
  readonly ref: SchemaObjectRef;
  readonly status: SchemaComparisonStatus;
  readonly localUri?: vscode.Uri;
  readonly message?: string;
}

export interface ExportDatabaseResult {
  readonly writtenCount: number;
  readonly failures: readonly ExportDatabaseFailure[];
}

export interface ExportDatabaseFailure {
  readonly ref: SchemaObjectRef;
  readonly message: string;
}

export class SchemaDiffService {
  public constructor(
    private readonly postgresSchemaService: PostgresSchemaService,
    private readonly schemaFileService: SchemaFileService,
    private readonly liveDocumentProvider: LiveSchemaDocumentProvider
  ) {}

  public async prepareDiff(localUri: vscode.Uri, direction: DiffDirection = 'databaseToLocal'): Promise<PreparedSchemaDiff> {
    const ref = this.schemaFileService.resolveObjectRefFromFile(localUri);
    const liveUri = await this.getLiveUriOrEmpty(ref);

    return createPreparedDiff(ref, liveUri, localUri, direction);
  }

  public async prepareObjectDiff(ref: SchemaObjectRef, direction: DiffDirection = 'databaseToLocal'): Promise<PreparedSchemaDiff> {
    const localUri = this.schemaFileService.getLocalObjectUri(ref);
    const localDiffUri = (await this.schemaFileService.tryReadLocalFile(localUri)) === undefined
      ? this.liveDocumentProvider.setDocument('', getEmptyDocumentFileName(ref, 'local'))
      : localUri;
    const liveUri = await this.getLiveUriOrEmpty(ref);

    return createPreparedDiff(ref, liveUri, localDiffUri, direction);
  }

  public async prepareComparisonDiff(
    result: SchemaComparisonResult,
    direction: DiffDirection = 'databaseToLocal'
  ): Promise<PreparedSchemaDiff> {
    if (result.status === 'error') {
      throw new Error(result.message ?? 'Could not compare this object.');
    }

    if (result.status === 'localOnly') {
      const localUri = result.localUri ?? this.schemaFileService.getLocalObjectUri(result.ref);
      const liveUri = this.liveDocumentProvider.setDocument('', getEmptyDocumentFileName(result.ref, 'database'));

      return createPreparedDiff(result.ref, liveUri, localUri, direction);
    }

    return this.prepareObjectDiff(result.ref, direction);
  }

  public async compareFolderWithDatabase(): Promise<SchemaComparisonResult[]> {
    const databaseObjects = await this.postgresSchemaService.listSchemaObjects();
    const localObjects = await this.schemaFileService.listLocalObjects();
    const databaseObjectsByLocalFileKey = new Map(databaseObjects.map((object) => [getLocalFileObjectKey(object), object]));
    const results: SchemaComparisonResult[] = [];

    for (const databaseObject of databaseObjects) {
      const localUri = this.schemaFileService.getLocalObjectUri(databaseObject);
      const localSql = await this.schemaFileService.tryReadLocalFile(localUri);

      if (localSql === undefined) {
        results.push({ ref: databaseObject, status: 'missingLocal', localUri });
        continue;
      }

      try {
        const liveDefinition = await this.postgresSchemaService.getObjectDefinition(databaseObject);
        const isSame = areDefinitionsEquivalent(databaseObject, liveDefinition.ddl, localSql);
        results.push({
          ref: databaseObject,
          status: isSame ? 'same' : 'modified',
          localUri,
          message: isSame ? undefined : describeDefinitionChanges(databaseObject, liveDefinition.ddl, localSql)
        });
      } catch (error) {
        results.push({
          ref: databaseObject,
          status: 'error',
          localUri,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    for (const localObject of localObjects) {
      if (!databaseObjectsByLocalFileKey.has(getLocalFileObjectKey(localObject))) {
        results.push({
          ref: localObject,
          status: 'localOnly',
          localUri: this.schemaFileService.getLocalObjectUri(localObject)
        });
      }
    }

    return results.sort((left, right) => {
      const statusOrder = getStatusOrder(left.status) - getStatusOrder(right.status);
      return statusOrder !== 0 ? statusOrder : getObjectKey(left.ref).localeCompare(getObjectKey(right.ref));
    });
  }

  public async compareObjectWithDatabase(ref: SchemaObjectRef): Promise<SchemaComparisonResult> {
    const localUri = this.schemaFileService.getLocalObjectUri(ref);
    const localSql = await this.schemaFileService.tryReadLocalFile(localUri);

    if (localSql === undefined) {
      try {
        await this.postgresSchemaService.getObjectDefinition(ref);
        return { ref, status: 'missingLocal', localUri };
      } catch (error) {
        if (isObjectNotFoundError(error)) {
          return { ref, status: 'same', localUri };
        }

        return {
          ref,
          status: 'error',
          localUri,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }

    try {
      const liveDefinition = await this.postgresSchemaService.getObjectDefinition(ref);
      const isSame = areDefinitionsEquivalent(ref, liveDefinition.ddl, localSql);
      return {
        ref,
        status: isSame ? 'same' : 'modified',
        localUri,
        message: isSame ? undefined : describeDefinitionChanges(ref, liveDefinition.ddl, localSql)
      };
    } catch (error) {
      if (isObjectNotFoundError(error)) {
        return { ref, status: 'localOnly', localUri };
      }

      return {
        ref,
        status: 'error',
        localUri,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async exportDatabaseToFolder(): Promise<ExportDatabaseResult> {
    const databaseObjects = await this.postgresSchemaService.listSchemaObjects();
    let writtenCount = 0;
    const failures: ExportDatabaseFailure[] = [];

    for (const object of databaseObjects) {
      try {
        const definition = await this.postgresSchemaService.getObjectDefinition(object);
        await this.schemaFileService.writeLocalDefinition(definition);
        writtenCount += 1;
      } catch (error) {
        failures.push({
          ref: object,
          message: formatUnknownError(error)
        });
      }
    }

    return { writtenCount, failures };
  }

  public async updateFolderFromDatabase(ref: SchemaObjectRef): Promise<vscode.Uri> {
    const definition = await this.postgresSchemaService.getObjectDefinition(ref);
    return this.schemaFileService.writeLocalDefinition(definition);
  }

  public async updateFolderFromDatabaseFile(localUri: vscode.Uri): Promise<vscode.Uri> {
    return this.updateFolderFromDatabase(this.schemaFileService.resolveObjectRefFromFile(localUri));
  }

  public async deleteLocalObject(ref: SchemaObjectRef): Promise<vscode.Uri> {
    return this.schemaFileService.deleteLocalDefinition(ref);
  }

  public async deleteLocalObjectFile(localUri: vscode.Uri): Promise<vscode.Uri> {
    return this.schemaFileService.deleteLocalFile(localUri);
  }

  public getLocalObjectUri(ref: SchemaObjectRef): vscode.Uri {
    return this.schemaFileService.getLocalObjectUri(ref);
  }

  public getSchemaRootUri(): vscode.Uri {
    return this.schemaFileService.getSchemaRootUri();
  }

  public getLocalSchemaUri(schema: string): vscode.Uri {
    return this.schemaFileService.getLocalSchemaUri(schema);
  }

  public getLocalObjectKindFolderUri(schema: string, kind: SchemaObjectKind): vscode.Uri {
    return this.schemaFileService.getLocalObjectKindFolderUri(schema, kind);
  }

  public async updateDatabaseFromFolder(ref: SchemaObjectRef, replaceExisting = false): Promise<void> {
    const localUri = this.schemaFileService.getLocalObjectUri(ref);
    const sql = await this.schemaFileService.readLocalFile(localUri);

    if (!normalizeSql(sql)) {
      throw new Error(`Local file for ${ref.schema}.${ref.name} is empty.`);
    }

    if (replaceExisting) {
      await this.postgresSchemaService.executeSql(await this.getDatabaseMigrationPlanSql({ ref, status: 'modified', localUri }));
      return;
    }

    await this.postgresSchemaService.executeSql(sql);
  }

  public async prepareDatabaseMigrationPlan(result: SchemaComparisonResult): Promise<vscode.Uri> {
    if (result.status === 'error') {
      throw new Error(result.message ?? 'Could not prepare a migration plan for this object.');
    }

    const sql = await this.getDatabaseMigrationPlanSql(result);
    return this.liveDocumentProvider.setDocument(sql, `${result.ref.schema}.${result.ref.name}.migration.sql`);
  }

  public async prepareDatabaseMigrationPlanForResults(results: readonly SchemaComparisonResult[]): Promise<vscode.Uri> {
    const sql = await this.getDatabaseMigrationPlanSqlForResults(results);
    return this.liveDocumentProvider.setDocument(sql, 'schema-folder-database.migration.sql');
  }

  public async updateDatabaseFromMigrationPlan(results: readonly SchemaComparisonResult[]): Promise<void> {
    await this.postgresSchemaService.executeSql(await this.getDatabaseMigrationPlanSqlForResults(results));
  }

  public async updateDatabaseFromFolderFile(localUri: vscode.Uri, replaceExisting = true): Promise<void> {
    const ref = this.schemaFileService.resolveObjectRefFromFile(localUri);
    const sql = await this.schemaFileService.readLocalFile(localUri);

    if (!normalizeSql(sql)) {
      throw new Error(`Local file ${localUri.fsPath} is empty.`);
    }

    if (replaceExisting) {
      await this.postgresSchemaService.executeSql(await this.getDatabaseMigrationPlanSql({ ref, status: 'modified', localUri }));
      return;
    }

    await this.postgresSchemaService.executeSql(sql);
  }

  public async dropDatabaseObject(ref: SchemaObjectRef): Promise<void> {
    await this.postgresSchemaService.dropObject(ref);
  }

  public async dropDatabaseObjectFile(localUri: vscode.Uri): Promise<void> {
    await this.postgresSchemaService.dropObject(this.schemaFileService.resolveObjectRefFromFile(localUri));
  }

  private async getDatabaseMigrationPlanSql(result: SchemaComparisonResult): Promise<string> {
    return formatMigrationPlanPhases(await this.getDatabaseMigrationPlanPhases(result), true);
  }

  private async getDatabaseMigrationPlanPhases(
    result: SchemaComparisonResult,
    localTables?: ReadonlyMap<string, ParsedTableDefinition>
  ): Promise<MigrationPlanPhases> {
    if (result.status === 'missingLocal') {
      return createMigrationPlanPhases({
        other: [this.postgresSchemaService.getDropObjectSql(result.ref).trim()]
      });
    }

    const localUri = result.localUri ?? this.schemaFileService.getLocalObjectUri(result.ref);
    const sql = await this.schemaFileService.readLocalFile(localUri);

    if (!normalizeSql(sql)) {
      throw new Error(`Local file for ${result.ref.schema}.${result.ref.name} is empty.`);
    }

    if (result.status === 'modified' && result.ref.kind === 'table') {
      const liveDefinition = await this.postgresSchemaService.getObjectDefinition(result.ref);
      return createTableMigrationPlanPhases(result.ref, liveDefinition.ddl, sql, localTables);
    }

    if (result.status === 'modified') {
      return createMigrationPlanPhases({
        other: [stripTransactionWrapper(this.postgresSchemaService.getSqlReplacingObject(result.ref, sql)).trim()]
      });
    }

    return createMigrationPlanPhases({
      other: [sql.trim()]
    });
  }

  private async getDatabaseMigrationPlanSqlForResults(results: readonly SchemaComparisonResult[]): Promise<string> {
    const actionableResults = results.filter((result) => result.status !== 'error');

    if (actionableResults.length === 0) {
      throw new Error('No database differences are available for migration.');
    }

    const combined = createMigrationPlanPhases();
    const localTables = await this.getLocalTableDefinitions();

    for (const result of sortMigrationResultsByTableDependencies(actionableResults, localTables)) {
      appendMigrationPlanPhases(
        combined,
        await this.getDatabaseMigrationPlanPhases(result, localTables),
        `-- ${result.ref.schema}.${result.ref.name} (${result.ref.kind}, ${result.status})`
      );
    }

    return formatMigrationPlanPhases(combined, true);
  }

  private async getLiveUriOrEmpty(ref: SchemaObjectRef): Promise<vscode.Uri> {
    try {
      const liveDefinition = await this.postgresSchemaService.getObjectDefinition(ref);

      return this.liveDocumentProvider.setDocument(liveDefinition.ddl, `${ref.schema}.${ref.name}.sql`);
    } catch (error) {
      if (isObjectNotFoundError(error)) {
        return this.liveDocumentProvider.setDocument('', getEmptyDocumentFileName(ref, 'database'));
      }

      throw error;
    }
  }

  private async getLocalTableDefinitions(): Promise<ReadonlyMap<string, ParsedTableDefinition>> {
    const tables = new Map<string, ParsedTableDefinition>();
    const localObjects = await this.schemaFileService.listLocalObjects();

    for (const localObject of localObjects) {
      if (localObject.kind !== 'table') {
        continue;
      }

      const localSql = await this.schemaFileService.tryReadLocalFile(this.schemaFileService.getLocalObjectUri(localObject));
      if (!localSql) {
        continue;
      }

      try {
        tables.set(getTableDefinitionKey(localObject.schema, localObject.name), parseCreateTableDefinition(localSql));
      } catch {
        // Ignore unparseable local tables here. The normal comparison path reports those failures.
      }
    }

    return tables;
  }
}

function sortMigrationResultsByTableDependencies(
  results: readonly SchemaComparisonResult[],
  localTables: ReadonlyMap<string, ParsedTableDefinition>
): SchemaComparisonResult[] {
  const tableResultsByKey = new Map<string, SchemaComparisonResult>();
  const tableResultKeys = new Set<string>();
  const ordered: SchemaComparisonResult[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const result of results) {
    if (result.ref.kind !== 'table') {
      continue;
    }

    const key = getTableDefinitionKey(result.ref.schema, result.ref.name);
    tableResultsByKey.set(key, result);
    tableResultKeys.add(key);
  }

  const visit = (key: string): void => {
    if (visited.has(key)) {
      return;
    }

    if (visiting.has(key)) {
      return;
    }

    visiting.add(key);

    const result = tableResultsByKey.get(key);
    const table = localTables.get(key);

    if (result && table) {
      for (const constraint of table.constraints.values()) {
        const reference = constraint.foreignKeyReference;
        if (!reference) {
          continue;
        }

        const referencedKey = getTableDefinitionKey(reference.schema ?? result.ref.schema, reference.table);
        if (tableResultKeys.has(referencedKey)) {
          visit(referencedKey);
        }
      }
    }

    visiting.delete(key);
    visited.add(key);

    if (result) {
      ordered.push(result);
    }
  };

  for (const result of results) {
    if (result.ref.kind === 'table') {
      visit(getTableDefinitionKey(result.ref.schema, result.ref.name));
    }
  }

  for (const result of results) {
    if (result.ref.kind !== 'table') {
      ordered.push(result);
    }
  }

  return ordered;
}

function createPreparedDiff(
  ref: SchemaObjectRef,
  liveUri: vscode.Uri,
  localUri: vscode.Uri,
  direction: DiffDirection
): PreparedSchemaDiff {
  if (direction === 'localToDatabase') {
    return {
      leftUri: localUri,
      rightUri: liveUri,
      title: `${ref.schema}.${ref.name}: Local vs Database`
    };
  }

  return {
    leftUri: liveUri,
    rightUri: localUri,
    title: `${ref.schema}.${ref.name}: Database vs Local`
  };
}

export class LiveSchemaDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.changeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  public setDocument(content: string, fileName: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: 'postgres-schema',
      authority: 'live',
      path: `/${encodeURIComponent(fileName)}`
    });

    this.documents.set(uri.toString(), content);
    this.changeEmitter.fire(uri);

    return uri;
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    this.documents.clear();
  }
}

function getObjectKey(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}:${ref.identityArguments ?? ''}`;
}

function getLocalFileObjectKey(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}`;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n').trim();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function areDefinitionsEquivalent(ref: SchemaObjectRef, liveSql: string, localSql: string): boolean {
  if (ref.kind !== 'table') {
    return normalizeSql(liveSql) === normalizeSql(localSql);
  }

  try {
    return areTableDefinitionsEquivalent(liveSql, localSql);
  } catch {
    return normalizeSql(liveSql) === normalizeSql(localSql);
  }
}

export function describeDefinitionChanges(ref: SchemaObjectRef, liveSql: string, localSql: string): string {
  if (ref.kind === 'table') {
    try {
      return describeTableDefinitionChanges(liveSql, localSql);
    } catch {
      return describeSqlLineChanges(liveSql, localSql);
    }
  }

  return describeSqlLineChanges(liveSql, localSql);
}

interface ParsedTableDefinition {
  readonly columns: ReadonlyMap<string, ParsedColumn>;
  readonly constraints: ReadonlyMap<string, ParsedConstraint>;
}

interface ParsedColumn {
  readonly name: string;
  readonly definition: string;
  readonly type: string;
  readonly defaultValue?: string;
  readonly notNull: boolean;
  readonly identity?: string;
  readonly raw: string;
}

interface ParsedConstraint {
  readonly name: string;
  readonly definition: string;
  readonly kind: ParsedConstraintKind;
  readonly foreignKeyReference?: ForeignKeyReference;
  readonly raw: string;
}

type ParsedConstraintKind = 'foreignKey' | 'primaryUniqueCheck' | 'other';

interface ForeignKeyReference {
  readonly schema?: string;
  readonly table: string;
  readonly columns: readonly string[];
}

interface MigrationPlanPhases {
  readonly dropForeignKeys: string[];
  readonly dropPrimaryUniqueCheckConstraints: string[];
  readonly alterColumns: string[];
  readonly addPrimaryUniqueCheckConstraints: string[];
  readonly addForeignKeys: string[];
  readonly other: string[];
}

function areTableDefinitionsEquivalent(liveSql: string, localSql: string): boolean {
  const liveTable = parseCreateTableDefinition(liveSql);
  const localTable = parseCreateTableDefinition(localSql);

  return areMapsEquivalent(liveTable.columns, localTable.columns, areColumnsEquivalent)
    && areMapsEquivalent(liveTable.constraints, localTable.constraints, areConstraintsEquivalent);
}

function areMapsEquivalent<T>(
  left: ReadonlyMap<string, T>,
  right: ReadonlyMap<string, T>,
  isEquivalent: (leftValue: T, rightValue: T) => boolean
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);

    if (!rightValue || !isEquivalent(leftValue, rightValue)) {
      return false;
    }
  }

  return true;
}

function areColumnsEquivalent(left: ParsedColumn, right: ParsedColumn): boolean {
  return normalizeTypeName(left.type) === normalizeTypeName(right.type)
    && normalizeSqlFragment(left.defaultValue ?? '') === normalizeSqlFragment(right.defaultValue ?? '')
    && left.notNull === right.notNull
    && normalizeSqlFragment(left.identity ?? '') === normalizeSqlFragment(right.identity ?? '');
}

function areConstraintsEquivalent(left: ParsedConstraint, right: ParsedConstraint): boolean {
  return normalizeSqlFragment(left.definition) === normalizeSqlFragment(right.definition);
}

function describeTableDefinitionChanges(liveSql: string, localSql: string): string {
  const liveTable = parseCreateTableDefinition(liveSql);
  const localTable = parseCreateTableDefinition(localSql);
  const changes: string[] = [];

  for (const [name] of liveTable.columns) {
    if (!localTable.columns.has(name)) {
      changes.push(`drop column ${quoteIdentifier(name)}`);
    }
  }

  for (const [name, localColumn] of localTable.columns) {
    const liveColumn = liveTable.columns.get(name);

    if (!liveColumn) {
      changes.push(`add column ${quoteIdentifier(name)} ${localColumn.type}`);
      continue;
    }

    const columnChanges = describeColumnChanges(liveColumn, localColumn);

    if (columnChanges.length > 0) {
      changes.push(`change column ${quoteIdentifier(name)}: ${columnChanges.join(', ')}`);
    }
  }

  for (const [name, liveConstraint] of liveTable.constraints) {
    const localConstraint = localTable.constraints.get(name);

    if (!localConstraint) {
      changes.push(`drop constraint ${quoteIdentifier(name)}`);
    } else if (!areConstraintsEquivalent(liveConstraint, localConstraint)) {
      changes.push(`change constraint ${quoteIdentifier(name)}`);
    }
  }

  for (const [name] of localTable.constraints) {
    if (!liveTable.constraints.has(name)) {
      changes.push(`add constraint ${quoteIdentifier(name)}`);
    }
  }

  return summarizeChanges(changes, 'Table definition changed.');
}

function describeColumnChanges(liveColumn: ParsedColumn, localColumn: ParsedColumn): string[] {
  const changes: string[] = [];

  if (normalizeTypeName(liveColumn.type) !== normalizeTypeName(localColumn.type)) {
    changes.push(`type ${liveColumn.type} -> ${localColumn.type}`);
  }

  if (normalizeSqlFragment(liveColumn.defaultValue ?? '') !== normalizeSqlFragment(localColumn.defaultValue ?? '')) {
    changes.push(`default ${formatOptionalSqlValue(liveColumn.defaultValue)} -> ${formatOptionalSqlValue(localColumn.defaultValue)}`);
  }

  if (liveColumn.notNull !== localColumn.notNull) {
    changes.push(localColumn.notNull ? 'set NOT NULL' : 'drop NOT NULL');
  }

  if (normalizeSqlFragment(liveColumn.identity ?? '') !== normalizeSqlFragment(localColumn.identity ?? '')) {
    changes.push(`identity ${formatOptionalSqlValue(liveColumn.identity)} -> ${formatOptionalSqlValue(localColumn.identity)}`);
  }

  return changes;
}

function describeSqlLineChanges(liveSql: string, localSql: string): string {
  const liveLines = normalizeSql(liveSql).split('\n');
  const localLines = normalizeSql(localSql).split('\n');
  const maxLength = Math.max(liveLines.length, localLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const liveLine = (liveLines[index] ?? '').trim();
    const localLine = (localLines[index] ?? '').trim();

    if (liveLine !== localLine) {
      return `SQL changed at line ${index + 1}: database "${truncateDetail(liveLine)}" -> folder "${truncateDetail(localLine)}"`;
    }
  }

  return 'SQL definition changed.';
}

function summarizeChanges(changes: readonly string[], fallback: string): string {
  if (changes.length === 0) {
    return fallback;
  }

  const visibleChanges = changes.slice(0, 4);
  const suffix = changes.length > visibleChanges.length ? `, +${changes.length - visibleChanges.length} more` : '';
  return `${visibleChanges.join('; ')}${suffix}`;
}

function createTableMigrationPlanPhases(
  ref: SchemaObjectRef,
  liveSql: string,
  localSql: string,
  localTables?: ReadonlyMap<string, ParsedTableDefinition>
): MigrationPlanPhases {
  const liveTable = parseCreateTableDefinition(liveSql);
  const localTable = parseCreateTableDefinition(localSql);
  const phases = createMigrationPlanPhases();
  const tableName = getQualifiedName(ref);

  if (hasPrimaryKeyOrForeignKeyChanges(liveTable, localTable)) {
    return createTableRebuildMigrationPlanPhases(ref, liveTable, localTable, localTables);
  }

  for (const [name, liveConstraint] of liveTable.constraints) {
    const localConstraint = localTable.constraints.get(name);

    if (!localConstraint || normalizeSqlFragment(localConstraint.raw) !== normalizeSqlFragment(liveConstraint.raw)) {
      getDropConstraintPhase(phases, liveConstraint).push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(name)};`);
    }
  }

  for (const [name] of liveTable.columns) {
    if (!localTable.columns.has(name)) {
      phases.alterColumns.push(`ALTER TABLE ${tableName} DROP COLUMN ${quoteIdentifier(name)};`);
    }
  }

  for (const [name, localColumn] of localTable.columns) {
    const liveColumn = liveTable.columns.get(name);

    if (!liveColumn) {
      phases.alterColumns.push(`ALTER TABLE ${tableName} ADD COLUMN ${quoteIdentifier(name)} ${localColumn.definition};`);
      continue;
    }

    phases.alterColumns.push(...createColumnAlterStatements(tableName, liveColumn, localColumn));
  }

  for (const [name, localConstraint] of localTable.constraints) {
    const liveConstraint = liveTable.constraints.get(name);

    if (!liveConstraint || normalizeSqlFragment(localConstraint.raw) !== normalizeSqlFragment(liveConstraint.raw)) {
      getAddConstraintPhase(phases, localConstraint).push(...createAddConstraintStatements(ref, tableName, name, localConstraint, localTables));
    }
  }

  if (getMigrationPlanStatements(phases).length === 0) {
    phases.other.push(`-- No compatible ALTER TABLE changes were detected for ${ref.schema}.${ref.name}.`);
  }

  return phases;
}

function createTableRebuildMigrationPlanPhases(
  ref: SchemaObjectRef,
  liveTable: ParsedTableDefinition,
  localTable: ParsedTableDefinition,
  localTables?: ReadonlyMap<string, ParsedTableDefinition>
): MigrationPlanPhases {
  const phases = createMigrationPlanPhases();
  const tableName = getQualifiedName(ref);

  for (const [name, liveConstraint] of liveTable.constraints) {
    if (liveConstraint.kind === 'foreignKey') {
      phases.dropForeignKeys.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(name)};`);
    }
  }

  phases.alterColumns.push(`-- WARNING: Rebuilding ${ref.schema}.${ref.name} because primary key or foreign key definitions changed.`);
  phases.alterColumns.push(`-- This drops table data. Review and backup before running against important databases.`);
  phases.alterColumns.push(`DROP TABLE IF EXISTS ${tableName} CASCADE;`);
  phases.alterColumns.push(createCreateTableWithoutForeignKeysSql(ref, localTable));

  for (const [name, localConstraint] of localTable.constraints) {
    if (localConstraint.kind === 'foreignKey') {
      phases.addForeignKeys.push(...createAddConstraintStatements(ref, tableName, name, localConstraint, localTables));
    }
  }

  return phases;
}

function hasPrimaryKeyOrForeignKeyChanges(liveTable: ParsedTableDefinition, localTable: ParsedTableDefinition): boolean {
  const relevantConstraintNames = new Set<string>();

  for (const [name, constraint] of liveTable.constraints) {
    if (isPrimaryKeyOrForeignKeyConstraint(constraint)) {
      relevantConstraintNames.add(name);
    }
  }

  for (const [name, constraint] of localTable.constraints) {
    if (isPrimaryKeyOrForeignKeyConstraint(constraint)) {
      relevantConstraintNames.add(name);
    }
  }

  for (const name of relevantConstraintNames) {
    const liveConstraint = liveTable.constraints.get(name);
    const localConstraint = localTable.constraints.get(name);

    if (!liveConstraint || !localConstraint) {
      return true;
    }

    if (normalizeSqlFragment(liveConstraint.raw) !== normalizeSqlFragment(localConstraint.raw)) {
      return true;
    }
  }

  return false;
}

function isPrimaryKeyOrForeignKeyConstraint(constraint: ParsedConstraint): boolean {
  return constraint.kind === 'foreignKey' || normalizeSqlFragment(constraint.definition).startsWith('primary key');
}

function createCreateTableWithoutForeignKeysSql(ref: SchemaObjectRef, table: ParsedTableDefinition): string {
  const definitions = [
    ...Array.from(table.columns.values()).map((column) => `  ${column.raw}`),
    ...Array.from(table.constraints.values())
      .filter((constraint) => constraint.kind !== 'foreignKey')
      .map((constraint) => `  ${constraint.raw}`)
  ];

  return `CREATE TABLE ${getQualifiedName(ref)} (\n${definitions.join(',\n')}\n);`;
}

function createColumnAlterStatements(tableName: string, liveColumn: ParsedColumn, localColumn: ParsedColumn): string[] {
  const statements: string[] = [];
  const columnName = quoteIdentifier(localColumn.name);

  if (normalizeSqlFragment(liveColumn.identity ?? '') !== normalizeSqlFragment(localColumn.identity ?? '')) {
    throw new Error(`Column ${localColumn.name} changes identity generation, which cannot be migrated safely yet.`);
  }

  if (normalizeSqlFragment(liveColumn.type) !== normalizeSqlFragment(localColumn.type)) {
    statements.push(
      `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${localColumn.type}${getTypeMigrationUsingClause(columnName, liveColumn, localColumn)};`
    );
  }

  if (normalizeSqlFragment(liveColumn.defaultValue ?? '') !== normalizeSqlFragment(localColumn.defaultValue ?? '')) {
    statements.push(
      localColumn.defaultValue
        ? `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${localColumn.defaultValue};`
        : `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT;`
    );
  }

  if (liveColumn.notNull !== localColumn.notNull) {
    statements.push(
      localColumn.notNull
        ? `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL;`
        : `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL;`
    );
  }

  return statements;
}

function createMigrationPlanPhases(values?: Partial<MigrationPlanPhases>): MigrationPlanPhases {
  return {
    dropForeignKeys: values?.dropForeignKeys ?? [],
    dropPrimaryUniqueCheckConstraints: values?.dropPrimaryUniqueCheckConstraints ?? [],
    alterColumns: values?.alterColumns ?? [],
    addPrimaryUniqueCheckConstraints: values?.addPrimaryUniqueCheckConstraints ?? [],
    addForeignKeys: values?.addForeignKeys ?? [],
    other: values?.other ?? []
  };
}

function appendMigrationPlanPhases(target: MigrationPlanPhases, source: MigrationPlanPhases, comment: string): void {
  appendPhase(target.dropForeignKeys, source.dropForeignKeys, comment);
  appendPhase(target.dropPrimaryUniqueCheckConstraints, source.dropPrimaryUniqueCheckConstraints, comment);
  appendPhase(target.alterColumns, source.alterColumns, comment);
  appendPhase(target.addPrimaryUniqueCheckConstraints, source.addPrimaryUniqueCheckConstraints, comment);
  appendPhase(target.addForeignKeys, source.addForeignKeys, comment);
  appendPhase(target.other, source.other, comment);
}

function appendPhase(target: string[], statements: readonly string[], comment: string): void {
  if (statements.length === 0) {
    return;
  }

  target.push(comment, ...statements);
}

function formatMigrationPlanPhases(phases: MigrationPlanPhases, wrapTransaction: boolean): string {
  const statements = getMigrationPlanStatements(phases);

  if (statements.length === 0) {
    return '';
  }

  return ensureTrailingNewline([
    ...(wrapTransaction ? ['BEGIN;'] : []),
    ...statements,
    ...(wrapTransaction ? ['COMMIT;'] : [])
  ].join('\n\n'));
}

function getMigrationPlanStatements(phases: MigrationPlanPhases): string[] {
  return [
    ...withPhaseHeader('1. Drop foreign keys', phases.dropForeignKeys),
    ...withPhaseHeader('2. Drop primary/unique/check constraints', phases.dropPrimaryUniqueCheckConstraints),
    ...withPhaseHeader('3. Drop/alter/add columns', phases.alterColumns),
    ...withPhaseHeader('4. Add primary/unique/check constraints', phases.addPrimaryUniqueCheckConstraints),
    ...withPhaseHeader('5. Add foreign keys', phases.addForeignKeys),
    ...withPhaseHeader('Other object changes', phases.other)
  ];
}

function withPhaseHeader(header: string, statements: readonly string[]): string[] {
  return statements.length === 0 ? [] : [`-- ${header}`, ...statements];
}

function getDropConstraintPhase(phases: MigrationPlanPhases, constraint: ParsedConstraint): string[] {
  if (constraint.kind === 'foreignKey') {
    return phases.dropForeignKeys;
  }

  if (constraint.kind === 'primaryUniqueCheck') {
    return phases.dropPrimaryUniqueCheckConstraints;
  }

  return phases.other;
}

function getAddConstraintPhase(phases: MigrationPlanPhases, constraint: ParsedConstraint): string[] {
  if (constraint.kind === 'foreignKey') {
    return phases.addForeignKeys;
  }

  if (constraint.kind === 'primaryUniqueCheck') {
    return phases.addPrimaryUniqueCheckConstraints;
  }

  return phases.other;
}

function createAddConstraintStatements(
  ref: SchemaObjectRef,
  tableName: string,
  constraintName: string,
  constraint: ParsedConstraint,
  localTables?: ReadonlyMap<string, ParsedTableDefinition>
): string[] {
  if (constraint.kind !== 'foreignKey') {
    return [`ALTER TABLE ${tableName} ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${constraint.definition};`];
  }

  const blocker = getForeignKeyBlocker(ref, constraint, localTables);
  if (blocker) {
    return [
      `-- Skipped FK ${tableName}.${quoteIdentifier(constraintName)}: ${blocker}`,
      `-- Review after parent table migration: ALTER TABLE ${tableName} ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${constraint.definition};`
    ];
  }

  return [
    `ALTER TABLE ${tableName} ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${constraint.definition};`
  ];
}

function getForeignKeyBlocker(
  ref: SchemaObjectRef,
  constraint: ParsedConstraint,
  localTables: ReadonlyMap<string, ParsedTableDefinition> | undefined
): string | undefined {
  const reference = constraint.foreignKeyReference;
  if (!reference || !localTables) {
    return undefined;
  }

  const referencedSchema = reference.schema ?? ref.schema;
  const referencedTable = localTables.get(getTableDefinitionKey(referencedSchema, reference.table));

  if (!referencedTable) {
    return undefined;
  }

  const missingColumns = reference.columns.filter((column) => !referencedTable.columns.has(column));
  if (missingColumns.length > 0) {
    return `referenced column(s) ${missingColumns.map(quoteIdentifier).join(', ')} do not exist in local table ${referencedSchema}.${reference.table}`;
  }

  return undefined;
}

function getConstraintKind(definition: string): ParsedConstraintKind {
  const normalized = normalizeSqlFragment(definition);

  if (normalized.startsWith('foreign key')) {
    return 'foreignKey';
  }

  if (
    normalized.startsWith('primary key') ||
    normalized.startsWith('unique') ||
    normalized.startsWith('check')
  ) {
    return 'primaryUniqueCheck';
  }

  return 'other';
}

function stripTransactionWrapper(sql: string): string {
  const lines = sql
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^BEGIN;?$/i.test(line) && !/^COMMIT;?$/i.test(line));

  return lines.join('\n');
}

function parseCreateTableDefinition(sql: string): ParsedTableDefinition {
  const openIndex = sql.indexOf('(');

  if (openIndex === -1) {
    throw new Error('Could not parse CREATE TABLE statement: missing column list.');
  }

  const closeIndex = findMatchingCloseParenthesis(sql, openIndex);
  const body = sql.slice(openIndex + 1, closeIndex);
  const columns = new Map<string, ParsedColumn>();
  const constraints = new Map<string, ParsedConstraint>();

  for (const part of splitTopLevelComma(body)) {
    const raw = part.trim();

    if (!raw) {
      continue;
    }

    if (/^CONSTRAINT\b/i.test(raw)) {
      const constraint = parseConstraintDefinition(raw);
      constraints.set(constraint.name, constraint);
      continue;
    }

    const column = parseColumnDefinition(raw);
    columns.set(column.name, column);
  }

  return { columns, constraints };
}

function parseColumnDefinition(raw: string): ParsedColumn {
  const identifier = readIdentifier(raw);
  const definition = raw.slice(identifier.endIndex).trim();
  const defaultIndex = findTopLevelKeyword(definition, 'DEFAULT');
  const notNullIndex = findTopLevelKeyword(definition, 'NOT NULL');
  const identityAlwaysIndex = findTopLevelKeyword(definition, 'GENERATED ALWAYS AS IDENTITY');
  const identityDefaultIndex = findTopLevelKeyword(definition, 'GENERATED BY DEFAULT AS IDENTITY');
  const identityIndex = minDefined(identityAlwaysIndex, identityDefaultIndex);
  const typeEnd = minDefined(defaultIndex, notNullIndex, identityIndex) ?? definition.length;
  const type = definition.slice(0, typeEnd).trim();

  if (!type) {
    throw new Error(`Could not parse column definition for ${identifier.value}.`);
  }

  const defaultEnd = defaultIndex === undefined
    ? undefined
    : minDefined(
      notNullIndex !== undefined && notNullIndex > defaultIndex ? notNullIndex : undefined,
      identityIndex !== undefined && identityIndex > defaultIndex ? identityIndex : undefined
    ) ?? definition.length;
  const identityEnd = identityIndex === undefined
    ? undefined
    : minDefined(
      defaultIndex !== undefined && defaultIndex > identityIndex ? defaultIndex : undefined,
      notNullIndex !== undefined && notNullIndex > identityIndex ? notNullIndex : undefined
    ) ?? definition.length;

  return {
    name: identifier.value,
    definition,
    type,
    defaultValue: defaultIndex === undefined
      ? undefined
      : definition.slice(defaultIndex + 'DEFAULT'.length, defaultEnd).trim(),
    notNull: notNullIndex !== undefined,
    identity: identityIndex === undefined ? undefined : definition.slice(identityIndex, identityEnd).trim(),
    raw
  };
}

function parseConstraintDefinition(raw: string): ParsedConstraint {
  const withoutKeyword = raw.replace(/^CONSTRAINT\b/i, '').trimStart();
  const identifier = readIdentifier(withoutKeyword);
  const definition = withoutKeyword.slice(identifier.endIndex).trim();

  return {
    name: identifier.value,
    definition,
    kind: getConstraintKind(definition),
    foreignKeyReference: parseForeignKeyReference(definition),
    raw
  };
}

function parseForeignKeyReference(definition: string): ForeignKeyReference | undefined {
  const referencesIndex = findTopLevelKeyword(definition, 'REFERENCES');
  if (referencesIndex === undefined) {
    return undefined;
  }

  const afterReferences = definition.slice(referencesIndex + 'REFERENCES'.length).trimStart();
  const relation = readQualifiedRelationName(afterReferences);
  let rest = afterReferences.slice(relation.endIndex).trimStart();

  if (!rest.startsWith('(')) {
    return { schema: relation.schema, table: relation.table, columns: [] };
  }

  const closeIndex = findMatchingCloseParenthesis(rest, 0);
  const columns = splitTopLevelComma(rest.slice(1, closeIndex))
    .map((column) => readIdentifier(column).value);

  return { schema: relation.schema, table: relation.table, columns };
}

function readQualifiedRelationName(value: string): { readonly schema?: string; readonly table: string; readonly endIndex: number } {
  const firstIdentifier = readIdentifier(value);
  let rest = value.slice(firstIdentifier.endIndex);
  let consumedLength = firstIdentifier.endIndex;

  if (!rest.trimStart().startsWith('.')) {
    return {
      table: firstIdentifier.value,
      endIndex: firstIdentifier.endIndex
    };
  }

  const leadingWhitespaceLength = rest.length - rest.trimStart().length;
  rest = rest.trimStart().slice(1);
  const secondLeadingWhitespaceLength = rest.length - rest.trimStart().length;
  rest = rest.trimStart();
  const secondIdentifier = readIdentifier(rest);
  consumedLength += leadingWhitespaceLength + 1 + secondLeadingWhitespaceLength + secondIdentifier.endIndex;

  return {
    schema: firstIdentifier.value,
    table: secondIdentifier.value,
    endIndex: consumedLength
  };
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let startIndex = 0;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inSingleQuote) {
      if (char === '\'' && next === '\'') {
        index += 1;
      } else if (char === '\'') {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === '\'') {
      inSingleQuote = true;
    } else if (char === '"') {
      inDoubleQuote = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(startIndex, index));
      startIndex = index + 1;
    }
  }

  parts.push(value.slice(startIndex));
  return parts;
}

function findMatchingCloseParenthesis(value: string, openIndex: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inSingleQuote) {
      if (char === '\'' && next === '\'') {
        index += 1;
      } else if (char === '\'') {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === '\'') {
      inSingleQuote = true;
    } else if (char === '"') {
      inDoubleQuote = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error('Could not parse CREATE TABLE statement: unbalanced parentheses.');
}

function readIdentifier(value: string): { readonly value: string; readonly endIndex: number } {
  const trimmedStart = value.search(/\S/);

  if (trimmedStart === -1) {
    throw new Error('Expected SQL identifier.');
  }

  if (value[trimmedStart] === '"') {
    let identifier = '';

    for (let index = trimmedStart + 1; index < value.length; index += 1) {
      const char = value[index];
      const next = value[index + 1];

      if (char === '"' && next === '"') {
        identifier += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        return { value: identifier, endIndex: index + 1 };
      }

      identifier += char;
    }

    throw new Error('Expected closing quote for SQL identifier.');
  }

  const match = /^[^\s,()]+/.exec(value.slice(trimmedStart));

  if (!match) {
    throw new Error('Expected SQL identifier.');
  }

  return {
    value: match[0],
    endIndex: trimmedStart + match[0].length
  };
}

function findTopLevelKeyword(value: string, keyword: string): number | undefined {
  const keywordPattern = new RegExp(`^${keyword.trim().split(/\s+/).join('\\s+')}(?![a-zA-Z0-9_])`, 'i');
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inSingleQuote) {
      if (char === '\'' && next === '\'') {
        index += 1;
      } else if (char === '\'') {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === '\'') {
      inSingleQuote = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      continue;
    }

    if (depth === 0 && !isIdentifierCharacter(value[index - 1] ?? '') && keywordPattern.test(value.slice(index))) {
      return index;
    }
  }

  return undefined;
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

function normalizeSqlFragment(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/;$/, '').trim().toLowerCase();
}

function formatOptionalSqlValue(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? truncateDetail(normalized) : 'none';
}

function truncateDetail(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function getTypeMigrationUsingClause(columnName: string, liveColumn: ParsedColumn, localColumn: ParsedColumn): string {
  if (normalizeTypeName(localColumn.type) !== 'jsonb') {
    return '';
  }

  if (isTextType(liveColumn.type)) {
    return ` USING to_jsonb(${columnName})`;
  }

  return ` USING ${columnName}::jsonb`;
}

function normalizeTypeName(value: string): string {
  return normalizeSqlFragment(value).replace(/\(.+\)$/, '').trim();
}

function isTextType(value: string): boolean {
  const type = normalizeTypeName(value);
  return type === 'character varying' || type === 'varchar' || type === 'character' || type === 'char' || type === 'text';
}

function getQualifiedName(ref: SchemaObjectRef): string {
  return `${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.name)}`;
}

function getTableDefinitionKey(schema: string, table: string): string {
  return `${schema}.${table}`.toLowerCase();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isIdentifierCharacter(value: string): boolean {
  return /[a-zA-Z0-9_]/.test(value);
}

function getStatusOrder(status: SchemaComparisonStatus): number {
  switch (status) {
    case 'modified':
      return 0;
    case 'missingLocal':
      return 1;
    case 'localOnly':
      return 2;
    case 'error':
      return 3;
    case 'same':
      return 4;
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function getEmptyDocumentFileName(ref: SchemaObjectRef, side: 'database' | 'local'): string {
  return `${ref.schema}.${ref.name}.empty-${side}.sql`;
}

function isObjectNotFoundError(error: unknown): boolean {
  return error instanceof Error && /\bwas not found\.$/.test(error.message);
}
