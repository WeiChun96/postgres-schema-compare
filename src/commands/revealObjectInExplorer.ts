import * as path from 'path';
import * as vscode from 'vscode';
import { SchemaObjectKind, SchemaObjectRef } from '../model/schemaObject';
import { ServiceFactory } from '../services/serviceFactory';

type RevealInput =
  | SchemaObjectRef
  | { readonly type: 'connection' }
  | { readonly type: 'schema'; readonly schema: string }
  | { readonly type: 'folder'; readonly schema: string; readonly kind: SchemaObjectKind }
  | { readonly type: 'object'; readonly object: SchemaObjectRef }
  | { readonly object?: SchemaObjectRef };

export function registerRevealObjectInExplorerCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('postgresSchemaCompare.revealObjectInExplorer', async (input?: RevealInput) => {
      try {
        const diffService = serviceFactory.createDiffService();
        const targetUri = resolveRevealTargetUri(diffService, input);

        try {
          await vscode.workspace.fs.stat(targetUri);
        } catch (error) {
          if (error instanceof vscode.FileSystemError) {
            await vscode.window.showWarningMessage(`Local folder does not exist: ${targetUri.fsPath}`);
            return;
          }

          throw error;
        }

        await vscode.env.openExternal(targetUri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
      }
    })
  );
}

function resolveRevealTargetUri(
  diffService: ReturnType<ServiceFactory['createDiffService']>,
  input: RevealInput | undefined
): vscode.Uri {
  if (!input) {
    throw new Error('Select a database object explorer item to reveal.');
  }

  if ('type' in input) {
    switch (input.type) {
      case 'connection':
        return diffService.getSchemaRootUri();
      case 'schema':
        return diffService.getLocalSchemaUri(input.schema);
      case 'folder':
        return diffService.getLocalObjectKindFolderUri(input.schema, input.kind);
      case 'object':
        return vscode.Uri.file(path.dirname(diffService.getLocalObjectUri(input.object).fsPath));
    }
  }

  if ('kind' in input && 'schema' in input && 'name' in input) {
    return vscode.Uri.file(path.dirname(diffService.getLocalObjectUri(input).fsPath));
  }

  if (input.object) {
    return vscode.Uri.file(path.dirname(diffService.getLocalObjectUri(input.object).fsPath));
  }

  throw new Error('Select a database object explorer item to reveal.');
}
