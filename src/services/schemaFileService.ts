import * as path from 'path';
import * as vscode from 'vscode';
import {
  schemaObjectFolderByKind,
  schemaObjectKindByFolder,
  SchemaObjectDefinition,
  SchemaObjectRef
} from '../model/schemaObject';

export class SchemaFileService {
  public constructor(
    private readonly workspaceFolder: vscode.WorkspaceFolder | undefined,
    private readonly schemaFolderName: string,
    private readonly defaultSchema: string
  ) {}

  public resolveObjectRefFromFile(fileUri: vscode.Uri): SchemaObjectRef {
    if (!this.schemaFolderName) {
      throw new Error('Configure a schema folder before comparing local SQL files.');
    }

    const relativePath = path.relative(this.schemaRoot.fsPath, fileUri.fsPath);
    const parts = relativePath.split(path.sep);

    if (parts.length < 2) {
      throw new Error(`SQL file must be inside ${this.schemaFolderName}/<Schema>/<Object Folder>. Supported folders: ${formatSupportedFolders()}.`);
    }

    const schemaFolderKind = schemaObjectKindByFolder.get(parts[0].toLowerCase());
    const kind = schemaFolderKind ?? schemaObjectKindByFolder.get(parts[1]?.toLowerCase());
    if (!kind) {
      throw new Error(`Unsupported schema object folder in path: ${relativePath}.`);
    }

    const parsed = path.parse(parts[parts.length - 1]);
    if (parsed.ext.toLowerCase() !== '.sql') {
      throw new Error('Select a .sql file to compare with the live database.');
    }

    const nameWithoutSignature = parsed.name.split('__')[0];
    const nameParts = nameWithoutSignature.split('.');
    const schema = schemaFolderKind
      ? nameParts.length > 1 ? nameParts[0] : this.defaultSchema
      : parts[0];
    const name = schemaFolderKind && nameParts.length > 1
      ? nameParts.slice(1).join('.')
      : nameWithoutSignature;

    return {
      kind,
      schema,
      name
    };
  }

  public getLocalObjectUri(ref: SchemaObjectRef): vscode.Uri {
    if (!this.schemaFolderName) {
      throw new Error('Configure a schema folder before reading or writing local SQL files.');
    }

    const folderName = schemaObjectFolderByKind[ref.kind];
    const safeObjectName = sanitizeFileSegment(ref.name);
    const safeSchemaName = sanitizeFileSegment(ref.schema);
    const safeIdentity = ref.identityArguments ? `__${sanitizeFileSegment(ref.identityArguments)}` : '';
    const fileName = `${safeObjectName}${safeIdentity}.sql`;

    return vscode.Uri.file(path.join(this.schemaRoot.fsPath, safeSchemaName, folderName, fileName));
  }

  public getSchemaRootUri(): vscode.Uri {
    if (!this.schemaFolderName) {
      throw new Error('Configure a schema folder before revealing local schema files.');
    }

    return this.schemaRoot;
  }

  public getLocalSchemaUri(schema: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getSchemaRootUri(), sanitizeFileSegment(schema));
  }

  public getLocalObjectKindFolderUri(schema: string, kind: SchemaObjectRef['kind']): vscode.Uri {
    return vscode.Uri.joinPath(this.getLocalSchemaUri(schema), schemaObjectFolderByKind[kind]);
  }

  public async readLocalFile(fileUri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return Buffer.from(bytes).toString('utf8');
  }

  public async tryReadLocalFile(fileUri: vscode.Uri): Promise<string | undefined> {
    try {
      return await this.readLocalFile(fileUri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        return undefined;
      }

      throw error;
    }
  }

  public async listLocalObjects(): Promise<SchemaObjectRef[]> {
    if (!this.schemaFolderName) {
      throw new Error('Configure a schema folder before comparing local SQL files.');
    }

    const objects: SchemaObjectRef[] = [];

    const schemaFolders = await this.tryReadDirectory(this.schemaRoot);

    for (const [schemaName, schemaFileType] of schemaFolders) {
      if (schemaFileType !== vscode.FileType.Directory) {
        continue;
      }

      for (const folderName of Object.values(schemaObjectFolderByKind)) {
        const folderUri = vscode.Uri.joinPath(this.schemaRoot, schemaName, folderName);
        const files = await this.tryReadDirectory(folderUri);

        for (const [fileName, fileType] of files) {
          if (fileType !== vscode.FileType.File || !fileName.toLowerCase().endsWith('.sql')) {
            continue;
          }

          objects.push(this.resolveObjectRefFromFile(vscode.Uri.joinPath(folderUri, fileName)));
        }
      }
    }

    for (const folderName of Object.values(schemaObjectFolderByKind)) {
      const legacyFolderUri = vscode.Uri.joinPath(this.schemaRoot, folderName);
      const legacyFiles = await this.tryReadDirectory(legacyFolderUri);

      for (const [fileName, fileType] of legacyFiles) {
        if (fileType !== vscode.FileType.File || !fileName.toLowerCase().endsWith('.sql')) {
          continue;
        }

        objects.push(this.resolveObjectRefFromFile(vscode.Uri.joinPath(legacyFolderUri, fileName)));
      }
    }

    return objects.sort((left, right) => objectKey(left).localeCompare(objectKey(right)));
  }

  public async writeLocalDefinition(definition: SchemaObjectDefinition): Promise<vscode.Uri> {
    const fileUri = this.getLocalObjectUri(definition);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fileUri.fsPath)));
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(definition.ddl, 'utf8'));
    return fileUri;
  }

  public async deleteLocalDefinition(ref: SchemaObjectRef): Promise<vscode.Uri> {
    const fileUri = this.getLocalObjectUri(ref);
    await vscode.workspace.fs.delete(fileUri, { useTrash: true });
    return fileUri;
  }

  public async deleteLocalFile(fileUri: vscode.Uri): Promise<vscode.Uri> {
    await vscode.workspace.fs.delete(fileUri, { useTrash: true });
    return fileUri;
  }

  private get schemaRoot(): vscode.Uri {
    if (path.isAbsolute(this.schemaFolderName)) {
      return vscode.Uri.file(this.schemaFolderName);
    }

    if (!this.workspaceFolder) {
      throw new Error('Choose an absolute schema folder or open a workspace folder before using a relative schema folder.');
    }

    return vscode.Uri.file(path.join(this.workspaceFolder.uri.fsPath, this.schemaFolderName));
  }

  private async tryReadDirectory(folderUri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      return await vscode.workspace.fs.readDirectory(folderUri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        return [];
      }

      throw error;
    }
  }
}

function objectKey(ref: SchemaObjectRef): string {
  return `${ref.kind}:${ref.schema}.${ref.name}:${ref.identityArguments ?? ''}`;
}

function sanitizeFileSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSupportedFolders(): string {
  return Object.values(schemaObjectFolderByKind).join(', ');
}
