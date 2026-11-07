import { describe, expect, it } from 'vitest';
import { exitBetween, exitsOf, type RoomGraph } from './dungeon.ts';

const room = (id: string, exits: RoomGraph['rooms'][number]['exits']) => ({
  id, name: id, x: 0, y: 0, w: 1, h: 1, playerView: '', dmNotes: '', exits,
});

const graph: RoomGraph = {
  rooms: [
    room('hall', [{ to: 'pit', label: '陷坑', oneWay: true }, { to: 'vault', label: '铁门' }]),
    room('pit', []),
    room('vault', []),
  ],
} as RoomGraph;

describe('oneWay exits', () => {
  it('can be taken from the room that declares them', () => {
    expect(exitBetween(graph, 'hall', 'pit')?.label).toBe('陷坑');
    expect(exitsOf(graph, 'hall').map((e) => e.to)).toContain('pit');
  });

  it('do not lead back', () => {
    expect(exitBetween(graph, 'pit', 'hall')).toBeUndefined();
    expect(exitsOf(graph, 'pit')).toEqual([]);
  });

  it('leave ordinary exits two-way', () => {
    expect(exitBetween(graph, 'vault', 'hall')?.to).toBe('hall');
    expect(exitsOf(graph, 'vault').map((e) => e.to)).toEqual(['hall']);
  });
});
