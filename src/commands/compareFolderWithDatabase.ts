import * as vscode from 'vscode';
import { DiffSessionState } from '../services/diffSessionState';
import { isSchemaRef, SchemaComparisonRef, SchemaComparisonResult, SchemaComparisonStatus, SchemaDiffService } from '../services/schemaDiffService';
import { ServiceFactory } from '../services/serviceFactory';
import { SchemaObjectRef } from '../model/schemaObject';

type FilterableComparisonStatus = Extract<SchemaComparisonStatus, 'modified' | 'missingLocal' | 'localOnly'>;

type RowComparisonMessage = {
  readonly type: 'openDiff' | 'updateFolder' | 'updateDatabase' | 'showMigrationPlan';
  readonly id: string;
};

type BulkComparisonMessage = {
  readonly type: 'bulkUpdateFolder' | 'bulkMigrationPlan' | 'bulkUpdateDatabase';
  readonly status?: FilterableComparisonStatus;
  readonly schema?: string;
  readonly kind?: SchemaComparisonRef['kind'];
};

type ComparisonMessage = RowComparisonMessage | BulkComparisonMessage;

function isRowComparisonMessage(message: ComparisonMessage): message is RowComparisonMessage {
  return 'id' in message;
}

export function registerCompareFolderWithDatabaseCommand(
  context: vscode.ExtensionContext,
  serviceFactory: ServiceFactory,
  diffSessionState: DiffSessionState,
  onSynced: (ref: SchemaObjectRef) => Promise<void> | void
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

        panel.webview.html = renderLoadingHtml();

        panel.webview.onDidReceiveMessage(
          async (message: ComparisonMessage) => {
            try {
              if (message.type === 'bulkUpdateFolder') {
                await updateAllFolderDifferences(panel.webview, diffService, resultById, onSynced, message.status, message.schema, message.kind);
                return;
              }

              if (message.type === 'bulkMigrationPlan') {
                await openAllDatabaseMigrationPlan(diffService, resultById, message.status, message.schema, message.kind);
                return;
              }

              if (message.type === 'bulkUpdateDatabase') {
                await updateAllDatabaseDifferences(panel.webview, diffService, resultById, onSynced, message.status, message.schema, message.kind);
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

                if (didSync && !isSchemaRef(result.ref)) {
                  await refreshComparisonView(panel.webview, resultById, [result.ref], onSynced);
                }

                return;
              }

              if (message.type === 'updateDatabase') {
                const didSync = await updateDatabaseFromResult(diffService, result);

                if (didSync && !isSchemaRef(result.ref)) {
                  await refreshComparisonView(panel.webview, resultById, [result.ref], onSynced);
                } else if (didSync) {
                  resultById.delete(getResultId(result.ref));
                  panel.webview.html = renderComparisonHtml(Array.from(resultById.values()));
                }

                return;
              }

              if (message.type === 'showMigrationPlan') {
                await openDatabaseMigrationPlan(diffService, result);
                return;
              }

              const preparedDiff = await diffService.prepareComparisonDiff(result);
              if (!isSchemaRef(result.ref)) {
                diffSessionState.setLastDiff({
                  type: 'object',
                  ref: result.ref,
                  direction: 'databaseToLocal',
                  status: result.status
                });
                await vscode.commands.executeCommand('setContext', 'postgresSchemaCompare.hasActiveDiff', true);
              }
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

          panel.webview.html = renderComparisonHtml(changedResults);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          panel.webview.html = renderErrorHtml(message);
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

function renderLoadingHtml(): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style nonce="${nonce}">
    * {
      box-sizing: border-box;
    }

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

function renderErrorHtml(message: string): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style nonce="${nonce}">
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

function renderComparisonHtml(results: readonly SchemaComparisonResult[]): string {
  const nonce = createNonce();
  const counts = getStatusCounts(results);
  const rows = results.map(renderResultRow).join('');
  const hasResults = results.length > 0;
  const bulkActionOptions = getBulkActionOptions(results);
  const schemas = Array.from(new Set(results.map((result) => result.ref.schema))).sort((left, right) => left.localeCompare(right));
  const kinds = Array.from(new Set(results.map((result) => result.ref.kind))).sort((left, right) => getTypeLabel(left).localeCompare(getTypeLabel(right)));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Schema Folder vs Database</title>
  <style nonce="${nonce}">
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
      margin: 0 0 6px;
    }

    .subtitle {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
      margin-bottom: 14px;
    }

    .summary {
      color: var(--vscode-descriptionForeground);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .summary-bar {
      display: grid;
      gap: 12px;
    }

    .count {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      padding: 3px 8px;
    }

    .toolbar {
      align-items: end;
      display: grid;
      gap: 12px 16px;
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .filter-group {
      display: grid;
      gap: 7px;
    }

    .filter-label,
    .bulk-label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 600;
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .filter-selects {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .select-filter {
      display: grid;
      gap: 4px;
    }

    .select-filter label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .filter-button {
      align-items: center;
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      display: inline-flex;
      gap: 7px;
      justify-content: center;
      min-height: 30px;
      padding: 4px 9px;
    }

    .filter-button:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .filter-button[aria-pressed="true"] {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .filter-button[disabled] {
      cursor: default;
      opacity: 0.5;
    }

    .filter-count {
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }

    .filter-status {
      color: var(--vscode-descriptionForeground);
      min-height: 18px;
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

    button:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
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
      display: grid;
      gap: 7px;
      justify-items: end;
    }

    .bulk-controls {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .empty-state {
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      padding: 28px;
    }

    .filtered-empty-state {
      border: 1px dashed var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      display: none;
      margin-top: 12px;
      padding: 18px;
    }

    .filtered-empty-state.visible {
      display: block;
    }

    @media (max-width: 760px) {
      body {
        padding: 16px;
      }

      .toolbar {
        grid-template-columns: 1fr;
      }

      .bulk-actions {
        justify-items: stretch;
      }

      .bulk-controls {
        justify-content: stretch;
      }

      .bulk-controls select,
      .bulk-controls button {
        flex: 1 1 180px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Schema Folder vs Database</h1>
      <div class="subtitle">Review differences between local SQL files and the live database.</div>
      <div class="summary-bar">
        <div class="summary">
          <span class="count" data-count="total">${results.length} change(s)</span>
          <span class="count" data-count="error">${counts.error} error(s)</span>
        </div>
        <div class="toolbar">
          <div class="filter-group" aria-label="Filter differences">
            <div class="filter-label">Filter changes</div>
            <div class="filter-selects">
              <div class="select-filter">
                <label for="schema-filter">Schema</label>
                <select id="schema-filter" data-schema-filter>
                  <option value="">All schemas</option>
                  ${schemas.map((schema) => `<option value="${escapeAttribute(schema)}">${escapeHtml(schema)}</option>`).join('')}
                </select>
              </div>
              <div class="select-filter">
                <label for="type-filter">Type</label>
                <select id="type-filter" data-type-filter>
                  <option value="">All types</option>
                  ${kinds.map((kind) => `<option value="${escapeAttribute(kind)}">${escapeHtml(getTypeLabel(kind))}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="filter-label">Status</div>
            <div class="filters">
              ${renderStatusFilterButton('modified', counts.modified)}
              ${renderStatusFilterButton('missingLocal', counts.missingLocal)}
              ${renderStatusFilterButton('localOnly', counts.localOnly)}
            </div>
            <div id="filter-status" class="filter-status" role="status" aria-live="polite">${results.length} change(s) shown.</div>
          </div>
          <div class="bulk-actions">
            <div class="bulk-label">Bulk action — shown changes only</div>
            <div class="bulk-controls">
              <select data-bulk-action-select${bulkActionOptions.length === 0 ? ' disabled' : ''} aria-label="Bulk action">
                ${renderBulkActionOptions(results)}
              </select>
              <button data-run-bulk-action${bulkActionOptions.length === 0 ? ' disabled' : ''}>Run</button>
            </div>
          </div>
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
    </table>
    <div id="filtered-empty-state" class="filtered-empty-state">No changes match the selected filter.</div>` : '<div class="empty-state">Schema folder matches the live database.</div>'}
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const savedFilterState = vscode.getState() || {};
    let activeFilter = savedFilterState.status;
    let activeSchema = savedFilterState.schema;
    let activeKind = savedFilterState.kind;

    function getVisibleRows() {
      return Array.from(document.querySelectorAll('tbody tr[data-id]')).filter((row) => !row.hidden);
    }

    function updateBulkActionState() {
      const select = document.querySelector('select[data-bulk-action-select]');
      const button = document.querySelector('button[data-run-bulk-action]');

      if (!select || !button) {
        return;
      }

      const hasVisibleActionableRows = getVisibleRows().some((row) => row.dataset.status !== 'error');
      select.disabled = !hasVisibleActionableRows;
      button.disabled = !hasVisibleActionableRows;
    }

    function updateFilterStatus() {
      const filterStatus = document.getElementById('filter-status');

      if (!filterStatus) {
        return;
      }

      const visibleCount = getVisibleRows().length;
      const scopes = [];
      if (activeSchema) {
        scopes.push('in ' + activeSchema);
      }
      if (activeKind) {
        scopes.push('of type ' + getTypeLabel(activeKind));
      }
      if (activeFilter) {
        scopes.push('with status ' + getFilterLabel(activeFilter).toLowerCase());
      }
      filterStatus.textContent = visibleCount + ' change(s) shown' + (scopes.length ? ' ' + scopes.join(' ') : '') + '.';
    }

    function getFilterLabel(status) {
      switch (status) {
        case 'modified':
          return 'Modified';
        case 'missingLocal':
          return 'Missing Local';
        case 'localOnly':
          return 'Local Only';
        default:
          return 'All';
      }
    }

    function getTypeLabel(kind) {
      const option = document.querySelector('select[data-type-filter] option[value="' + CSS.escape(kind) + '"]');
      return option ? option.textContent : kind;
    }

    function applyStatusFilter(nextFilter) {
      activeFilter = activeFilter === nextFilter ? undefined : nextFilter;

      applyFilters();
    }

    function applyFilters() {
      document.querySelectorAll('button[data-filter-status]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.filterStatus === activeFilter));
      });

      const rows = Array.from(document.querySelectorAll('tbody tr[data-id]'));
      for (const row of rows) {
        row.hidden = Boolean(
          (activeFilter && row.dataset.status !== activeFilter)
          || (activeSchema && row.dataset.schema !== activeSchema)
          || (activeKind && row.dataset.kind !== activeKind)
        );
      }

      const filteredEmptyState = document.getElementById('filtered-empty-state');
      if (filteredEmptyState) {
        filteredEmptyState.classList.toggle('visible', rows.length > 0 && getVisibleRows().length === 0);
      }

      updateFilterStatus();
      updateBulkActionState();
      vscode.setState({
        status: activeFilter,
        schema: activeSchema,
        kind: activeKind
      });
    }

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const filterButton = event.target.closest('button[data-filter-status]');
      if (filterButton && !filterButton.disabled) {
        applyStatusFilter(filterButton.dataset.filterStatus);
        return;
      }

      const bulkButton = event.target.closest('button[data-run-bulk-action]');
      if (bulkButton && !bulkButton.disabled) {
        const select = document.querySelector('select[data-bulk-action-select]');
        if (!select || select.disabled || !select.value) {
          return;
        }

        vscode.postMessage({
          type: select.value,
          status: activeFilter,
          schema: activeSchema,
          kind: activeKind
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

    document.querySelector('select[data-schema-filter]')?.addEventListener('change', (event) => {
      activeSchema = event.target.value || undefined;
      applyFilters();
    });

    document.querySelector('select[data-type-filter]')?.addEventListener('change', (event) => {
      activeKind = event.target.value || undefined;
      applyFilters();
    });

    const schemaFilter = document.querySelector('select[data-schema-filter]');
    if (schemaFilter && activeSchema && schemaFilter.querySelector('option[value="' + CSS.escape(activeSchema) + '"]')) {
      schemaFilter.value = activeSchema;
    } else {
      activeSchema = undefined;
    }

    const typeFilter = document.querySelector('select[data-type-filter]');
    if (typeFilter && activeKind && typeFilter.querySelector('option[value="' + CSS.escape(activeKind) + '"]')) {
      typeFilter.value = activeKind;
    } else {
      activeKind = undefined;
    }

    applyFilters();
  </script>
</body>
</html>`;
}

function renderResultRow(result: SchemaComparisonResult): string {
  const id = getResultId(result.ref);
  const actionOptions = getActionOptions(result);
  const signature = !isSchemaRef(result.ref) && result.ref.identityArguments ? `(${result.ref.identityArguments})` : '';
  const objectLabel = isSchemaRef(result.ref) ? result.ref.schema : `${result.ref.schema}.${result.ref.name}${signature}`;

  return `<tr class="${escapeAttribute(result.status)}" data-id="${escapeAttribute(id)}" data-status="${escapeAttribute(result.status)}" data-schema="${escapeAttribute(result.ref.schema)}" data-kind="${escapeAttribute(result.ref.kind)}">
    <td><span class="badge ${escapeAttribute(result.status)}">${escapeHtml(getStatusLabel(result.status))}</span></td>
    <td class="object">${escapeHtml(objectLabel)}</td>
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

function renderStatusFilterButton(status: FilterableComparisonStatus, count: number): string {
  return `<button class="filter-button ${escapeAttribute(status)}" type="button" data-filter-status="${escapeAttribute(status)}" aria-pressed="false">
    <span>${escapeHtml(getStatusLabel(status))}</span>
    <span class="filter-count">${count}</span>
  </button>`;
}

function getActionOptions(result: SchemaComparisonResult): ReadonlyArray<{ readonly value: RowComparisonMessage['type']; readonly label: string }> {
  if (result.status === 'error') {
    return [];
  }

  if (isSchemaRef(result.ref)) {
    return [
      { value: 'openDiff', label: 'Compare' },
      { value: 'showMigrationPlan', label: 'Create Schema Migration Plan' },
      { value: 'updateDatabase', label: 'Create Schema in Database' }
    ];
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
  if (isSchemaRef(result.ref)) {
    await vscode.window.showInformationMessage('Schema rows do not have a local SQL file to update.');
    return false;
  }

  const objectRef = result.ref;

  if (result.status === 'localOnly') {
    const confirmed = await confirmAction(
      `${objectRef.schema}.${objectRef.name} exists only in the folder. Delete the local file to match the live database?`,
      'Delete Local File'
    );

    if (!confirmed) {
      return false;
    }

    await runActionWithProgress(
      `Deleting local file for ${objectRef.schema}.${objectRef.name}...`,
      () => diffService.deleteLocalObject(objectRef)
    );
    return true;
  }

  if (result.status === 'missingLocal') {
    const confirmed = await confirmAction(
      `${objectRef.schema}.${objectRef.name} exists only in the live database. Create the local file to match the live database?`,
      'Create Local File'
    );

    if (!confirmed) {
      return false;
    }
  }

  await runActionWithProgress(
    `Updating folder from live database for ${objectRef.schema}.${objectRef.name}...`,
    () => diffService.updateFolderFromDatabase(objectRef)
  );
  return true;
}

async function updateDatabaseFromResult(
  diffService: SchemaDiffService,
  result: SchemaComparisonResult
): Promise<boolean> {
  const action = isSchemaRef(result.ref)
    ? 'Create Schema'
    : result.status === 'missingLocal' ? 'Drop Database Object' : 'Update Database';
  const message = getUpdateDatabaseConfirmationMessage(result);
  const confirmed = await confirmAction(message, action);

  if (!confirmed) {
    return false;
  }

  if (isSchemaRef(result.ref)) {
    await runActionWithProgress(
      `Creating schema ${result.ref.schema} in live database...`,
      () => diffService.updateDatabaseFromMigrationPlan([result])
    );
    return true;
  }

  const objectRef = result.ref;

  if (result.status === 'missingLocal') {
    await runActionWithProgress(
      `Dropping live database object ${objectRef.schema}.${objectRef.name}...`,
      () => diffService.dropDatabaseObject(objectRef)
    );
  } else {
    await runActionWithProgress(
      `Updating live database from folder for ${objectRef.schema}.${objectRef.name}...`,
      () => diffService.updateDatabaseFromFolder(objectRef, result.status === 'modified')
    );
  }

  return true;
}

async function updateAllFolderDifferences(
  webview: vscode.Webview,
  diffService: SchemaDiffService,
  resultById: Map<string, SchemaComparisonResult>,
  onSynced: (ref: SchemaObjectRef) => Promise<void> | void,
  status?: FilterableComparisonStatus,
  schema?: string,
  kind?: SchemaComparisonRef['kind']
): Promise<void> {
  const results = getActionableResults(resultById, status, schema, kind);
  const syncedRefs: SchemaObjectRef[] = [];

  for (const result of results) {
    if (isSchemaRef(result.ref)) {
      continue;
    }

    const didSync = await updateFolderFromResult(diffService, result);

    if (didSync) {
      syncedRefs.push(result.ref);
    }
  }

  if (syncedRefs.length > 0) {
    await refreshComparisonView(webview, resultById, syncedRefs, onSynced);
  }
}

async function updateAllDatabaseDifferences(
  webview: vscode.Webview,
  diffService: SchemaDiffService,
  resultById: Map<string, SchemaComparisonResult>,
  onSynced: (ref: SchemaObjectRef) => Promise<void> | void,
  status?: FilterableComparisonStatus,
  schema?: string,
  kind?: SchemaComparisonRef['kind']
): Promise<void> {
  const results = getActionableResults(resultById, status, schema, kind);
  const syncedRefs: SchemaObjectRef[] = [];

  for (const result of results) {
    if (!isSchemaRef(result.ref)) {
      syncedRefs.push(result.ref);
    }
  }

  const confirmed = await confirmAction(
    `Apply the generated migration plan for ${getBulkScopeLabel(status, schema, kind)}${results.length} difference(s) to the live database?`,
    'Update Database'
  );

  if (!confirmed) {
    return;
  }

  await runActionWithProgress(
    'Updating live database from full migration plan...',
    () => diffService.updateDatabaseFromMigrationPlan(results)
  );

  if (syncedRefs.length > 0) {
    await refreshComparisonView(webview, resultById, syncedRefs, onSynced);
  }
}

function getActionableResults(
  resultById: ReadonlyMap<string, SchemaComparisonResult>,
  status?: FilterableComparisonStatus,
  schema?: string,
  kind?: SchemaComparisonRef['kind']
): SchemaComparisonResult[] {
  return Array.from(resultById.values()).filter((result) =>
    result.status !== 'error'
    && (!status || result.status === status)
    && (!schema || result.ref.schema === schema)
    && (!kind || result.ref.kind === kind)
  );
}

function getUpdateDatabaseConfirmationMessage(result: SchemaComparisonResult): string {
  if (isSchemaRef(result.ref)) {
    return `Create schema ${result.ref.schema} in the live database?`;
  }

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
  resultById: ReadonlyMap<string, SchemaComparisonResult>,
  status?: FilterableComparisonStatus,
  schema?: string,
  kind?: SchemaComparisonRef['kind']
): Promise<void> {
  const results = getActionableResults(resultById, status, schema, kind);
  const uri = await runActionWithProgress(
    `Preparing ${getBulkScopeLabel(status, schema, kind).trim() || 'full'} database migration plan...`,
    () => diffService.prepareDatabaseMigrationPlanForResults(results)
  );

  await vscode.window.showTextDocument(uri, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function refreshComparisonView(
  webview: vscode.Webview,
  resultById: Map<string, SchemaComparisonResult>,
  syncedRefs: readonly SchemaObjectRef[],
  onSynced: (ref: SchemaObjectRef) => Promise<void> | void
): Promise<void> {
  for (const ref of syncedRefs) {
    resultById.delete(getResultId(ref));
  }

  webview.html = renderComparisonHtml(Array.from(resultById.values()));

  for (const ref of syncedRefs) {
    await onSynced(ref);
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

function getBulkScopeLabel(
  status: FilterableComparisonStatus | undefined,
  schema?: string,
  kind?: SchemaComparisonRef['kind']
): string {
  const parts = [
    schema ? `schema ${schema}` : undefined,
    kind ? `type ${getTypeLabel(kind)}` : undefined,
    status ? getStatusLabel(status).toLowerCase() : undefined
  ]
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${parts.join(', ')} ` : '';
}

function getTypeLabel(kind: SchemaComparisonRef['kind']): string {
  switch (kind) {
    case 'schema':
      return 'Schema';
    case 'table':
      return 'Table';
    case 'view':
      return 'View';
    case 'materializedView':
      return 'Materialized View';
    case 'index':
      return 'Index';
    case 'function':
      return 'Function';
    case 'procedure':
      return 'Procedure';
    case 'sequence':
      return 'Sequence';
    case 'trigger':
      return 'Trigger';
    case 'type':
      return 'Type';
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

function getResultId(ref: SchemaComparisonRef): string {
  return `${ref.kind}:${ref.schema}:${ref.name}:${isSchemaRef(ref) ? '' : ref.identityArguments ?? ''}`;
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
