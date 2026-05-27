import * as vscode from 'vscode';
import { getExtensionConfig, updateExtensionConfig } from '../config';
import { PostgresSchemaService } from '../services/postgresSchemaService';

type ConnectionSettingsMessage =
  | SaveConnectionSettingsMessage
  | TestConnectionSettingsMessage
  | ChooseSchemaFolderMessage;

interface SaveConnectionSettingsMessage {
  readonly type: 'save';
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly schemaFolder: string;
}

interface TestConnectionSettingsMessage {
  readonly type: 'testConnection';
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly schemaFolder: string;
}

interface ChooseSchemaFolderMessage {
  readonly type: 'chooseSchemaFolder';
}

export function registerOpenConnectionSettingsCommand(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;

  const disposable = vscode.commands.registerCommand('postgresSchemaCompare.openConnectionSettings', () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      'postgresSchemaCompare.connectionSettings',
      'PostgreSQL Connection',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = renderConnectionSettingsHtml(panel.webview, getExtensionConfig());

    panel.webview.onDidReceiveMessage(
      async (message: ConnectionSettingsMessage) => {
        if (message.type === 'chooseSchemaFolder') {
          await chooseSchemaFolder(panel?.webview);
          return;
        }

        if (message.type === 'testConnection') {
          await testConnection(panel?.webview, message);
          return;
        }

        if (message.type !== 'save') {
          return;
        }

        try {
          await updateExtensionConfig({
            host: message.host,
            port: parsePort(message.port),
            database: message.database,
            username: message.username,
            password: message.password,
            schemaFolder: message.schemaFolder
          });

          await vscode.window.showInformationMessage('PostgreSQL connection settings saved.');
        } catch (error) {
          const details = error instanceof Error ? error.message : String(error);
          await vscode.window.showErrorMessage(`Unable to save PostgreSQL connection settings: ${details}`);
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(
      () => {
        panel = undefined;
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

async function chooseSchemaFolder(webview: vscode.Webview | undefined): Promise<void> {
  const selectedFolders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select Schema Folder',
    title: 'Select Schema Folder'
  });

  const selectedFolder = selectedFolders?.[0];
  if (!selectedFolder) {
    return;
  }

  await webview?.postMessage({
    type: 'schemaFolderSelected',
    schemaFolder: toWorkspaceRelativePath(selectedFolder)
  });
}

function toWorkspaceRelativePath(folderUri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);

  if (!workspaceFolder) {
    return folderUri.fsPath;
  }

  return vscode.workspace.asRelativePath(folderUri, false);
}

async function testConnection(webview: vscode.Webview | undefined, message: TestConnectionSettingsMessage): Promise<void> {
  try {
    await new PostgresSchemaService({
      host: message.host.trim(),
      port: parsePort(message.port),
      database: message.database.trim(),
      username: message.username.trim(),
      password: message.password
    }).testConnection();

    await webview?.postMessage({
      type: 'connectionTestResult',
      ok: true,
      message: 'Connection successful.'
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);

    await webview?.postMessage({
      type: 'connectionTestResult',
      ok: false,
      message: details
    });
  }
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Port must be a number between 1 and 65535.');
  }

  return port;
}

function renderConnectionSettingsHtml(webview: vscode.Webview, config: ReturnType<typeof getExtensionConfig>): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>PostgreSQL Connection</title>
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 28px;
    }

    main {
      max-width: 820px;
    }

    header {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 12px;
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0;
    }

    .subtitle {
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }

    form {
      display: grid;
      gap: 22px;
    }

    fieldset {
      border: 0;
      display: grid;
      gap: 14px;
      margin: 0;
      padding: 0;
    }

    legend {
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 2px;
      padding: 0;
    }

    label {
      display: grid;
      gap: 7px;
      font-weight: 600;
    }

    .label-row {
      align-items: center;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .input-with-button {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      gap: 6px;
    }

    input {
      box-sizing: border-box;
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
    }

    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .hint {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.45;
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }

    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 2px;
    }

    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 2px;
      cursor: pointer;
      padding: 8px 14px;
    }

    .icon-button {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      min-height: 32px;
      padding: 0;
    }

    .icon-button svg {
      display: block;
      height: 17px;
      width: 17px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    .secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    #status {
      min-height: 18px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
    }

    @media (max-width: 640px) {
      body {
        padding: 18px;
      }

      .row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>PostgreSQL Connection</h1>
        <div class="subtitle">Configure the database used by schema compare.</div>
      </div>
    </header>
    <form id="connection-form">
      <fieldset>
        <legend>Connection</legend>
        <div class="row">
          <label>
            Host
            <input id="host" type="text" value="${escapeAttribute(config.host)}" placeholder="localhost" autocomplete="off">
          </label>

          <label>
            Port
            <input id="port" type="number" min="1" max="65535" value="${escapeAttribute(String(config.port))}" placeholder="5432" autocomplete="off">
          </label>
        </div>

        <div class="row">
          <label>
            Database
            <input id="database" type="text" value="${escapeAttribute(config.database)}" placeholder="postgres" autocomplete="off">
          </label>

          <label>
            Username
            <input id="username" type="text" value="${escapeAttribute(config.username)}" placeholder="postgres" autocomplete="off">
          </label>
        </div>

        <label>
          Password
          <input id="password" type="text" value="${escapeAttribute(config.password)}" placeholder="password" autocomplete="off">
          <span class="hint">Saved to this workspace's VS Code settings for now. Avoid committing workspace settings that contain credentials.</span>
        </label>
      </fieldset>

      <fieldset>
        <label>
          <span class="label-row">
            Schema folder
            <button id="choose-schema-folder" class="secondary icon-button" type="button" title="Choose Schema Folder" aria-label="Choose Schema Folder">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
              </svg>
            </button>
          </span>
          <input id="schemaFolder" type="text" value="${escapeAttribute(config.schemaFolder)}" placeholder="Select or enter a schema folder path">
        </label>
      </fieldset>

      <div class="actions">
        <button type="submit">Save</button>
        <button id="test-connection" class="secondary" type="button">Test Connection</button>
      </div>

      <div id="status" role="status"></div>
    </form>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('connection-form');
    const host = document.getElementById('host');
    const port = document.getElementById('port');
    const database = document.getElementById('database');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const schemaFolder = document.getElementById('schemaFolder');
    const status = document.getElementById('status');
    const testConnection = document.getElementById('test-connection');
    const chooseSchemaFolder = document.getElementById('choose-schema-folder');

    form.addEventListener('submit', (event) => {
      event.preventDefault();

      vscode.postMessage({
        type: 'save',
        host: host.value,
        port: port.value,
        database: database.value,
        username: username.value,
        password: password.value,
        schemaFolder: schemaFolder.value
      });

      status.textContent = 'Saving...';
      window.setTimeout(() => {
        status.textContent = 'Saved.';
      }, 250);
    });

    testConnection.addEventListener('click', () => {
      status.textContent = 'Testing connection...';
      testConnection.disabled = true;

      vscode.postMessage({
        type: 'testConnection',
        host: host.value,
        port: port.value,
        database: database.value,
        username: username.value,
        password: password.value,
        schemaFolder: schemaFolder.value
      });
    });

    chooseSchemaFolder.addEventListener('click', () => {
      status.textContent = 'Choosing schema folder...';
      vscode.postMessage({
        type: 'chooseSchemaFolder'
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'schemaFolderSelected') {
        schemaFolder.value = message.schemaFolder;
        status.textContent = 'Schema folder selected.';
        return;
      }

      if (message.type !== 'connectionTestResult') {
        return;
      }

      testConnection.disabled = false;
      status.textContent = message.ok ? message.message : 'Connection failed: ' + message.message;
    });
  </script>
</body>
</html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return nonce;
}
