// Layout for the Schema Visualizer: tables as cards in columns, foreign keys
// as curves between column rows. Pure geometry, so it is tested without a DOM.

export const ERD = {
  nodeWidth: 240,
  headerHeight: 34,
  rowHeight: 24,
  columnGap: 120,
  rowGap: 32,
  padding: 32,
} as const;

export interface ErdNodeInput {
  id: string;
  columns: Array<{ name: string }>;
}

export interface ErdEdgeInput {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface Point {
  x: number;
  y: number;
}

export function nodeHeight(node: ErdNodeInput): number {
  return ERD.headerHeight + Math.max(node.columns.length, 1) * ERD.rowHeight;
}

/**
 * How many foreign-key hops separate a table from one that references
 * nothing. Referenced tables land left of the tables pointing at them, which is
 * how an ERD reads: `users` first, `orders` after, `order_items` after that.
 * A cycle (two tables referencing each other, or a self-reference) stops at
 * the first revisit instead of recursing forever.
 */
export function dependencyDepths(nodes: ErdNodeInput[], edges: ErdEdgeInput[]): Map<string, number> {
  const targets = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.fromTable === edge.toTable) continue;
    targets.set(edge.fromTable, (targets.get(edge.fromTable) ?? new Set()).add(edge.toTable));
  }
  const known = new Set(nodes.map(node => node.id));
  const depths = new Map<string, number>();

  const depthOf = (id: string, visiting: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const target of targets.get(id) ?? []) {
      if (known.has(target)) depth = Math.max(depth, depthOf(target, visiting) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };

  for (const node of nodes) depthOf(node.id, new Set());
  return depths;
}

/** Top-left corner of every card: one column per dependency depth, stacked by name. */
export function layoutNodes(nodes: ErdNodeInput[], edges: ErdEdgeInput[]): Map<string, Point> {
  const depths = dependencyDepths(nodes, edges);
  const columns = new Map<number, ErdNodeInput[]>();
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const depth = depths.get(node.id) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), node]);
  }

  const positions = new Map<string, Point>();
  for (const [depth, column] of columns) {
    let y = ERD.padding;
    for (const node of column) {
      positions.set(node.id, { x: ERD.padding + depth * (ERD.nodeWidth + ERD.columnGap), y });
      y += nodeHeight(node) + ERD.rowGap;
    }
  }
  return positions;
}

/** Where a column's row meets the card edge facing `towardsX`. */
function anchor(node: ErdNodeInput, origin: Point, column: string, towardsX: number): Point {
  const index = Math.max(node.columns.findIndex(c => c.name === column), 0);
  const y = origin.y + ERD.headerHeight + index * ERD.rowHeight + ERD.rowHeight / 2;
  const right = origin.x + ERD.nodeWidth;
  return { x: towardsX > origin.x + ERD.nodeWidth / 2 ? right : origin.x, y };
}

/**
 * SVG path of one foreign key, from the referencing column to the referenced
 * one. A self-reference loops out and back on the right edge.
 */
export function edgePath(
  edge: ErdEdgeInput,
  nodes: Map<string, ErdNodeInput>,
  positions: Map<string, Point>,
): string | null {
  const from = nodes.get(edge.fromTable);
  const to = nodes.get(edge.toTable);
  const fromAt = positions.get(edge.fromTable);
  const toAt = positions.get(edge.toTable);
  if (!from || !to || !fromAt || !toAt) return null;

  if (edge.fromTable === edge.toTable) {
    const a = anchor(from, fromAt, edge.fromColumn, Infinity);
    const b = anchor(to, toAt, edge.toColumn, Infinity);
    return `M ${a.x} ${a.y} C ${a.x + 48} ${a.y}, ${b.x + 48} ${b.y}, ${b.x} ${b.y}`;
  }

  const a = anchor(from, fromAt, edge.fromColumn, toAt.x + ERD.nodeWidth / 2);
  const b = anchor(to, toAt, edge.toColumn, fromAt.x + ERD.nodeWidth / 2);
  const bend = Math.max(Math.abs(b.x - a.x) / 2, 40);
  const out = a.x <= b.x ? 1 : -1;
  return `M ${a.x} ${a.y} C ${a.x + bend * out} ${a.y}, ${b.x - bend * out} ${b.y}, ${b.x} ${b.y}`;
}

/** Canvas size that contains every card, for the scroll area. */
export function canvasSize(nodes: ErdNodeInput[], positions: Map<string, Point>): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    const at = positions.get(node.id);
    if (!at) continue;
    width = Math.max(width, at.x + ERD.nodeWidth);
    height = Math.max(height, at.y + nodeHeight(node));
  }
  return { width: width + ERD.padding + 48, height: height + ERD.padding };
}
