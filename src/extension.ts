import * as vscode from 'vscode';
import { registerCompareDatabaseObjectWithFolderCommand } from './commands/compareDatabaseObjectWithFolder';
import { registerCompareFileWithDatabaseCommand } from './commands/compareFileWithDatabase';
import { registerCompareFolderWithDatabaseCommand } from './commands/compareFolderWithDatabase';
import { registerExportDatabaseToFolderCommand } from './commands/exportDatabaseToFolder';
import { registerOpenConnectionSettingsCommand } from './commands/openConnectionSettings';
import { registerRevealObjectInExplorerCommand } from './commands/revealObjectInExplorer';
import { registerSwapDiffDirectionCommand } from './commands/swapDiffDirection';
import { registerSyncActiveDiffCommands } from './commands/syncActiveDiff';
import { hasConnectionConfig } from './config';
import { schemaObjectFolderByKind, schemaObjectKinds, SchemaObjectKind } from './model/schemaObject';
import { DiffSessionState } from './services/diffSessionState';
import { LiveSchemaDocumentProvider } from './services/schemaDiffService';
import { ServiceFactory } from './services/serviceFactory';
import { DatabaseObjectsProvider } from './views/databaseObjectsProvider';

export function activate(context: vscode.ExtensionContext): void {
  const liveDocumentProvider = new LiveSchemaDocumentProvider();
  const serviceFactory = new ServiceFactory(liveDocumentProvider);
  const databaseObjectsProvider = new DatabaseObjectsProvider();
  const outputChannel = vscode.window.createOutputChannel('PostgreSQL Schema Compare');
  const diffSessionState = new DiffSessionState();

  context.subscriptions.push(
    outputChannel,
    liveDocumentProvider,
    databaseObjectsProvider,
    vscode.workspace.registerTextDocumentContentProvider('postgres-schema', liveDocumentProvider),
    vscode.window.registerTreeDataProvider('postgresSchemaCompare.objects', databaseObjectsProvider)
  );

  updateConnectionContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('postgresSchemaCompare')) {
        updateConnectionContext();
        databaseObjectsProvider.refresh();
      }
    })
  );

  registerOpenConnectionSettingsCommand(context);
  registerCompareFileWithDatabaseCommand(context, serviceFactory, diffSessionState);
  registerSwapDiffDirectionCommand(context, serviceFactory, diffSessionState);
  registerSyncActiveDiffCommands(
    context,
    serviceFactory,
    diffSessionState,
    (ref) => ref ? databaseObjectsProvider.refreshObject(ref) : databaseObjectsProvider.refresh()
  );
  registerCompareFolderWithDatabaseCommand(context, serviceFactory, diffSessionState, (ref) => databaseObjectsProvider.refreshObject(ref));
  registerCompareDatabaseObjectWithFolderCommand(context, serviceFactory, diffSessionState);
  registerExportDatabaseToFolderCommand(context, serviceFactory, () => databaseObjectsProvider.refresh(), outputChannel);
  registerRevealObjectInExplorerCommand(context, serviceFactory);
  registerRefreshObjectFromDatabaseCommand(context, () => databaseObjectsProvider.refresh());
  registerRefreshObjectKindFromDatabaseCommand(context, databaseObjectsProvider);
  registerNotYetImplementedCommand(context, 'postgresSchemaCompare.deployFileToDatabase');
}

export function deactivate(): void {}

function registerNotYetImplementedCommand(context: vscode.ExtensionContext, command: string): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, async () => {
      await vscode.window.showInformationMessage('This command is scaffolded and will be implemented next.');
    })
  );
}

function registerRefreshObjectFromDatabaseCommand(context: vscode.ExtensionContext, refresh: () => void): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('postgresSchemaCompare.refreshObjectFromDatabase', () => {
      refresh();
    })
  );
}

function registerRefreshObjectKindFromDatabaseCommand(
  context: vscode.ExtensionContext,
  databaseObjectsProvider: DatabaseObjectsProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'postgresSchemaCompare.refreshObjectKindFromDatabase',
      async (input?: SchemaObjectKind | { readonly kind?: SchemaObjectKind; readonly schema?: string }) => {
        try {
          const kind = resolveSchemaObjectKind(input);

          if (!kind) {
            throw new Error('Select a supported PostgreSQL object folder to refresh.');
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Refreshing ${schemaObjectFolderByKind[kind].toLowerCase()}${typeof input === 'object' && input.schema ? ` in ${input.schema}` : ''} from live database...`,
              cancellable: false
            },
            () => typeof input === 'object' && input.schema
              ? databaseObjectsProvider.refreshFolder(input.schema, kind)
              : databaseObjectsProvider.refreshKind(kind)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
        }
      }
    )
  );
}

function resolveSchemaObjectKind(
  input: SchemaObjectKind | { readonly kind?: SchemaObjectKind; readonly schema?: string } | undefined
): SchemaObjectKind | undefined {
  if (typeof input === 'string' && schemaObjectKinds.includes(input)) {
    return input;
  }

  if (input && typeof input === 'object' && input.kind && schemaObjectKinds.includes(input.kind)) {
    return input.kind;
  }

  return undefined;
}

function updateConnectionContext(): void {
  void vscode.commands.executeCommand(
    'setContext',
    'postgresSchemaCompare.hasConnection',
    hasConnectionConfig()
  );
}
