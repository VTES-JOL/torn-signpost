import type { GameState, InstanceId, ZoneId, ZoneName } from './model.ts';
import { ZONE_NAMES } from './model.ts';
import type { SeatId } from './seating.ts';

/** Zones whose contents are hidden from at least some players. Cards entering them are re-keyed. */
export const HIDDEN_ZONES: ReadonlySet<ZoneName> = new Set([
  'crypt',
  'library',
  'hand',
  'uncontrolled',
]);

/** Zones where minions are in play; attached cards travel with their host between these. */
export const IN_PLAY_ZONES: ReadonlySet<ZoneName> = new Set(['ready', 'torpor']);

export function zoneId(seat: SeatId, name: ZoneName): ZoneId {
  return `${seat}:${name}`;
}

export function parseZoneId(zone: ZoneId): { seat: SeatId; name: ZoneName } {
  const i = zone.lastIndexOf(':');
  return { seat: zone.slice(0, i), name: zone.slice(i + 1) as ZoneName };
}

export function isZoneName(name: string): name is ZoneName {
  return (ZONE_NAMES as readonly string[]).includes(name);
}

export function isHiddenZone(zone: ZoneId): boolean {
  return HIDDEN_ZONES.has(parseZoneId(zone).name);
}

export function zoneCards(state: GameState, zone: ZoneId): readonly InstanceId[] {
  return state.zones[zone] ?? [];
}
