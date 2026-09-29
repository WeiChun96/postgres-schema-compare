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
  const target = getConfigurationTarget();
  const configuration = vscode.workspace.getConfiguration('postgresSchemaCompare');

  await configuration.update('host', config.host.trim(), target);
  await configuration.update('port', config.port, target);
  await configuration.update('database', config.database.trim(), target);
  await configuration.update('username', config.username.trim(), target);
  await configuration.update('password', config.password, target);
  await configuration.update('schemaFolder', config.schemaFolder.trim(), target);
}

export async function updateSchemaFolder(schemaFolder: string): Promise<void> {
  await vscode.workspace.getConfiguration('postgresSchemaCompare')
    .update('schemaFolder', schemaFolder.trim(), getConfigurationTarget());
}

export async function removeConnectionConfig(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('postgresSchemaCompare');
  const target = getConfigurationTarget();

  await configuration.update('host', '', target);
  await configuration.update('port', 5432, target);
  await configuration.update('database', '', target);
  await configuration.update('username', '', target);
  await configuration.update('password', '', target);
}

function getConfigurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
