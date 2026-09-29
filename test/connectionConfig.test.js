const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const values = new Map([
  ['host', 'localhost'],
  ['port', 5432],
  ['database', 'app'],
  ['username', 'postgres'],
  ['password', 'secret'],
  ['schemaFolder', 'C:\\schemas']
]);
const updates = [];
const vscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
    getConfiguration: () => ({
      get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        values.set(key, value);
      }
    })
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
const { getExtensionConfig, hasConnectionConfig, removeConnectionConfig, updateSchemaFolder } = require('../out/config');
Module._load = originalLoad;

test('removing a connection clears credentials without changing the schema folder', async () => {
  assert.equal(hasConnectionConfig(), true);
  await removeConnectionConfig();

  assert.equal(hasConnectionConfig(), false);
  assert.deepEqual(getExtensionConfig(), {
    host: '',
    port: 5432,
    database: '',
    username: '',
    password: '',
    schemaFolder: 'C:\\schemas'
  });
  assert.deepEqual(updates.map(({ key }) => key), ['host', 'port', 'database', 'username', 'password']);
  assert.ok(updates.every(({ target }) => target === vscode.ConfigurationTarget.Workspace));
});

test('choosing another folder replaces the saved path', async () => {
  await updateSchemaFolder('D:\\another-schema');
  assert.equal(getExtensionConfig().schemaFolder, 'D:\\another-schema');
});

test('connection settings use user scope when no workspace is open', async () => {
  vscode.workspace.workspaceFolders = undefined;
  updates.length = 0;

  await removeConnectionConfig();
  assert.ok(updates.every(({ target }) => target === vscode.ConfigurationTarget.Global));
});
