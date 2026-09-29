import * as vscode from 'vscode';
import { removeConnectionConfig } from '../config';

export function registerRemoveConnectionCommand(context: vscode.ExtensionContext, refresh: () => void): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('postgresSchemaCompare.removeConnection', async () => {
      try {
        await removeConnectionConfig();
        refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: Could not remove connection. ${message}`);
      }
    })
  );
}
