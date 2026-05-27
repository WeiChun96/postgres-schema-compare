import * as vscode from 'vscode';
import { getExtensionConfig } from '../config';
import { PostgresSchemaService } from './postgresSchemaService';
import { LiveSchemaDocumentProvider, SchemaDiffService } from './schemaDiffService';
import { SchemaFileService } from './schemaFileService';

export class ServiceFactory {
  public constructor(private readonly liveDocumentProvider: LiveSchemaDocumentProvider) {}

  public createDiffService(resourceUri?: unknown): SchemaDiffService {
    const config = getExtensionConfig();
    const workspaceFolder = getWorkspaceFolder(resourceUri, config.schemaFolder);

    return new SchemaDiffService(
      new PostgresSchemaService(config),
      new SchemaFileService(workspaceFolder, config.schemaFolder, 'public'),
      this.liveDocumentProvider
    );
  }
}

function getWorkspaceFolder(resourceUri?: unknown, schemaFolderName?: string): vscode.WorkspaceFolder | undefined {
  const uri = isUri(resourceUri) ? resourceUri : vscode.window.activeTextEditor?.document.uri;
  const workspaceFolder = uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder && !isAbsolutePath(schemaFolderName)) {
    throw new Error('Open a workspace folder before using PostgreSQL Schema Compare.');
  }

  return workspaceFolder;
}

function isUri(value: unknown): value is vscode.Uri {
  return value instanceof vscode.Uri;
}

function isAbsolutePath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}
