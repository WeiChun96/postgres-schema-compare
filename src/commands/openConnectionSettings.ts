import * as vscode from 'vscode';
import { ExtensionConfig, getExtensionConfig, updateExtensionConfig } from '../config';
import { PostgresSchemaService } from '../services/postgresSchemaService';

type ConnectionSettingsMessage =
  | SaveConnectionSettingsMessage
  | TestConnectionSettingsMessage
  | ChooseSchemaFolderMessage;

interface SaveConnectionSettingsMessage extends ConnectionSettingsFormMessage {
  readonly type: 'save';
}

interface TestConnectionSettingsMessage extends ConnectionSettingsFormMessage {
  readonly type: 'testConnection';
}

interface ConnectionSettingsFormMessage {
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

interface ValidationResult {
  readonly config: ExtensionConfig;
  readonly issues: readonly string[];
}

export function registerOpenConnectionSettingsCommand(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let panelDisposables: vscode.Disposable[] = [];

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

    panel.webview.html = renderConnectionSettingsHtml(getExtensionConfig());

    panelDisposables = [
      panel.webview.onDidReceiveMessage((message: ConnectionSettingsMessage) => handleConnectionSettingsMessage(panel?.webview, message)),
      panel.onDidDispose(() => {
        panelDisposables.forEach((item) => item.dispose());
        panelDisposables = [];
        panel = undefined;
      })
    ];
  });

  context.subscriptions.push(disposable);
}

async function handleConnectionSettingsMessage(
  webview: vscode.Webview | undefined,
  message: ConnectionSettingsMessage
): Promise<void> {
  try {
    switch (message.type) {
      case 'chooseSchemaFolder':
        await chooseSchemaFolder(webview);
        return;
      case 'testConnection':
        await testConnection(webview, message);
        return;
      case 'save':
        await saveConnectionSettings(webview, message);
        return;
    }
  } catch (error) {
    const details = getErrorMessage(error);
    await webview?.postMessage({
      type: 'operationResult',
      operation: 'error',
      ok: false,
      message: details
    });
    await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${details}`);
  }
}

async function saveConnectionSettings(webview: vscode.Webview | undefined, message: SaveConnectionSettingsMessage): Promise<void> {
  const validation = validateConnectionSettings(message);

  if (validation.issues.length > 0) {
    await webview?.postMessage({
      type: 'operationResult',
      operation: 'save',
      ok: false,
      message: validation.issues.join(' ')
    });
    return;
  }

  await updateExtensionConfig(validation.config);
  await webview?.postMessage({
    type: 'operationResult',
    operation: 'save',
    ok: true,
    message: 'Connection settings saved.'
  });
  await vscode.window.showInformationMessage('PostgreSQL connection settings saved.');
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
    await webview?.postMessage({
      type: 'operationResult',
      operation: 'chooseSchemaFolder',
      ok: true,
      message: 'Folder selection cancelled.'
    });
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
  const validation = validateConnectionSettings(message);

  if (validation.issues.length > 0) {
    await webview?.postMessage({
      type: 'operationResult',
      operation: 'testConnection',
      ok: false,
      message: validation.issues.join(' ')
    });
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Testing PostgreSQL connection...',
        cancellable: false
      },
      () => new PostgresSchemaService(validation.config).testConnection()
    );

    await webview?.postMessage({
      type: 'operationResult',
      operation: 'testConnection',
      ok: true,
      message: 'Connection successful.'
    });
  } catch (error) {
    await webview?.postMessage({
      type: 'operationResult',
      operation: 'testConnection',
      ok: false,
      message: getErrorMessage(error)
    });
  }
}

function validateConnectionSettings(message: ConnectionSettingsFormMessage): ValidationResult {
  const config: ExtensionConfig = {
    host: message.host.trim(),
    port: parsePort(message.port),
    database: message.database.trim(),
    username: message.username.trim(),
    password: message.password,
    schemaFolder: message.schemaFolder.trim()
  };
  const issues: string[] = [];

  if (!config.host) {
    issues.push('Host is required.');
  }

  if (!config.database) {
    issues.push('Database is required.');
  }

  if (!config.username) {
    issues.push('Username is required.');
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    issues.push('Port must be a number between 1 and 65535.');
  }

  return { config, issues };
}

function parsePort(value: string): number {
  return Number(value);
}

function renderConnectionSettingsHtml(config: ExtensionConfig): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>PostgreSQL Connection</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 24px;
    }

    main {
      max-width: 880px;
    }

    header {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 20px;
      padding-bottom: 16px;
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
      line-height: 1.3;
      margin: 0 0 5px;
    }

    .subtitle,
    .hint {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

    form {
      display: grid;
      gap: 20px;
    }

    fieldset {
      border: 1px solid var(--vscode-panel-border);
      display: grid;
      gap: 14px;
      margin: 0;
      padding: 16px;
    }

    legend {
      color: var(--vscode-foreground);
      font-size: 13px;
      font-weight: 600;
      padding: 0 6px;
    }

    label {
      display: grid;
      gap: 7px;
      font-weight: 600;
    }

    .label-row {
      align-items: center;
      display: flex;
      gap: 8px;
      justify-content: space-between;
    }

    .required {
      color: var(--vscode-errorForeground);
      font-weight: 600;
    }

    .row {
      display: grid;
      gap: 14px;
      grid-template-columns: minmax(0, 1fr) minmax(120px, 180px);
    }

    .input-with-button {
      display: grid;
      gap: 6px;
      grid-template-columns: minmax(0, 1fr) 34px;
    }

    input {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      line-height: 1.4;
      min-height: 32px;
      padding: 6px 8px;
      width: 100%;
    }

    input:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    input:invalid {
      border-color: var(--vscode-inputValidation-errorBorder);
    }

    .hint {
      font-size: 12px;
      font-weight: 400;
    }

    .actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      justify-content: flex-end;
    }

    button {
      background: var(--vscode-button-background);
      border: 0;
      color: var(--vscode-button-foreground);
      cursor: pointer;
      min-height: 32px;
      padding: 6px 13px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .icon-button {
      align-items: center;
      display: inline-flex;
      justify-content: center;
      padding: 0;
      width: 34px;
    }

    .icon-button svg {
      display: block;
      height: 17px;
      width: 17px;
    }

    .status {
      border-left: 3px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      min-height: 34px;
      padding: 7px 10px;
    }

    .status[data-tone="success"] {
      border-left-color: var(--vscode-testing-iconPassed);
      color: var(--vscode-testing-iconPassed);
    }

    .status[data-tone="error"] {
      border-left-color: var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
    }

    .status[data-tone="progress"] {
      border-left-color: var(--vscode-progressBar-background);
    }

    @media (max-width: 640px) {
      body {
        padding: 16px;
      }

      .row,
      .input-with-button {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: stretch;
      }

      .actions button {
        flex: 1 1 180px;
      }

      .icon-button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PostgreSQL Connection</h1>
      <div class="subtitle">Set the live database and schema folder used by comparisons and sync actions.</div>
    </header>

    <form id="connection-form" novalidate>
      <fieldset>
        <legend>Database</legend>
        <div class="row">
          <label for="host">
            <span>Host <span class="required" aria-hidden="true">*</span></span>
            <input id="host" name="host" type="text" value="${escapeAttribute(config.host)}" placeholder="localhost" autocomplete="off" required>
          </label>

          <label for="port">
            <span>Port <span class="required" aria-hidden="true">*</span></span>
            <input id="port" name="port" type="number" min="1" max="65535" step="1" inputmode="numeric" value="${escapeAttribute(String(config.port))}" placeholder="5432" autocomplete="off" required>
          </label>
        </div>

        <div class="row">
          <label for="database">
            <span>Database <span class="required" aria-hidden="true">*</span></span>
            <input id="database" name="database" type="text" value="${escapeAttribute(config.database)}" placeholder="postgres" autocomplete="off" required>
          </label>

          <label for="username">
            <span>Username <span class="required" aria-hidden="true">*</span></span>
            <input id="username" name="username" type="text" value="${escapeAttribute(config.username)}" placeholder="postgres" autocomplete="username" required>
          </label>
        </div>

        <label for="password">
          Password
          <div class="input-with-button">
            <input id="password" name="password" type="password" value="${escapeAttribute(config.password)}" placeholder="Optional password" autocomplete="current-password">
            <button id="toggle-password" class="secondary icon-button" type="button" title="Show password" aria-label="Show password" aria-pressed="false">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
                <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.7"/>
              </svg>
            </button>
          </div>
          <span class="hint">Stored in VS Code settings. Keep workspace settings with passwords out of source control.</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Local schema files</legend>
        <label for="schemaFolder">
          <span class="label-row">
            Schema folder
            <button id="choose-schema-folder" class="secondary icon-button" type="button" title="Choose schema folder" aria-label="Choose schema folder">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
              </svg>
            </button>
          </span>
          <input id="schemaFolder" name="schemaFolder" type="text" value="${escapeAttribute(config.schemaFolder)}" placeholder="schema">
          <span class="hint">Use a workspace-relative path when the folder is inside the current workspace.</span>
        </label>
      </fieldset>

      <div id="status" class="status" role="status" aria-live="polite">Required fields are marked with an asterisk.</div>

      <div class="actions">
        <button id="test-connection" class="secondary" type="button">Test Connection</button>
        <button id="save-settings" type="submit">Save Settings</button>
      </div>
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
    const saveSettings = document.getElementById('save-settings');
    const testConnection = document.getElementById('test-connection');
    const chooseSchemaFolder = document.getElementById('choose-schema-folder');
    const togglePassword = document.getElementById('toggle-password');

    function getFormValues() {
      return {
        host: host.value.trim(),
        port: port.value.trim(),
        database: database.value.trim(),
        username: username.value.trim(),
        password: password.value,
        schemaFolder: schemaFolder.value.trim()
      };
    }

    function getValidationMessage() {
      const values = getFormValues();
      const issues = [];
      const parsedPort = Number(values.port);

      if (!values.host) {
        issues.push('Host is required.');
      }

      if (!values.database) {
        issues.push('Database is required.');
      }

      if (!values.username) {
        issues.push('Username is required.');
      }

      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        issues.push('Port must be a number between 1 and 65535.');
      }

      return issues.join(' ');
    }

    function setStatus(message, tone) {
      status.textContent = message;
      status.dataset.tone = tone;
    }

    function setBusy(isBusy) {
      saveSettings.disabled = isBusy;
      testConnection.disabled = isBusy;
      chooseSchemaFolder.disabled = isBusy;
      togglePassword.disabled = isBusy;
    }

    function postFormMessage(type) {
      const validationMessage = getValidationMessage();

      if (validationMessage) {
        setStatus(validationMessage, 'error');
        return;
      }

      setBusy(true);
      setStatus(type === 'save' ? 'Saving settings...' : 'Testing connection...', 'progress');
      vscode.postMessage({
        type,
        ...getFormValues()
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      postFormMessage('save');
    });

    testConnection.addEventListener('click', () => {
      postFormMessage('testConnection');
    });

    chooseSchemaFolder.addEventListener('click', () => {
      setStatus('Opening folder picker...', 'progress');
      vscode.postMessage({
        type: 'chooseSchemaFolder'
      });
    });

    togglePassword.addEventListener('click', () => {
      const isHidden = password.type === 'password';
      password.type = isHidden ? 'text' : 'password';
      togglePassword.setAttribute('aria-pressed', String(isHidden));
      togglePassword.title = isHidden ? 'Hide password' : 'Show password';
      togglePassword.setAttribute('aria-label', togglePassword.title);
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'schemaFolderSelected') {
        schemaFolder.value = message.schemaFolder;
        setStatus('Schema folder selected.', 'success');
        return;
      }

      if (message.type !== 'operationResult') {
        return;
      }

      setBusy(false);
      setStatus(message.message, message.ok ? 'success' : 'error');
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return nonce;
}
