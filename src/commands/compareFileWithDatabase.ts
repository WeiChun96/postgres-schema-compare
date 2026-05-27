import * as vscode from 'vscode';
import { DiffDirection } from '../services/schemaDiffService';
import { DiffSessionState } from '../services/diffSessionState';
import { ServiceFactory } from '../services/serviceFactory';

export function registerCompareFileWithDatabaseCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState
): void {
  const disposable = vscode.commands.registerCommand(
    'postgresSchemaCompare.compareFileWithDatabase',
    async (resourceUri?: vscode.Uri, direction: DiffDirection = 'databaseToLocal') => {
      try {
        const localUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
        if (!localUri) {
          throw new Error('Open or select a local SQL file to compare.');
        }

        const diffService = serviceFactory.createDiffService(localUri);
        const preparedDiff = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Loading live PostgreSQL definition...',
            cancellable: false
          },
          () => diffService.prepareDiff(localUri, direction)
        );

        diffSessionState.setLastDiff({ type: 'file', localUri, direction });
        await vscode.commands.executeCommand('setContext', 'postgresSchemaCompare.hasActiveFileDiff', true);
        await vscode.commands.executeCommand('setContext', 'postgresSchemaCompare.hasActiveDiff', true);
        await vscode.commands.executeCommand(
          'vscode.diff',
          preparedDiff.leftUri,
          preparedDiff.rightUri,
          preparedDiff.title
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}
