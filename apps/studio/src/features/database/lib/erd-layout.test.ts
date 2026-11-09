import { describe, expect, it } from 'vitest';
import { dependencyDepths, edgePath, ERD, layoutNodes } from '@/features/database/lib/erd-layout';

const node = (id: string, ...columns: string[]) => ({ id, columns: columns.map(name => ({ name })) });
const fk = (fromTable: string, fromColumn: string, toTable: string, toColumn = 'id') => ({ fromTable, fromColumn, toTable, toColumn });

describe('erd layout', () => {
  it('places referenced tables left of the tables that reference them', () => {
    const nodes = [node('order_items', 'id', 'order_id'), node('orders', 'id', 'user_id'), node('users', 'id')];
    const edges = [fk('order_items', 'order_id', 'orders'), fk('orders', 'user_id', 'users')];
    const depths = dependencyDepths(nodes, edges);
    expect([depths.get('users'), depths.get('orders'), depths.get('order_items')]).toEqual([0, 1, 2]);

    const positions = layoutNodes(nodes, edges);
    expect(positions.get('users')!.x).toBeLessThan(positions.get('orders')!.x);
    expect(positions.get('orders')!.x).toBeLessThan(positions.get('order_items')!.x);
  });

  it('terminates on cycles and self-references', () => {
    const nodes = [node('a', 'id', 'b_id'), node('b', 'id', 'a_id'), node('tree', 'id', 'parent_id')];
    const edges = [fk('a', 'b_id', 'b'), fk('b', 'a_id', 'a'), fk('tree', 'parent_id', 'tree')];
    const depths = dependencyDepths(nodes, edges);
    expect(depths.get('tree')).toBe(0);
    expect(depths.size).toBe(3);
  });

  it('stacks tables of one depth without overlap', () => {
    const nodes = [node('a', 'id', 'x', 'y'), node('b', 'id')];
    const positions = layoutNodes(nodes, []);
    expect(positions.get('b')!.y).toBe(positions.get('a')!.y + ERD.headerHeight + 3 * ERD.rowHeight + ERD.rowGap);
  });

  it('draws an edge from the referencing column row to the referenced one', () => {
    const nodes = [node('orders', 'id', 'user_id'), node('users', 'id')];
    const edges = [fk('orders', 'user_id', 'users')];
    const positions = layoutNodes(nodes, edges);
    const path = edgePath(edges[0], new Map(nodes.map(n => [n.id, n])), positions)!;
    const userIdRow = positions.get('orders')!.y + ERD.headerHeight + ERD.rowHeight * 1.5;
    // Starts on the left edge of `orders` (users sits to its left), at the user_id row.
    expect(path.startsWith(`M ${positions.get('orders')!.x} ${userIdRow}`)).toBe(true);
    expect(edgePath(fk('orders', 'user_id', 'missing'), new Map(nodes.map(n => [n.id, n])), positions)).toBeNull();
  });
});
