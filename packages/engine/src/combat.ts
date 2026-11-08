/**
 * Combat rules the engine applies (docs/flow.md, "Combat"; docs/m6-plan.md M6.4b, C5): which
 * strikes land, the damage they're about to do, and what a minion does with the damage it takes.
 * Card effects stay with the players: a strike is what its Methuselah declared.
 */
import type { CardCatalog } from './catalog.ts';
import type { CardInstance, CombatState, InstanceId, PendingDamage, Strike } from './model.ts';

type Exchange = CombatState['strikes'];

/** Whether a strike can reach at this range: only ranged ones at long range. */
function inRange(s: Strike, range: CombatState['range']): boolean {
  if (range === 'close') return true;
  return !!s.ranged || s.kind === 'dodge' || s.kind === 'combat-ends' || s.kind === 'other';
}

/** A combat-ends strike that lands: the combat ends before any other strike resolves. */
export function combatEndsStruck(c: CombatState): boolean {
  return c.strikes.some((x) => x.strike.kind === 'combat-ends');
}

/** Strikes that do damage or steal blood and reach their target: not dodged, in range. */
function landing(c: CombatState, strikes: Exchange): Exchange {
  const dodging = new Set(c.strikes.filter((x) => x.strike.kind === 'dodge').map((x) => x.minion));
  return strikes.filter((x) => {
    const k = x.strike.kind;
    if (k !== 'hand' && k !== 'damage' && k !== 'steal-blood') return false;
    if ((x.strike.amount ?? 1) <= 0) return false;
    return !dodging.has(opponentOf(c, x.minion)) && inRange(x.strike, c.range);
  });
}

export function opponentOf(c: CombatState, minion: InstanceId): InstanceId {
  return minion === c.acting ? c.opposing : c.acting;
}

/**
 * The damage pending once the strikes are in. First strikes resolve on their own first, when
 * there are others to follow (`later`); otherwise every strike resolves at once.
 */
export function pendingFrom(
  c: CombatState,
  only?: 'first' | 'normal',
): { pending: Partial<Record<InstanceId, PendingDamage>>; later: boolean } {
  const all = landing(c, c.strikes);
  const first = all.filter((x) => x.strike.first);
  const normal = all.filter((x) => !x.strike.first);
  const split = only === undefined && first.length > 0 && normal.length > 0;
  const now = only === 'normal' ? normal : only === 'first' || split ? first : all;
  const pending: Partial<Record<InstanceId, PendingDamage>> = {};
  for (const { minion, strike } of now) {
    const target = opponentOf(c, minion);
    const p = pending[target] ?? { by: minion, normal: 0, aggravated: 0, prevented: 0 };
    pending[target] = p;
    const n = strike.amount ?? 1;
    if (strike.kind === 'steal-blood') p.stolen = (p.stolen ?? 0) + n;
    else if (strike.aggravated) p.aggravated += n;
    else p.normal += n;
  }
  return { pending, later: split };
}

export interface Taken {
  damage: number;
  aggravated: number;
  /** Blood burned to mend, or for aggravated damage while wounded. */
  blood: number;
  life?: number;
  outcome: 'unhurt' | 'mended' | 'hurt' | 'torpor' | 'burned';
}

/**
 * A vampire is a crypt card; a library card in combat is an ally, with life. Without card data, a
 * minion with life counters is taken for an ally.
 */
export function isVampire(card: CardInstance, catalog: CardCatalog): boolean {
  const info = card.cardId ? catalog.get(card.cardId) : undefined;
  if (info) return info.kind === 'crypt';
  return card.counters.life === undefined;
}

/**
 * What a minion does with the damage it takes (VTES rulebook, damage; zero-vtes rules-qa 4):
 * prevention comes off aggravated damage first. A vampire mends normal damage with blood, one
 * for one; any it can't mend leaves it wounded. Aggravated damage can't be mended: the first point
 * wounds an unwounded vampire, and each point on a wounded one costs a blood, or the vampire is
 * burned. A wounded vampire goes to torpor. An ally loses a life per point, and burns at 0.
 */
export function damageTaken(card: CardInstance, p: PendingDamage, catalog: CardCatalog): Taken {
  let prevent = p.prevented;
  const aggravated = Math.max(0, p.aggravated - prevent);
  prevent = Math.max(0, prevent - p.aggravated);
  const damage = Math.max(0, p.normal - prevent);
  if (!isVampire(card, catalog)) {
    const lost = damage + aggravated;
    const life = card.counters.life ?? 0;
    const take = Math.min(lost, life);
    if (lost === 0)
      return { damage, aggravated, blood: 0, outcome: life > 0 ? 'unhurt' : 'burned' };
    return {
      damage,
      aggravated,
      blood: 0,
      life: take,
      outcome: life - lost <= 0 ? 'burned' : 'hurt',
    };
  }
  let blood = card.counters.blood ?? 0;
  const mended = Math.min(damage, blood);
  blood -= mended;
  let wounded = damage > mended;
  let burnedBlood = 0;
  let burned = false;
  for (let i = 0; i < aggravated; i++) {
    if (!wounded) wounded = true;
    else if (blood > 0) {
      blood--;
      burnedBlood++;
    } else {
      burned = true;
      break;
    }
  }
  const outcome = burned ? 'burned' : wounded ? 'torpor' : damage > 0 ? 'mended' : 'unhurt';
  return { damage, aggravated, blood: mended + burnedBlood, outcome };
}
