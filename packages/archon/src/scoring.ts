/**
 * A table's game wins and tournament points from its victory points, to the VEKN Tournament
 * Rules 3.7: a game win is at least 2 VP and more than anyone else (3.7.1); tournament points by
 * table rank, 60/48/36/24/12, a 4-player table ranking 1st, 2nd, 4th and 5th (its 3rd place is the
 * empty seat), ties sharing the points of the places they cover (3.7.3). Archon computes these
 * itself; the fake Archon uses this, and pages can preview a table with it.
 */
const FIVE = [60, 48, 36, 24, 12];
const FOUR = [60, 48, 24, 12];

export function tableResults(vps: readonly number[]): { gw: number; tp: number }[] {
  const points = vps.length === 5 ? FIVE : vps.length === 4 ? FOUR : undefined;
  if (!points) throw new Error(`A table has 4 or 5 players, not ${vps.length}`);
  const best = Math.max(...vps);
  const winners = vps.filter((v) => v === best).length;
  return vps.map((vp) => {
    const above = vps.filter((v) => v > vp).length;
    const tied = vps.filter((v) => v === vp).length;
    const shared = points.slice(above, above + tied);
    return {
      gw: vp >= 2 && vp === best && winners === 1 ? 1 : 0,
      tp: shared.reduce((a, b) => a + b, 0) / shared.length,
    };
  });
}

/**
 * Can a table have scored this? A coarse check: whole and half points only, and no more VP in
 * all than players at the table (each oust gives 1 VP; survivors at the time limit share what's
 * left, half a point each; the last one standing gets a full point). Archon's own check is
 * finer (the order of ousts); a score it refuses shows as an invalid table.
 */
export function plausibleTable(vps: readonly number[]): boolean {
  if (vps.length !== 4 && vps.length !== 5) return false;
  if (vps.some((v) => v < 0 || !Number.isInteger(v * 2))) return false;
  return vps.reduce((a, b) => a + b, 0) <= vps.length;
}

/** Tables for `n` players: as many of 5 as possible, the rest of 4 (3.1.2); none for 6, 7 or 11. */
export function tableSizes(n: number): number[] | undefined {
  const tables = Math.ceil(n / 5);
  const fours = tables * 5 - n;
  if (n < 4 || fours > tables) return undefined;
  return [...Array(tables - fours).fill(5), ...Array(fours).fill(4)];
}
