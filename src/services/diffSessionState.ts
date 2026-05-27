import * as vscode from 'vscode';
import type { SchemaObjectRef } from '../model/schemaObject';
import type { DiffDirection, SchemaComparisonStatus } from './schemaDiffService';

export type DiffSession = FileDiffSession | ObjectDiffSession;

export interface FileDiffSession {
  readonly type: 'file';
  readonly localUri: vscode.Uri;
  readonly direction: DiffDirection;
}

export interface ObjectDiffSession {
  readonly type: 'object';
  readonly ref: SchemaObjectRef;
  readonly direction: DiffDirection;
  readonly status?: SchemaComparisonStatus;
}

export class DiffSessionState {
  private lastDiff: DiffSession | undefined;

  public setLastDiff(session: DiffSession): void {
    this.lastDiff = session;
  }

  public getLastDiff(): DiffSession | undefined {
    return this.lastDiff;
  }

  public clearLastDiff(): void {
    this.lastDiff = undefined;
  }
}
