import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionConfig, updateExtensionConfig } from '../config';
import { ServiceFactory } from '../services/serviceFactory';

export function registerExportDatabaseToFolderCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  onExported: () => void,
  outputChannel: vscode.OutputChannel
): void {
  const disposable = vscode.commands.registerCommand(
    'postgresSchemaCompare.exportDatabaseToFolder',
    async (resourceUri?: unknown) => {
      try {
        const confirmation = await vscode.window.showWarningMessage(
          'Write all supported PostgreSQL database objects to the configured schema folder? Existing files for matching objects will be overwritten.',
          { modal: true },
          'Write Files'
        );

        if (confirmation !== 'Write Files') {
          return;
        }

        await ensureExportFolderConfigured();

        outputChannel.clear();
        outputChannel.appendLine(`[${new Date().toISOString()}] Starting database export to configured schema folder.`);

        const diffService = serviceFactory.createDiffService(resourceUri);
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Writing PostgreSQL database schema to folder...',
            cancellable: false
          },
          () => diffService.exportDatabaseToFolder()
        );

        onExported();
        outputChannel.appendLine(
          `[${new Date().toISOString()}] Export finished. Written: ${result.writtenCount}. Failed: ${result.failures.length}.`
        );

        if (result.failures.length > 0) {
          writeExportFailures(outputChannel, result.failures);
          outputChannel.show(true);

          const action = await vscode.window.showWarningMessage(
            `Wrote ${result.writtenCount} schema file(s). ${result.failures.length} object(s) failed.`,
            'Show Failures'
          );

          if (action === 'Show Failures') {
            await showExportFailures(result.failures);
          }

          return;
        }

        await vscode.window.showInformationMessage(`Wrote ${result.writtenCount} schema file(s) to the configured folder.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[${new Date().toISOString()}] Export failed before completion.`);
        outputChannel.appendLine(formatUnknownError(error));
        outputChannel.show(true);
        await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}. See output for details.`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

async function ensureExportFolderConfigured(): Promise<void> {
  const config = getExtensionConfig();

  if (config.schemaFolder && (vscode.workspace.workspaceFolders?.length || path.isAbsolute(config.schemaFolder))) {
    return;
  }

  const selectedFolders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use This Folder',
    title: 'Choose where PostgreSQL schema files should be written'
  });

  const selectedFolder = selectedFolders?.[0];
  if (!selectedFolder) {
    throw new Error('Choose a schema folder before writing database schema files.');
  }

  await updateExtensionConfig({
    ...config,
    schemaFolder: selectedFolder.fsPath
  });
}

function writeExportFailures(
  outputChannel: vscode.OutputChannel,
  failures: readonly { readonly ref: { readonly schema: string; readonly name: string; readonly kind: string; readonly identityArguments?: string }; readonly message: string }[]
): void {
  outputChannel.appendLine('');
  outputChannel.appendLine('Failed objects:');

  for (const failure of failures) {
    const signature = failure.ref.identityArguments ? `(${failure.ref.identityArguments})` : '';
    outputChannel.appendLine(`- ${failure.ref.kind} ${failure.ref.schema}.${failure.ref.name}${signature}`);
    outputChannel.appendLine(`  ${failure.message}`);
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

async function showExportFailures(
  failures: readonly { readonly ref: { readonly schema: string; readonly name: string; readonly kind: string; readonly identityArguments?: string }; readonly message: string }[]
): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language: 'plaintext',
    content: failures
      .map((failure) => {
        const signature = failure.ref.identityArguments ? `(${failure.ref.identityArguments})` : '';
        return `${failure.ref.kind} ${failure.ref.schema}.${failure.ref.name}${signature}\n${failure.message}`;
      })
      .join('\n\n')
  });

  await vscode.window.showTextDocument(document);
}
