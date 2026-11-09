/** Shape returned by `GET /admin/schema/tables`, shared by every feature that reads it. */
interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}
