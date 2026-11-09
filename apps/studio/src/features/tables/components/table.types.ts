import type { FieldMeta } from '@/shared/ui/RowDrawer';
import type { SchemaTable } from '@/shared/types/schema';

export interface TableMeta {
  model: string;
  dbName: string;
  primaryKey: string;
  fields: FieldMeta[];
  schema: string;
}

export interface IndexInfo {
  name: string;
  definition: string;
  unique: boolean;
}

export interface SchemaGraph {
  nodes: Array<{
    id: string;
    table: string;
    primaryKey: string | null;
    columns: SchemaTable['columns'];
  }>;
  edges: Array<{
    constraint: string;
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
  }>;
}

export type TabId = 'data' | 'schema' | 'indexes' | 'graph' | 'policies';