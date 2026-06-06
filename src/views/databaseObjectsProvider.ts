import * as vscode from 'vscode';
import { ExtensionConfig, getExtensionConfig, hasConnectionConfig } from '../config';
import { schemaObjectFolderByKind, schemaObjectKinds, SchemaObjectKind, SchemaObjectRef } from '../model/schemaObject';
import { PostgresSchemaService } from '../services/postgresSchemaService';
import { areDefinitionsEquivalent } from '../services/schemaDiffService';
import { SchemaFileService } from '../services/schemaFileService';

type ObjectComparisonStatus = 'same' | 'modified' | 'missingLocal' | 'localOnly' | 'error';

interface SidebarComparison {
  readonly objects: readonly SchemaObjectRef[];
  readonly statuses: ReadonlyMap<string, ObjectComparisonStatus>;
}

type ConnectionState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'connected';
      readonly objects: readonly SchemaObjectRef[];
      readonly comparisonStatuses: ReadonlyMap<string, ObjectComparisonStatus>;
    }
  | { readonly status: 'failed'; readonly message: string };

type DatabaseTreeNode =
  | { readonly type: 'connection'; readonly config: ExtensionConfig }
  | { readonly type: 'schema'; readonly schema: string; readonly objects: readonly SchemaObjectRef[] }
  | {
      readonly type: 'folder';
      readonly schema: string;
      readonly kind: SchemaObjectKind;
      readonly objects: readonly SchemaObjectRef[];
      readonly comparisonCounts: FolderComparisonCounts;
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

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public getTreeItem(node: DatabaseTreeNode): vscode.TreeItem {
    switch (node.type) {
      case 'connection':
        return createConnectionItem(node.config);
      case 'schema':
        return createSchemaItem(node);
      case 'folder':
        return createFolderItem(node.kind, node.comparisonCounts);
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
    this.changeEmitter.fire(undefined);
  }

  public async refreshKind(kind: SchemaObjectKind): Promise<void> {
    const config = getExtensionConfig();

    if (this.connectionState.status !== 'connected') {
      this.refresh();
      return;
    }

    const currentState = this.connectionState;
    const service = new PostgresSchemaService(config);
    const databaseObjects = (await service.listSchemaObjects()).filter((object) => object.kind === kind);
    const comparison = await this.getSidebarComparison(config, service, databaseObjects, kind);
    const nextStatuses = new Map(currentState.comparisonStatuses);

    for (const object of currentState.objects) {
      if (object.kind === kind) {
        nextStatuses.delete(getObjectKey(object));
      }
    }

    for (const [key, status] of comparison.statuses) {
      nextStatuses.set(key, status);
    }

    this.connectionState = {
      status: 'connected',
      objects: [
        ...currentState.objects.filter((object) => object.kind !== kind),
        ...comparison.objects
      ].sort((left, right) => getObjectKey(left).localeCompare(getObjectKey(right))),
      comparisonStatuses: nextStatuses
    };
    this.changeEmitter.fire(undefined);
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

        const comparison = await this.getSidebarComparison(config, service, objects);

        if (this.connectionCheckId !== checkId) {
          return;
        }

        this.connectionState = {
          status: 'connected',
          objects: comparison.objects,
          comparisonStatuses: comparison.statuses
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

  private getNodeChildren(node: DatabaseTreeNode, config: ExtensionConfig): DatabaseTreeNode[] {
    if (this.connectionState.status !== 'connected') {
      return [];
    }

    if (node.type === 'connection') {
      const schemas = Array.from(new Set(this.connectionState.objects.map((object) => object.schema))).sort();

      if (schemas.length === 0) {
        return [{ type: 'empty', label: 'No user schemas found' }];
      }

      return schemas.map((schema) => ({
        type: 'schema',
        schema,
        objects: this.connectionState.status === 'connected'
          ? this.connectionState.objects.filter((object) => object.schema === schema)
          : []
      }));
    }

    if (node.type === 'schema') {
      return schemaObjectKinds.map((kind) => ({
        type: 'folder',
        schema: node.schema,
        kind,
        objects: node.objects.filter((object) => object.kind === kind),
        comparisonCounts: this.connectionState.status === 'connected'
          ? getFolderComparisonCounts(
            node.objects.filter((object) => object.kind === kind),
            this.connectionState.comparisonStatuses
          )
          : { noDiff: 0, diff: 0 }
      }));
    }

    if (node.type === 'folder') {
      if (node.objects.length === 0) {
        return [{ type: 'empty', label: `No ${schemaObjectFolderByKind[node.kind].toLowerCase()} found` }];
      }

      return node.objects.map((object) => ({
        type: 'object',
        object,
        comparisonStatus: this.connectionState.status === 'connected'
          ? this.connectionState.comparisonStatuses.get(getObjectKey(object))
          : undefined
      }));
    }

    return [];
  }

  private async getSidebarComparison(
    config: ExtensionConfig,
    postgresSchemaService: PostgresSchemaService,
    databaseObjects: readonly SchemaObjectRef[],
    kind?: SchemaObjectKind
  ): Promise<SidebarComparison> {
    if (!config.schemaFolder) {
      return {
        objects: databaseObjects,
        statuses: new Map()
      };
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const statuses = new Map<string, ObjectComparisonStatus>();

    if (!workspaceFolder && !isAbsolutePath(config.schemaFolder)) {
      return {
        objects: databaseObjects,
        statuses
      };
    }

    const schemaFileService = new SchemaFileService(workspaceFolder, config.schemaFolder, 'public');
    const objectsByKey = new Map(databaseObjects.map((object) => [getObjectKey(object), object]));
    const ignoredLocalOnlyObjectKeys = new Set((await postgresSchemaService.listConstraintBackedIndexes()).map(getLocalFileObjectKey));

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

    const localObjects = await schemaFileService.listLocalObjects();

    for (const localObject of localObjects) {
      if (kind && localObject.kind !== kind) {
        continue;
      }

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
}

function createConnectionItem(config: ExtensionConfig): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${config.database} (${config.host}:${config.port})`,
    vscode.TreeItemCollapsibleState.Expanded
  );
  item.description = config.username;
  item.tooltip = `${config.username}@${config.host}:${config.port}/${config.database}`;
  item.iconPath = new vscode.ThemeIcon('database');
  item.contextValue = 'postgresSchemaCompare.connection';

  return item;
}

function createSchemaItem(node: Extract<DatabaseTreeNode, { type: 'schema' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
  item.description = 'schema';
  item.iconPath = new vscode.ThemeIcon('symbol-namespace');
  item.contextValue = 'postgresSchemaCompare.schema';

  return item;
}

function createFolderItem(kind: SchemaObjectKind, counts: FolderComparisonCounts): vscode.TreeItem {
  const item = new vscode.TreeItem(schemaObjectFolderByKind[kind], vscode.TreeItemCollapsibleState.Collapsed);
  item.description = `${counts.noDiff} no diff / ${counts.diff} diff`;
  item.iconPath = new vscode.ThemeIcon(
    getFolderIcon(kind),
    counts.diff > 0 ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined
  );
  item.contextValue = `postgresSchemaCompare.${kind}Folder`;

  return item;
}

function createObjectItem(node: Extract<DatabaseTreeNode, { type: 'object' }>): vscode.TreeItem {
  const object = node.object;
  const item = new vscode.TreeItem(object.name, vscode.TreeItemCollapsibleState.None);
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
