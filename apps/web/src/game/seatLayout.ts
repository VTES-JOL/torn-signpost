/**
 * Where opponents sit on screen, as at a real table seen from your chair: your prey on your left,
 * your predator on your right, everyone else across the table in clockwise order (left to right).
 */
export interface SeatPlacement {
  seat: string;
  /** 1-based grid row and column. */
  row: number;
  column: number;
}

export interface SeatLayout {
  columns: number;
  /** In clockwise order from your left, which is also the reading order on narrow screens. */
  placements: SeatPlacement[];
}

/**
 * @param clockwise opponents in clockwise order from the seat after yours
 * @param preyOf your prey (the next live seat clockwise), if any
 * @param predatorOf your predator (the next live seat anticlockwise), if any
 */
export function seatLayout(clockwise: string[], preyOf?: string, predatorOf?: string): SeatLayout {
  const sides = new Set([preyOf, predatorOf].filter((s): s is string => s !== undefined));
  const across = clockwise.filter((s) => !sides.has(s));
  const left = preyOf ? [preyOf] : [];
  const right = predatorOf && predatorOf !== preyOf ? [predatorOf] : [];
  // Few enough seats for one row: left, across, right.
  if (across.length <= 1) {
    const row = [...left, ...across, ...right];
    return {
      columns: Math.max(row.length, 1),
      placements: row.map((seat, i) => ({ seat, row: 1, column: i + 1 })),
    };
  }
  // Otherwise the far side of the table on top, your neighbours beside you below it.
  const columns = across.length;
  return {
    columns,
    placements: [
      ...left.map((seat) => ({ seat, row: 2, column: 1 })),
      ...across.map((seat, i) => ({ seat, row: 1, column: i + 1 })),
      ...right.map((seat) => ({ seat, row: 2, column: columns })),
    ],
  };
}
