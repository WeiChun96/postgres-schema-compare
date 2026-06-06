import * as vscode from 'vscode';
import { SchemaObjectRef } from '../model/schemaObject';
import { DiffSessionState } from '../services/diffSessionState';
import { SchemaComparisonResult, SchemaComparisonStatus, SchemaDiffService } from '../services/schemaDiffService';
import { ServiceFactory } from '../services/serviceFactory';
import { SchemaObjectKind } from '../model/schemaObject';

type RowComparisonMessage = {
  readonly type: 'openDiff' | 'updateFolder' | 'updateDatabase' | 'showMigrationPlan';
  readonly id: string;
};

type BulkComparisonMessage = {
  readonly type: 'bulkUpdateFolder' | 'bulkMigrationPlan' | 'bulkUpdateDatabase';
};

type ComparisonMessage = RowComparisonMessage | BulkComparisonMessage;

function isRowComparisonMessage(message: ComparisonMessage): message is RowComparisonMessage {
  return 'id' in message;
}

export function registerCompareFolderWithDatabaseCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState,
  onSynced: (kind: SchemaObjectKind) => Promise<void> | void
): void {
  const disposable = vscode.commands.registerCommand(
    'postgresSchemaCompare.compareFolderWithDatabase',
    async (resourceUri?: unknown) => {
      try {
        const diffService = serviceFactory.createDiffService(resourceUri);
        const resultById = new Map<string, SchemaComparisonResult>();
        const panel = vscode.window.createWebviewPanel(
          'postgresSchemaCompare.folderComparison',
          'Schema Folder vs Database',
          vscode.ViewColumn.One,
          {
            enableScripts: true
          }
        );

        panel.webview.html = renderLoadingHtml(panel.webview);

        panel.webview.onDidReceiveMessage(
          async (message: ComparisonMessage) => {
            try {
              if (message.type === 'bulkUpdateFolder') {
                await updateAllFolderDifferences(panel.webview, diffService, resultById, onSynced);
                return;
              }

              if (message.type === 'bulkMigrationPlan') {
                await openAllDatabaseMigrationPlan(diffService, resultById);
                return;
              }

              if (message.type === 'bulkUpdateDatabase') {
                await updateAllDatabaseDifferences(panel.webview, diffService, resultById, onSynced);
                return;
              }

              if (!isRowComparisonMessage(message)) {
                return;
              }

              const result = resultById.get(message.id);
              if (!result) {
                return;
              }

              if (message.type === 'updateFolder') {
                const didSync = await updateFolderFromResult(diffService, result);

                if (didSync) {
                  await refreshComparisonView(panel.webview, diffService, resultById, result.ref.kind, onSynced);
                }

                return;
              }

              if (message.type === 'updateDatabase') {
                const didSync = await updateDatabaseFromResult(diffService, result);

                if (didSync) {
                  await refreshComparisonView(panel.webview, diffService, resultById, result.ref.kind, onSynced);
                }

                return;
              }

              if (message.type === 'showMigrationPlan') {
                await openDatabaseMigrationPlan(diffService, result);
                return;
              }

              const preparedDiff = await diffService.prepareComparisonDiff(result);
              diffSessionState.setLastDiff({
                type: 'object',
                ref: result.ref,
                direction: 'databaseToLocal',
                status: result.status
              });
              await vscode.commands.executeCommand('setContext', 'postgresSchemaCompare.hasActiveDiff', true);
              await vscode.commands.executeCommand(
                'vscode.diff',
                preparedDiff.leftUri,
                preparedDiff.rightUri,
                preparedDiff.title
              );
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${messageText}`);
            }
          },
          undefined,
          context.subscriptions
        );

        try {
          const results = await diffService.compareFolderWithDatabase();
          const changedResults = results.filter((result) => result.status !== 'same');

          resultById.clear();
          for (const result of changedResults) {
            resultById.set(getResultId(result.ref), result);
          }

          panel.webview.html = renderComparisonHtml(panel.webview, changedResults);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          panel.webview.html = renderErrorHtml(panel.webview, message);
          await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`PostgreSQL Schema Compare: ${message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

function renderLoadingHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style>
    body {
      align-items: center;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      display: flex;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      justify-content: center;
      margin: 0;
      min-height: 100vh;
    }

    main {
      align-items: center;
      display: flex;
      flex-direction: column;
      gap: 14px;
      text-align: center;
    }

    .spinner {
      animation: spin 0.9s linear infinite;
      border: 3px solid var(--vscode-panel-border);
      border-radius: 50%;
      border-top-color: var(--vscode-progressBar-background);
      height: 34px;
      width: 34px;
    }

    .title {
      font-size: 16px;
      font-weight: 600;
    }

    .detail {
      color: var(--vscode-descriptionForeground);
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="spinner" aria-hidden="true"></div>
    <div class="title">Comparing schema folder with PostgreSQL database...</div>
    <div class="detail">Reading local SQL files and live database definitions.</div>
  </main>
  <script nonce="${nonce}"></script>
</body>
</html>`;
}

function renderErrorHtml(webview: vscode.Webview, message: string): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 24px;
    }

    main {
      max-width: 760px;
    }

    h1 {
      color: var(--vscode-errorForeground);
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 12px;
    }

    pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      overflow: auto;
      padding: 12px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main>
    <h1>Compare failed</h1>
    <pre>${escapeHtml(message)}</pre>
  </main>
  <script nonce="${nonce}"></script>
</body>
</html>`;
}

function renderComparisonHtml(webview: vscode.Webview, results: readonly SchemaComparisonResult[]): string {
  const nonce = createNonce();
  const counts = getStatusCounts(results);
  const rows = results.map(renderResultRow).join('');
  const hasResults = results.length > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 24px;
    }

    main {
      max-width: 1100px;
    }

    header {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 16px;
      padding-bottom: 14px;
    }

    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 10px;
    }

    .summary {
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .summary-bar {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px 16px;
      justify-content: space-between;
    }

    .count {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 3px 8px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
    }

    th {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      text-align: left;
    }

    th,
    td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px 10px;
      vertical-align: top;
    }

    tr.modified {
      background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground) 11%, transparent);
    }

    tr.missingLocal {
      background: color-mix(in srgb, var(--vscode-gitDecoration-untrackedResourceForeground) 11%, transparent);
    }

    tr.localOnly {
      background: color-mix(in srgb, var(--vscode-charts-yellow) 13%, transparent);
    }

    tr.error {
      background: color-mix(in srgb, var(--vscode-errorForeground) 11%, transparent);
    }

    .badge {
      border-radius: 3px;
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      min-width: 84px;
      padding: 2px 7px;
      text-align: center;
    }

    .badge.modified {
      color: var(--vscode-gitDecoration-modifiedResourceForeground);
    }

    .badge.missingLocal {
      color: var(--vscode-gitDecoration-untrackedResourceForeground);
    }

    .badge.localOnly {
      color: var(--vscode-charts-yellow);
    }

    .badge.error {
      color: var(--vscode-errorForeground);
    }

    .object {
      font-family: var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
    }

    .kind,
    .detail {
      color: var(--vscode-descriptionForeground);
    }

    button {
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 2px;
      color: var(--vscode-button-foreground);
      cursor: pointer;
      padding: 5px 10px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button[disabled] {
      cursor: default;
      opacity: 0.55;
    }

    select {
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      color: var(--vscode-dropdown-foreground);
      min-width: 150px;
      padding: 4px 26px 4px 8px;
    }

    .actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .bulk-actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .empty-state {
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      padding: 28px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Schema Folder vs Database</h1>
      <div class="summary-bar">
        <div class="summary">
          <span class="count" data-count="total">${results.length} change(s)</span>
          <span class="count" data-count="modified">${counts.modified} modified</span>
          <span class="count" data-count="missingLocal">${counts.missingLocal} missing local</span>
          <span class="count" data-count="localOnly">${counts.localOnly} local only</span>
          <span class="count" data-count="error">${counts.error} error(s)</span>
        </div>
        <div class="bulk-actions">
          <select data-bulk-action-select${getBulkActionOptions(results).length === 0 ? ' disabled' : ''}>
            ${renderBulkActionOptions(results)}
          </select>
          <button data-run-bulk-action${getBulkActionOptions(results).length === 0 ? ' disabled' : ''}>Run</button>
        </div>
      </div>
    </header>

    ${hasResults ? `<table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Object</th>
          <th>Type</th>
          <th>Detail</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>` : '<div class="empty-state">Schema folder matches the live database.</div>'}
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const bulkButton = event.target.closest('button[data-run-bulk-action]');
      if (bulkButton && !bulkButton.disabled) {
        const select = document.querySelector('select[data-bulk-action-select]');
        if (!select || select.disabled || !select.value) {
          return;
        }

        vscode.postMessage({
          type: select.value
        });
        return;
      }

      const button = event.target.closest('button[data-run-action]');
      if (!button || button.disabled) {
        return;
      }

      const row = button.closest('tr[data-id]');
      const select = row ? row.querySelector('select[data-action-select]') : undefined;
      if (!select || select.disabled || !select.value) {
        return;
      }

      vscode.postMessage({
        type: select.value,
        id: row.dataset.id
      });
    });
  </script>
</body>
</html>`;
}

function renderResultRow(result: SchemaComparisonResult): string {
  const id = getResultId(result.ref);
  const actionOptions = getActionOptions(result);
  const signature = result.ref.identityArguments ? `(${result.ref.identityArguments})` : '';

  return `<tr class="${escapeAttribute(result.status)}" data-id="${escapeAttribute(id)}">
    <td><span class="badge ${escapeAttribute(result.status)}">${escapeHtml(getStatusLabel(result.status))}</span></td>
    <td class="object">${escapeHtml(`${result.ref.schema}.${result.ref.name}${signature}`)}</td>
    <td class="kind">${escapeHtml(result.ref.kind)}</td>
    <td class="detail">${escapeHtml(result.message ?? getStatusDetail(result.status))}</td>
    <td class="actions">
      <select data-action-select data-id="${escapeAttribute(id)}"${actionOptions.length === 0 ? ' disabled' : ''}>
        ${actionOptions.length === 0 ? '<option value="">No available action</option>' : actionOptions.map(renderActionOption).join('')}
      </select>
      <button data-run-action data-id="${escapeAttribute(id)}"${actionOptions.length === 0 ? ' disabled' : ''}>Run</button>
    </td>
  </tr>`;
}

function getActionOptions(result: SchemaComparisonResult): ReadonlyArray<{ readonly value: RowComparisonMessage['type']; readonly label: string }> {
  if (result.status === 'error') {
    return [];
  }

  return [
    { value: 'openDiff', label: 'Compare' },
    { value: 'showMigrationPlan', label: 'Migration Plan' },
    { value: 'updateFolder', label: 'Update Folder' },
    { value: 'updateDatabase', label: 'Update Database' }
  ];
}

function renderActionOption(option: { readonly value: RowComparisonMessage['type']; readonly label: string }): string {
  return `<option value="${escapeAttribute(option.value)}">${escapeHtml(option.label)}</option>`;
}

function getBulkActionOptions(results: readonly SchemaComparisonResult[]): ReadonlyArray<{ readonly value: BulkComparisonMessage['type']; readonly label: string }> {
  const actionableCount = results.filter((result) => result.status !== 'error').length;

  if (actionableCount === 0) {
    return [];
  }

  return [
    { value: 'bulkMigrationPlan', label: 'Migration Plan - All Differences' },
    { value: 'bulkUpdateFolder', label: 'Update Folder - All Differences' },
    { value: 'bulkUpdateDatabase', label: 'Update Database - All Differences' }
  ];
}

function renderBulkActionOptions(results: readonly SchemaComparisonResult[]): string {
  const options = getBulkActionOptions(results);

  if (options.length === 0) {
    return '<option value="">No available action</option>';
  }

  return options.map((option) => `<option value="${escapeAttribute(option.value)}">${escapeHtml(option.label)}</option>`).join('');
}

async function updateFolderFromResult(
  diffService: SchemaDiffService,
  result: SchemaComparisonResult
): Promise<boolean> {
  if (result.status === 'localOnly') {
    const confirmed = await confirmAction(
      `${result.ref.schema}.${result.ref.name} exists only in the folder. Delete the local file to match the live database?`,
      'Delete Local File'
    );

    if (!confirmed) {
      return false;
    }

    await runActionWithProgress(
      `Deleting local file for ${result.ref.schema}.${result.ref.name}...`,
      () => diffService.deleteLocalObject(result.ref)
    );
    return true;
  }

  if (result.status === 'missingLocal') {
    const confirmed = await confirmAction(
      `${result.ref.schema}.${result.ref.name} exists only in the live database. Create the local file to match the live database?`,
      'Create Local File'
    );

    if (!confirmed) {
      return false;
    }
  }

  await runActionWithProgress(
    `Updating folder from live database for ${result.ref.schema}.${result.ref.name}...`,
    () => diffService.updateFolderFromDatabase(result.ref)
  );
  return true;
}

async function updateDatabaseFromResult(
  diffService: SchemaDiffService,
  result: SchemaComparisonResult
): Promise<boolean> {
  const action = result.status === 'missingLocal' ? 'Drop Database Object' : 'Update Database';
  const message = getUpdateDatabaseConfirmationMessage(result);
  const confirmed = await confirmAction(message, action);

  if (!confirmed) {
    return false;
  }

  if (result.status === 'missingLocal') {
    await runActionWithProgress(
      `Dropping live database object ${result.ref.schema}.${result.ref.name}...`,
      () => diffService.dropDatabaseObject(result.ref)
    );
  } else {
    await runActionWithProgress(
      `Updating live database from folder for ${result.ref.schema}.${result.ref.name}...`,
      () => diffService.updateDatabaseFromFolder(result.ref, result.status === 'modified')
    );
  }

  return true;
}

async function updateAllFolderDifferences(
  webview: vscode.Webview,
  diffService: SchemaDiffService,
  resultById: Map<string, SchemaComparisonResult>,
  onSynced: (kind: SchemaObjectKind) => Promise<void> | void
): Promise<void> {
  const results = getActionableResults(resultById);
  const syncedKinds = new Set<SchemaObjectKind>();

  for (const result of results) {
    const didSync = await updateFolderFromResult(diffService, result);

    if (didSync) {
      syncedKinds.add(result.ref.kind);
    }
  }

  if (syncedKinds.size > 0) {
    await refreshComparisonView(webview, diffService, resultById, Array.from(syncedKinds), onSynced);
  }
}

async function updateAllDatabaseDifferences(
  webview: vscode.Webview,
  diffService: SchemaDiffService,
  resultById: Map<string, SchemaComparisonResult>,
  onSynced: (kind: SchemaObjectKind) => Promise<void> | void
): Promise<void> {
  const results = getActionableResults(resultById);
  const syncedKinds = new Set<SchemaObjectKind>();

  for (const result of results) {
    syncedKinds.add(result.ref.kind);
  }

  const confirmed = await confirmAction(
    `Apply the full generated migration plan for ${results.length} difference(s) to the live database?`,
    'Update Database'
  );

  if (!confirmed) {
    return;
  }

  await runActionWithProgress(
    'Updating live database from full migration plan...',
    () => diffService.updateDatabaseFromMigrationPlan(results)
  );

  if (syncedKinds.size > 0) {
    await refreshComparisonView(webview, diffService, resultById, Array.from(syncedKinds), onSynced);
  }
}

function getActionableResults(resultById: ReadonlyMap<string, SchemaComparisonResult>): SchemaComparisonResult[] {
  return Array.from(resultById.values()).filter((result) => result.status !== 'error');
}

function getUpdateDatabaseConfirmationMessage(result: SchemaComparisonResult): string {
  if (result.status === 'missingLocal') {
    return `${result.ref.schema}.${result.ref.name} exists only in the live database. Drop it to match the folder?`;
  }

  if (result.status === 'modified' && result.ref.kind === 'table') {
    return `Apply the generated table migration plan for ${result.ref.schema}.${result.ref.name} to the live database?`;
  }

  return `Run the local SQL for ${result.ref.schema}.${result.ref.name} against the live database?`;
}

async function openDatabaseMigrationPlan(
  diffService: SchemaDiffService,
  result: SchemaComparisonResult
): Promise<void> {
  const uri = await runActionWithProgress(
    `Preparing database migration plan for ${result.ref.schema}.${result.ref.name}...`,
    () => diffService.prepareDatabaseMigrationPlan(result)
  );

  await vscode.window.showTextDocument(uri, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function openAllDatabaseMigrationPlan(
  diffService: SchemaDiffService,
  resultById: ReadonlyMap<string, SchemaComparisonResult>
): Promise<void> {
  const results = getActionableResults(resultById);
  const uri = await runActionWithProgress(
    'Preparing full database migration plan...',
    () => diffService.prepareDatabaseMigrationPlanForResults(results)
  );

  await vscode.window.showTextDocument(uri, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function refreshComparisonView(
  webview: vscode.Webview,
  diffService: SchemaDiffService,
  resultById: Map<string, SchemaComparisonResult>,
  syncedKinds: SchemaObjectKind | readonly SchemaObjectKind[],
  onSynced: (kind: SchemaObjectKind) => Promise<void> | void
): Promise<void> {
  const changedResults = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Refreshing Schema Folder vs Database...',
      cancellable: false
    },
    async () => (await diffService.compareFolderWithDatabase()).filter((result) => result.status !== 'same')
  );
  resultById.clear();

  for (const result of changedResults) {
    resultById.set(getResultId(result.ref), result);
  }

  webview.html = renderComparisonHtml(webview, changedResults);

  for (const kind of Array.isArray(syncedKinds) ? syncedKinds : [syncedKinds]) {
    await onSynced(kind);
  }
}

async function runActionWithProgress<T>(title: string, operation: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    operation
  );
}

function getStatusCounts(results: readonly SchemaComparisonResult[]): Record<SchemaComparisonStatus, number> {
  return {
    modified: results.filter((result) => result.status === 'modified').length,
    missingLocal: results.filter((result) => result.status === 'missingLocal').length,
    localOnly: results.filter((result) => result.status === 'localOnly').length,
    error: results.filter((result) => result.status === 'error').length,
    same: 0
  };
}

function getStatusLabel(status: SchemaComparisonStatus): string {
  switch (status) {
    case 'modified':
      return 'Modified';
    case 'missingLocal':
      return 'Missing Local';
    case 'localOnly':
      return 'Local Only';
    case 'error':
      return 'Error';
    case 'same':
      return 'Same';
  }
}

function getStatusDetail(status: SchemaComparisonStatus): string {
  switch (status) {
    case 'modified':
      return 'Database and local file have different SQL.';
    case 'missingLocal':
      return 'Object exists in the database but no local file was found.';
    case 'localOnly':
      return 'Local file exists but the object was not found in the database.';
    case 'error':
      return 'Could not compare this object.';
    case 'same':
      return 'No differences.';
  }
}

function getResultId(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}:${ref.name}:${ref.identityArguments ?? ''}`;
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

async function confirmAction(message: string, action: string): Promise<boolean> {
  const confirmation = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return confirmation === action;
}

function createNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return nonce;
}
