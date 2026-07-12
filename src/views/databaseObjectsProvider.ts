import * as vscode from 'vscode';
import { ExtensionConfig, getExtensionConfig, hasConnectionConfig } from '../config';
import { schemaObjectFolderByKind, schemaObjectKinds, SchemaObjectKind, SchemaObjectRef } from '../model/schemaObject';
import { PostgresSchemaService } from '../services/postgresSchemaService';
import { areDefinitionsEquivalent } from '../services/schemaDiffService';
import { SchemaFileService } from '../services/schemaFileService';

type ObjectComparisonStatus = 'same' | 'modified' | 'missingLocal' | 'localOnly' | 'error';

interface SidebarComparison {
  readonly objects: readonly SchemaObjectRef[];
  readonly localOnlySchemas: readonly string[];
  readonly statuses: ReadonlyMap<string, ObjectComparisonStatus>;
  readonly loadedFolders: ReadonlySet<string>;
}

type ConnectionState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'connected';
      readonly objects: readonly SchemaObjectRef[];
      readonly localOnlySchemas: readonly string[];
      readonly comparisonStatuses: ReadonlyMap<string, ObjectComparisonStatus>;
      readonly loadedFolders: ReadonlySet<string>;
    }
  | { readonly status: 'failed'; readonly message: string };

type DatabaseTreeNode =
  | { readonly type: 'connection'; readonly config: ExtensionConfig }
  | { readonly type: 'schema'; readonly schema: string; readonly objects: readonly SchemaObjectRef[]; readonly isLocalOnly: boolean }
  | {
      readonly type: 'folder';
      readonly schema: string;
      readonly kind: SchemaObjectKind;
      readonly objects: readonly SchemaObjectRef[];
      readonly isComparisonLoaded: boolean;
      readonly comparisonCounts?: FolderComparisonCounts;
    }
  | { readonly type: 'object'; readonly object: SchemaObjectRef; readonly comparisonStatus?: ObjectComparisonStatus }
  | { readonly type: 'status'; readonly label: string; readonly iconId: string }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'empty'; readonly label: string };

interface FolderComparisonCounts {
  readonly noDiff: number;
  readonly diff: number;
}

export class DatabaseObjectsProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<DatabaseTreeNode | undefined>();
  private connectionState: ConnectionState = { status: 'idle' };
  private connectionCheckId = 0;
  private readonly schemaNodes = new Map<string, DatabaseTreeNode>();
  private readonly folderNodes = new Map<string, DatabaseTreeNode>();
  private readonly schemaLoadingPromises = new Map<string, Promise<void>>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public getTreeItem(node: DatabaseTreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'connection':
        return createConnectionItem(node.config);
      case 'schema':
        return createSchemaItem(node);
      case 'folder':
        return createFolderItem(node.schema, node.kind, node.isComparisonLoaded, node.comparisonCounts);
      case 'object':
        return createObjectItem(node);
      case 'failed':
        return createFailedConnectionItem(node.message);
      case 'empty':
        return createEmptyItem(node.label);
      case 'status':
        return createStatusItem(node.label, node.iconId);
    }
  }

  public getChildren(node?: DatabaseTreeNode): vscode.ProviderResult<DatabaseTreeNode[]> {
    const config = getExtensionConfig();

    if (node) {
      return this.getNodeChildren(node, config);
    }

    if (!hasConnectionConfig(config)) {
      this.connectionState = { status: 'idle' };
      return [];
    }

    if (this.connectionState.status === 'idle') {
      this.startConnectionCheck(config);
      return [{ type: 'status', label: 'Connecting to database...', iconId: 'sync~spin' }];
    }

    if (this.connectionState.status === 'connecting') {
      return [{ type: 'status', label: 'Connecting to database...', iconId: 'sync~spin' }];
    }

    if (this.connectionState.status === 'failed') {
      return [{ type: 'failed', message: this.connectionState.message }];
    }

    return [{ type: 'connection', config }];
  }

  public refresh(): void {
    this.connectionState = { status: 'idle' };
    this.schemaNodes.clear();
    this.folderNodes.clear();
    this.schemaLoadingPromises.clear();
    this.changeEmitter.fire(undefined);
  }

  public async refreshKind(kind: SchemaObjectKind): Promise<void> {
    const config = getExtensionConfig();

    if (this.connectionState.status !== 'connected') {
      this.refresh();
      return;
    }

    const schemas = Array.from(this.folderNodes.keys())
      .filter((key) => key.endsWith(`:${kind}`))
      .map((key) => key.slice(0, -kind.length - 1));

    for (const schema of schemas) {
      await this.refreshFolder(schema, kind);
    }
  }

  public async refreshObject(ref: SchemaObjectRef): Promise<void> {
    await this.refreshFolder(ref.schema, ref.kind);
  }

  public async refreshFolder(schema: string, kind: SchemaObjectKind): Promise<void> {
    const config = getExtensionConfig();

    if (this.connectionState.status !== 'connected') {
      this.refresh();
      return;
    }

    const currentState = this.connectionState;
    const service = new PostgresSchemaService(config);
    const databaseObjects = (await service.listSchemaObjects()).filter((object) => object.schema === schema && object.kind === kind);
    const nextStatuses = new Map(currentState.comparisonStatuses);
    const nextObjectsByKey = new Map(currentState.objects.map((object) => [getObjectKey(object), object]));

    for (const object of currentState.objects) {
      if (object.schema === schema && object.kind === kind) {
        nextStatuses.delete(getObjectKey(object));
        nextObjectsByKey.delete(getObjectKey(object));
      }
    }

    if (currentState.loadedFolders.has(getFolderKey(schema, kind))) {
      const comparison = await this.getFolderComparison(config, service, databaseObjects, schema, kind);

      for (const object of comparison.objects) {
        nextObjectsByKey.set(getObjectKey(object), object);
      }

      for (const [key, status] of comparison.statuses) {
        nextStatuses.set(key, status);
      }
    } else {
      for (const object of databaseObjects) {
        nextObjectsByKey.set(getObjectKey(object), object);
      }
    }

    this.connectionState = {
      status: 'connected',
      objects: Array.from(nextObjectsByKey.values()).sort((left, right) => getObjectKey(left).localeCompare(getObjectKey(right))),
      localOnlySchemas: currentState.localOnlySchemas,
      comparisonStatuses: nextStatuses,
      loadedFolders: currentState.loadedFolders
    };
    this.fireChangedFolder(schema, kind);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private startConnectionCheck(config: ReturnType<typeof getExtensionConfig>): void {
    const checkId = this.connectionCheckId + 1;
    this.connectionCheckId = checkId;
    this.connectionState = { status: 'connecting' };

    const service = new PostgresSchemaService(config);

    void service
      .testConnection()
      .then(() => service.listSchemaObjects())
      .then(async (objects) => {
        if (this.connectionCheckId !== checkId) {
          return;
        }

        const comparison = await this.getInitialSidebarComparison(config, service, objects);

        if (this.connectionCheckId !== checkId) {
          return;
        }

        this.connectionState = {
          status: 'connected',
          objects: comparison.objects,
          localOnlySchemas: comparison.localOnlySchemas,
          comparisonStatuses: comparison.statuses,
          loadedFolders: comparison.loadedFolders
        };
        this.changeEmitter.fire(undefined);
      })
      .catch((error: unknown) => {
        if (this.connectionCheckId !== checkId) {
          return;
        }

        this.connectionState = {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error)
        };
        this.changeEmitter.fire(undefined);
      });
  }

  private getNodeChildren(node: DatabaseTreeNode, config: ExtensionConfig): vscode.ProviderResult<DatabaseTreeNode[]> {
    if (this.connectionState.status !== 'connected') {
      return [];
    }

    if (node.type === 'connection') {
      const localOnlySchemas = new Set(this.connectionState.localOnlySchemas);
      const schemas = Array.from(new Set([
        ...this.connectionState.objects.map((object) => object.schema),
        ...localOnlySchemas
      ])).sort();

      if (schemas.length === 0) {
        return [{ type: 'empty', label: 'No user schemas found' }];
      }

      return schemas.map((schema) => this.getSchemaNode(schema, localOnlySchemas.has(schema)));
    }

    if (node.type === 'schema') {
      return this.getSchemaChildren(node, config);
    }

    if (node.type === 'folder') {
      return this.getFolderChildren(node, config);
    }

    return [];
  }

  private async getSchemaChildren(
    node: Extract<DatabaseTreeNode, { type: 'schema' }>,
    config: ExtensionConfig
  ): Promise<DatabaseTreeNode[]> {
    await this.ensureSchemaComparisonLoaded(node.schema, config);

    if (this.connectionState.status !== 'connected') {
      return [];
    }

    return schemaObjectKinds.map((kind) => this.getFolderNode(node.schema, kind));
  }

  private ensureSchemaComparisonLoaded(schema: string, config: ExtensionConfig): Promise<void> {
    const existingLoad = this.schemaLoadingPromises.get(schema);

    if (existingLoad) {
      return existingLoad;
    }

    const load = this.loadSchemaComparisons(schema, config).finally(() => {
      if (this.schemaLoadingPromises.get(schema) === load) {
        this.schemaLoadingPromises.delete(schema);
      }
    });
    this.schemaLoadingPromises.set(schema, load);
    return load;
  }

  private async loadSchemaComparisons(schema: string, config: ExtensionConfig): Promise<void> {
    if (this.connectionState.status !== 'connected') {
      return;
    }

    const currentState = this.connectionState;
    const unloadedKinds = schemaObjectKinds.filter(
      (kind) => !currentState.loadedFolders.has(getFolderKey(schema, kind))
    );

    if (unloadedKinds.length === 0) {
      return;
    }

    const service = new PostgresSchemaService(config);
    const comparisons = await Promise.all(
      unloadedKinds.map(async (kind) => ({
        kind,
        comparison: await this.getFolderComparison(
          config,
          service,
          currentState.objects.filter((object) => object.schema === schema && object.kind === kind),
          schema,
          kind
        )
      }))
    );

    if (this.connectionState !== currentState) {
      return;
    }

    const nextObjectsByKey = new Map(currentState.objects.map((object) => [getObjectKey(object), object]));
    const nextStatuses = new Map(currentState.comparisonStatuses);

    for (const { kind, comparison } of comparisons) {
      for (const object of currentState.objects) {
        if (object.schema === schema && object.kind === kind) {
          nextObjectsByKey.delete(getObjectKey(object));
          nextStatuses.delete(getObjectKey(object));
        }
      }

      for (const object of comparison.objects) {
        nextObjectsByKey.set(getObjectKey(object), object);
      }

      for (const [key, status] of comparison.statuses) {
        nextStatuses.set(key, status);
      }
    }

    this.connectionState = {
      status: 'connected',
      objects: Array.from(nextObjectsByKey.values()).sort((left, right) => getObjectKey(left).localeCompare(getObjectKey(right))),
      localOnlySchemas: currentState.localOnlySchemas,
      comparisonStatuses: nextStatuses,
      loadedFolders: new Set([
        ...currentState.loadedFolders,
        ...unloadedKinds.map((kind) => getFolderKey(schema, kind))
      ])
    };
    this.changeEmitter.fire(this.schemaNodes.get(schema));
  }

  private async getFolderChildren(
    node: Extract<DatabaseTreeNode, { type: 'folder' }>,
    config: ExtensionConfig
  ): Promise<DatabaseTreeNode[]> {
    if (this.connectionState.status !== 'connected') {
      return [];
    }

    await this.ensureFolderComparisonLoaded(node, config);

    if (this.connectionState.status !== 'connected') {
      return [];
    }

    const objects = this.getFolderObjects(node.schema, node.kind);

    if (objects.length === 0) {
      return [{ type: 'empty', label: `No ${schemaObjectFolderByKind[node.kind].toLowerCase()} found` }];
    }

    return objects.map((object) => ({
      type: 'object',
      object,
      comparisonStatus: this.connectionState.status === 'connected'
        ? this.connectionState.comparisonStatuses.get(getObjectKey(object))
        : undefined
    }));
  }

  private async getInitialSidebarComparison(
    config: ExtensionConfig,
    postgresSchemaService: PostgresSchemaService,
    databaseObjects: readonly SchemaObjectRef[]
  ): Promise<SidebarComparison> {
    if (!config.schemaFolder) {
      return {
        objects: databaseObjects,
        localOnlySchemas: [],
        statuses: new Map(),
        loadedFolders: new Set()
      };
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const statuses = new Map<string, ObjectComparisonStatus>();

    if (!workspaceFolder && !isAbsolutePath(config.schemaFolder)) {
      return {
        objects: databaseObjects,
        localOnlySchemas: [],
        statuses,
        loadedFolders: new Set()
      };
    }

    const schemaFileService = new SchemaFileService(workspaceFolder, config.schemaFolder, 'public');
    const databaseSchemas = new Set(await postgresSchemaService.listSchemas());
    const localSchemas = await schemaFileService.listLocalSchemas();
    const localOnlySchemas = localSchemas.filter((schema) => !databaseSchemas.has(schema));

    return {
      objects: databaseObjects,
      localOnlySchemas,
      statuses,
      loadedFolders: new Set()
    };
  }

  private async ensureFolderComparisonLoaded(
    node: Extract<DatabaseTreeNode, { type: 'folder' }>,
    config: ExtensionConfig
  ): Promise<void> {
    if (this.connectionState.status !== 'connected' || this.connectionState.loadedFolders.has(getFolderKey(node.schema, node.kind))) {
      return;
    }

    const currentState = this.connectionState;
    const service = new PostgresSchemaService(config);
    const databaseObjects = currentState.objects.filter((object) => object.schema === node.schema && object.kind === node.kind);
    const comparison = await this.getFolderComparison(config, service, databaseObjects, node.schema, node.kind);
    const nextObjectsByKey = new Map(currentState.objects.map((object) => [getObjectKey(object), object]));
    const nextStatuses = new Map(currentState.comparisonStatuses);

    for (const object of currentState.objects) {
      if (object.schema === node.schema && object.kind === node.kind) {
        nextObjectsByKey.delete(getObjectKey(object));
        nextStatuses.delete(getObjectKey(object));
      }
    }

    for (const object of comparison.objects) {
      nextObjectsByKey.set(getObjectKey(object), object);
    }

    for (const [key, status] of comparison.statuses) {
      nextStatuses.set(key, status);
    }

    this.connectionState = {
      status: 'connected',
      objects: Array.from(nextObjectsByKey.values()).sort((left, right) => getObjectKey(left).localeCompare(getObjectKey(right))),
      localOnlySchemas: currentState.localOnlySchemas,
      comparisonStatuses: nextStatuses,
      loadedFolders: new Set([...currentState.loadedFolders, getFolderKey(node.schema, node.kind)])
    };
    this.fireChangedFolder(node.schema, node.kind);
  }

  private async getFolderComparison(
    config: ExtensionConfig,
    postgresSchemaService: PostgresSchemaService,
    databaseObjects: readonly SchemaObjectRef[],
    schema: string,
    kind: SchemaObjectKind
  ): Promise<Pick<SidebarComparison, 'objects' | 'statuses'>> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const statuses = new Map<string, ObjectComparisonStatus>();

    if (!config.schemaFolder || (!workspaceFolder && !isAbsolutePath(config.schemaFolder))) {
      return {
        objects: databaseObjects,
        statuses
      };
    }

    const schemaFileService = new SchemaFileService(workspaceFolder, config.schemaFolder, 'public');
    const objectsByKey = new Map(databaseObjects.map((object) => [getObjectKey(object), object]));
    const ignoredLocalOnlyObjectKeys = kind === 'index'
      ? new Set((await postgresSchemaService.listConstraintBackedIndexes()).map(getLocalFileObjectKey))
      : new Set<string>();

    for (const object of databaseObjects) {
      try {
        const localUri = schemaFileService.getLocalObjectUri(object);
        const localSql = await schemaFileService.tryReadLocalFile(localUri);

        if (localSql === undefined) {
          statuses.set(getObjectKey(object), 'missingLocal');
          continue;
        }

        const liveDefinition = await postgresSchemaService.getObjectDefinition(object);
        statuses.set(
          getObjectKey(object),
          areDefinitionsEquivalent(object, liveDefinition.ddl, localSql) ? 'same' : 'modified'
        );
      } catch {
        statuses.set(getObjectKey(object), 'error');
      }
    }

    for (const localObject of await schemaFileService.listLocalObjectsInFolder(schema, kind)) {
      const key = getObjectKey(localObject);

      if (ignoredLocalOnlyObjectKeys.has(getLocalFileObjectKey(localObject))) {
        continue;
      }

      if (!objectsByKey.has(key)) {
        objectsByKey.set(key, localObject);
        statuses.set(key, 'localOnly');
      }
    }

    return {
      objects: Array.from(objectsByKey.values()).sort((left, right) => getObjectKey(left).localeCompare(getObjectKey(right))),
      statuses
    };
  }

  private getSchemaNode(schema: string, isLocalOnly: boolean): DatabaseTreeNode {
    const node: DatabaseTreeNode = {
      type: 'schema',
      schema,
      isLocalOnly,
      objects: this.connectionState.status === 'connected'
        ? this.connectionState.objects.filter((object) => object.schema === schema)
        : []
    };
    this.schemaNodes.set(schema, node);
    return node;
  }

  private getFolderNode(schema: string, kind: SchemaObjectKind): DatabaseTreeNode {
    const objects = this.getFolderObjects(schema, kind);
    const isComparisonLoaded = this.connectionState.status === 'connected' && this.connectionState.loadedFolders.has(getFolderKey(schema, kind));
    const node: Extract<DatabaseTreeNode, { type: 'folder' }> = {
      type: 'folder',
      schema,
      kind,
      objects,
      isComparisonLoaded,
      comparisonCounts: isComparisonLoaded
        ? getFolderComparisonCounts(objects, this.connectionState.status === 'connected' ? this.connectionState.comparisonStatuses : new Map())
        : undefined
    };

    return this.rememberFolderNode(node);
  }

  private rememberFolderNode(node: Extract<DatabaseTreeNode, { type: 'folder' }>): DatabaseTreeNode {
    this.folderNodes.set(getFolderKey(node.schema, node.kind), node);
    return node;
  }

  private getFolderObjects(schema: string, kind: SchemaObjectKind): readonly SchemaObjectRef[] {
    return this.connectionState.status === 'connected'
      ? this.connectionState.objects.filter((object) => object.schema === schema && object.kind === kind)
      : [];
  }

  private fireChangedFolder(schema: string, kind: SchemaObjectKind): void {
    const schemaNode = this.schemaNodes.get(schema);

    if (schemaNode) {
      this.changeEmitter.fire(schemaNode);
      return;
    }

    this.changeEmitter.fire(undefined);
  }
}

function createConnectionItem(config: ExtensionConfig): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${config.database} (${config.host}:${config.port})`,
    vscode.TreeItemCollapsibleState.Expanded
  );
  item.id = `connection:${config.host}:${config.port}:${config.database}:${config.username}`;
  item.description = config.username;
  item.tooltip = `${config.username}@${config.host}:${config.port}/${config.database}`;
  item.iconPath = new vscode.ThemeIcon('database');
  item.contextValue = 'postgresSchemaCompare.connection';

  return item;
}

function createSchemaItem(node: Extract<DatabaseTreeNode, { type: 'schema' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `schema:${node.schema}`;
  item.description = node.isLocalOnly ? 'schema - local only' : 'schema';
  item.tooltip = node.isLocalOnly
    ? `${node.schema} exists in the local schema folder but not in the live database.`
    : `${node.schema} schema`;
  item.iconPath = new vscode.ThemeIcon(
    'symbol-namespace',
    node.isLocalOnly ? new vscode.ThemeColor('charts.yellow') : undefined
  );
  item.contextValue = 'postgresSchemaCompare.schema';

  return item;
}

function createFolderItem(
  schema: string,
  kind: SchemaObjectKind,
  isComparisonLoaded: boolean,
  counts: FolderComparisonCounts | undefined
): vscode.TreeItem {
  const item = new vscode.TreeItem(schemaObjectFolderByKind[kind], vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `folder:${schema}:${kind}`;
  item.description = isComparisonLoaded && counts
    ? `${counts.noDiff} no diff / ${counts.diff} diff`
    : 'not loaded';
  item.iconPath = new vscode.ThemeIcon(
    getFolderIcon(kind),
    counts && counts.diff > 0 ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined
  );
  item.contextValue = `postgresSchemaCompare.${kind}Folder`;

  return item;
}

function createObjectItem(node: Extract<DatabaseTreeNode, { type: 'object' }>): vscode.TreeItem {
  const object = node.object;
  const item = new vscode.TreeItem(object.name, vscode.TreeItemCollapsibleState.None);
  item.id = getObjectKey(object);
  item.description = getObjectDescription(object, node.comparisonStatus);
  item.tooltip = `${object.schema}.${object.name}${object.identityArguments ? ` (${object.identityArguments})` : ''}${node.comparisonStatus ? ` - ${getComparisonLabel(node.comparisonStatus)}` : ''}`;
  item.iconPath = new vscode.ThemeIcon(getObjectIcon(object.kind), getComparisonThemeColor(node.comparisonStatus));
  item.contextValue = `postgresSchemaCompare.${object.kind}`;
  item.command = {
    command: 'postgresSchemaCompare.compareDatabaseObjectWithFolder',
    title: 'Compare with Live Database',
    arguments: [{ object, comparisonStatus: node.comparisonStatus }]
  };

  return item;
}

function createStatusItem(label: string, iconId: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(iconId);
  item.contextValue = 'postgresSchemaCompare.status';

  return item;
}

function createEmptyItem(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  item.contextValue = 'postgresSchemaCompare.empty';

  return item;
}

function getFolderIcon(kind: SchemaObjectKind): string {
  switch (kind) {
    case 'table':
      return 'table';
    case 'view':
      return 'preview';
    case 'materializedView':
      return 'preview';
    case 'index':
      return 'symbol-key';
    case 'function':
      return 'symbol-method';
    case 'procedure':
      return 'symbol-method';
    case 'sequence':
      return 'list-ordered';
    case 'trigger':
      return 'zap';
    case 'type':
      return 'symbol-class';
  }
}

function getObjectIcon(kind: SchemaObjectKind): string {
  switch (kind) {
    case 'table':
      return 'table';
    case 'view':
      return 'eye';
    case 'materializedView':
      return 'preview';
    case 'index':
      return 'symbol-key';
    case 'function':
      return 'symbol-method';
    case 'procedure':
      return 'symbol-method';
    case 'sequence':
      return 'symbol-number';
    case 'trigger':
      return 'zap';
    case 'type':
      return 'symbol-class';
  }
}

function getObjectKey(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}:${ref.identityArguments ?? ''}`;
}

function getFolderKey(schema: string, kind: SchemaObjectKind): string {
  return `${schema}:${kind}`;
}

function getLocalFileObjectKey(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}`;
}

function getFolderComparisonCounts(
  objects: readonly SchemaObjectRef[],
  statuses: ReadonlyMap<string, ObjectComparisonStatus>
): FolderComparisonCounts {
  let diff = 0;

  for (const object of objects) {
    const status = statuses.get(getObjectKey(object));

    if (status && status !== 'same') {
      diff += 1;
    }
  }

  return {
    noDiff: objects.length - diff,
    diff
  };
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

function getObjectDescription(ref: SchemaObjectRef, status: ObjectComparisonStatus | undefined): string {
  if (!status || status === 'same') {
    return ref.kind;
  }

  return `${ref.kind} - ${getComparisonLabel(status)}`;
}

function getComparisonLabel(status: ObjectComparisonStatus): string {
  switch (status) {
    case 'same':
      return 'same';
    case 'modified':
      return 'modified';
    case 'missingLocal':
      return 'missing local';
    case 'localOnly':
      return 'local only';
    case 'error':
      return 'compare error';
  }
}

function getComparisonThemeColor(status: ObjectComparisonStatus | undefined): vscode.ThemeColor | undefined {
  switch (status) {
    case 'modified':
      return new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
    case 'missingLocal':
      return new vscode.ThemeColor('gitDecoration.untrackedResourceForeground');
    case 'localOnly':
      return new vscode.ThemeColor('charts.yellow');
    case 'error':
      return new vscode.ThemeColor('errorForeground');
    default:
      return undefined;
  }
}

function createFailedConnectionItem(message: string): vscode.TreeItem {
  const item = new vscode.TreeItem('Connection failed. Configure database settings.', vscode.TreeItemCollapsibleState.None);
  item.description = message;
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon('error');
  item.contextValue = 'postgresSchemaCompare.connectionFailed';
  item.command = {
    command: 'postgresSchemaCompare.openConnectionSettings',
    title: 'Configure Connection'
  };

  return item;
}
