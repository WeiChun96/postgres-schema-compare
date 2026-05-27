import * as vscode from 'vscode';
import { DiffDirection } from '../services/schemaDiffService';
import { DiffSessionState } from '../services/diffSessionState';
import { ServiceFactory } from '../services/serviceFactory';

export function registerSwapDiffDirectionCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState
): void {
  const disposable = vscode.commands.registerCommand(
    'postgresSchemaCompare.swapDiffDirection',
    async (resourceUri?: vscode.Uri) => {
      try {
        const session = diffSessionState.getLastDiff();
        const nextDirection: DiffDirection = session
          ? session.direction === 'databaseToLocal' ? 'localToDatabase' : 'databaseToLocal'
          : 'localToDatabase';

        if (session?.type === 'object') {
          const diffService = serviceFactory.createDiffService();
          const preparedDiff = await diffService.prepareObjectDiff(session.ref, nextDirection);

          diffSessionState.setLastDiff({ ...session, direction: nextDirection });
          await vscode.commands.executeCommand(
            'vscode.diff',
            preparedDiff.leftUri,
            preparedDiff.rightUri,
            preparedDiff.title
          );
          return;
        }

        const localUri = session?.localUri ?? resourceUri ?? vscode.window.activeTextEditor?.document.uri;

        if (!localUri) {
          throw new Error('Open or select a local SQL file before swapping direction.');
        }

        const diffService = serviceFactory.createDiffService(localUri);
        const preparedDiff = await diffService.prepareDiff(localUri, nextDirection);

        diffSessionState.setLastDiff({ type: 'file', localUri, direction: nextDirection });

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
