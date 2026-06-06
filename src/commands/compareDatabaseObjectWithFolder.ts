import * as vscode from 'vscode';
import { SchemaObjectRef } from '../model/schemaObject';
import { DiffSessionState } from '../services/diffSessionState';
import { SchemaComparisonStatus } from '../services/schemaDiffService';
import { ServiceFactory } from '../services/serviceFactory';

type CompareObjectInput = SchemaObjectRef | {
  readonly object?: SchemaObjectRef;
  readonly comparisonStatus?: SchemaComparisonStatus;
};

export function registerCompareDatabaseObjectWithFolderCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState
): void {
  const disposable = vscode.commands.registerCommand(
    'postgresSchemaCompare.compareDatabaseObjectWithFolder',
    async (input?: CompareObjectInput) => {
      try {
        const ref = resolveSchemaObjectRef(input);

        if (!ref) {
          throw new Error('Select a database object to compare.');
        }

        const diffService = serviceFactory.createDiffService();
        const comparison = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Comparing ${ref.schema}.${ref.name} with schema folder...`,
            cancellable: false
          },
          () => diffService.compareObjectWithDatabase(ref)
        );

        if (comparison.status === 'error') {
          throw new Error(comparison.message ?? 'Could not compare this object.');
        }

        const preparedDiff = await diffService.prepareComparisonDiff(comparison);

        diffSessionState.setLastDiff({
          type: 'object',
          ref,
          direction: 'databaseToLocal',
          status: comparison.status
        });
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

function resolveSchemaObjectRef(input: CompareObjectInput | undefined): SchemaObjectRef | undefined {
  if (!input) {
    return undefined;
  }

  if ('kind' in input && 'schema' in input && 'name' in input) {
    return input;
  }

  return input.object;
}
