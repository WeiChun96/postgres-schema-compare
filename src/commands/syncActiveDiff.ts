import * as vscode from 'vscode';
import { DiffSession, DiffSessionState } from '../services/diffSessionState';
import { ServiceFactory } from '../services/serviceFactory';

export function registerSyncActiveDiffCommands(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState,
  onSynced: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('postgresSchemaCompare.updateFolderFromDatabase', async () => {
      await runSyncCommand('Update folder from live database', async () => {
        const session = getRequiredSession(diffSessionState);
        const diffService = createSessionDiffService(serviceFactory, session);

        if (session.type === 'object') {
          if (session.status === 'localOnly') {
            const confirmed = await confirmDestructiveAction(
              `${session.ref.schema}.${session.ref.name} exists only in the folder. Delete the local file to match the live database?`,
              'Delete Local File'
            );

            if (!confirmed) {
              return;
            }

            const uri = await diffService.deleteLocalObject(session.ref);
            await vscode.window.showInformationMessage(`Deleted local file: ${uri.fsPath}`);
            onSynced();
            return;
          }

          try {
            const uri = await diffService.updateFolderFromDatabase(session.ref);
            await vscode.window.showInformationMessage(`Updated local file: ${uri.fsPath}`);
          } catch (error) {
            if (!isObjectNotFoundError(error)) {
              throw error;
            }

            const confirmed = await confirmDestructiveAction(
              `${session.ref.schema}.${session.ref.name} does not exist in the live database. Delete the local file to match the database?`,
              'Delete Local File'
            );

            if (!confirmed) {
              return;
            }

            const uri = await diffService.deleteLocalObject(session.ref);
            await vscode.window.showInformationMessage(`Deleted local file: ${uri.fsPath}`);
          }
        } else {
          try {
            const uri = await diffService.updateFolderFromDatabaseFile(session.localUri);
            await vscode.window.showInformationMessage(`Updated local file: ${uri.fsPath}`);
          } catch (error) {
            if (!isObjectNotFoundError(error)) {
              throw error;
            }

            const confirmed = await confirmDestructiveAction(
              'This object does not exist in the live database. Delete the local file to match the database?',
              'Delete Local File'
            );

            if (!confirmed) {
              return;
            }

            const uri = await diffService.deleteLocalObjectFile(session.localUri);
            await vscode.window.showInformationMessage(`Deleted local file: ${uri.fsPath}`);
          }
        }

        onSynced();
      });
    }),
    vscode.commands.registerCommand('postgresSchemaCompare.updateDatabaseFromFolder', async () => {
      await runSyncCommand('Update live database from folder', async () => {
        const session = getRequiredSession(diffSessionState);
        const diffService = createSessionDiffService(serviceFactory, session);

        if (session.type === 'object') {
          if (session.status === 'missingLocal') {
            const dropConfirmed = await confirmDestructiveAction(
              `${session.ref.schema}.${session.ref.name} exists only in the live database. Drop it to match the folder?`,
              'Drop Database Object'
            );

            if (!dropConfirmed) {
              return;
            }

            await diffService.dropDatabaseObject(session.ref);
            await vscode.window.showInformationMessage(`Dropped live database object: ${session.ref.schema}.${session.ref.name}`);
            onSynced();
            return;
          }

          const confirmed = await confirmDestructiveAction(getUpdateDatabaseConfirmationMessage(session), 'Update Database');

          if (!confirmed) {
            return;
          }

          try {
            await diffService.updateDatabaseFromFolder(session.ref, session.status !== 'localOnly');
            await vscode.window.showInformationMessage(`Updated live database object: ${session.ref.schema}.${session.ref.name}`);
          } catch (error) {
            if (!(error instanceof vscode.FileSystemError)) {
              throw error;
            }

            const dropConfirmed = await confirmDestructiveAction(
              `${session.ref.schema}.${session.ref.name} has no local file. Drop it from the live database to match the folder?`,
              'Drop Database Object'
            );

            if (!dropConfirmed) {
              return;
            }

            await diffService.dropDatabaseObject(session.ref);
            await vscode.window.showInformationMessage(`Dropped live database object: ${session.ref.schema}.${session.ref.name}`);
          }
        } else {
          const confirmed = await confirmDestructiveAction(
            'Run the local SQL against the live PostgreSQL database?',
            'Update Database'
          );

          if (!confirmed) {
            return;
          }

          await diffService.updateDatabaseFromFolderFile(session.localUri);
          await vscode.window.showInformationMessage('Updated live database from local SQL file.');
        }

        onSynced();
      });
    })
  );
}

function getRequiredSession(diffSessionState: DiffSessionState): DiffSession {
  const session = diffSessionState.getLastDiff();

  if (!session) {
    throw new Error('Open a PostgreSQL schema comparison before syncing.');
  }

  return session;
}

function createSessionDiffService(serviceFactory: ServiceFactory, session: DiffSession) {
  return serviceFactory.createDiffService(session.type === 'file' ? session.localUri : undefined);
}

function getUpdateDatabaseConfirmationMessage(session: DiffSession): string {
  if (session.type === 'object' && session.status === 'modified' && session.ref.kind === 'table') {
    return `Apply the generated table migration plan for ${session.ref.schema}.${session.ref.name} to the live PostgreSQL database?`;
  }

  if (session.type === 'object') {
    return `Run the local SQL for ${session.ref.schema}.${session.ref.name} against the live PostgreSQL database?`;
  }

  return 'Run the local SQL against the live PostgreSQL database?';
}

async function runSyncCommand(title: string, operation: () => Promise<void>): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      },
      operation
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
  }
}

async function confirmDestructiveAction(message: string, action: string): Promise<boolean> {
  const confirmation = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return confirmation === action;
}

function isObjectNotFoundError(error: unknown): boolean {
  return error instanceof Error && /\bwas not found\.$/.test(error.message);
}
