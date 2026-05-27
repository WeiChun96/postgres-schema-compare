import * as vscode from 'vscode';

export interface ExtensionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly schemaFolder: string;
}

export function getExtensionConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('postgresSchemaCompare');

  return {
    host: config.get<string>('host', '').trim(),
    port: config.get<number>('port', 5432),
    database: config.get<string>('database', '').trim(),
    username: config.get<string>('username', '').trim(),
    password: config.get<string>('password', ''),
    schemaFolder: config.get<string>('schemaFolder', '').trim()
  };
}

export function hasConnectionConfig(config = getExtensionConfig()): boolean {
  return Boolean(config.host && config.port && config.database && config.username);
}

export async function updateExtensionConfig(config: ExtensionConfig): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const target = workspaceFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const configuration = vscode.workspace.getConfiguration('postgresSchemaCompare');

  await configuration.update('host', config.host.trim(), target);
  await configuration.update('port', config.port, target);
  await configuration.update('database', config.database.trim(), target);
  await configuration.update('username', config.username.trim(), target);
  await configuration.update('password', config.password, target);
  await configuration.update('schemaFolder', config.schemaFolder.trim(), target);
}
