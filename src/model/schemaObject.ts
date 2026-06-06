export const schemaObjectKinds = [
  'table',
  'view',
  'materializedView',
  'index',
  'function',
  'procedure',
  'sequence',
  'trigger',
  'type'
] as const;

export type SchemaObjectKind = typeof schemaObjectKinds[number];

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
  view: 'Views',
  materializedView: 'Materialized Views',
  index: 'Indexes',
  function: 'Functions',
  procedure: 'Procedures',
  sequence: 'Sequences',
  trigger: 'Triggers',
  type: 'Types'
};

export const schemaObjectKindByFolder = new Map<string, SchemaObjectKind>(
  Object.entries(schemaObjectFolderByKind).map(([kind, folder]) => [
    folder.toLowerCase(),
    kind as SchemaObjectKind
  ])
);
