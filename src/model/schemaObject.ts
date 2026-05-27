export type SchemaObjectKind = 'table' | 'function' | 'sequence' | 'view';

export interface SchemaObjectRef {
  readonly kind: SchemaObjectKind;
  readonly schema: string;
  readonly name: string;
  readonly identityArguments?: string;
}

export interface SchemaObjectDefinition extends SchemaObjectRef {
  readonly ddl: string;
}

export const schemaObjectFolderByKind: Record<SchemaObjectKind, string> = {
  table: 'Tables',
  function: 'Functions',
  sequence: 'Sequences',
  view: 'Views'
};

export const schemaObjectKindByFolder = new Map<string, SchemaObjectKind>(
  Object.entries(schemaObjectFolderByKind).map(([kind, folder]) => [
    folder.toLowerCase(),
    kind as SchemaObjectKind
  ])
);
