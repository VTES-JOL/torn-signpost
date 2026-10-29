/**
 * A local game table for trying the engine without a server or UI. The session is a scenario
 * script (docs/console.md#scenarios) that grows one command at a time, so `.save` writes a
 * replayable golden scenario.
 */
import {
  type CardCatalog,
  type CardInstance,
  describeEvent,
  evolve,
  type GameEvent,
  type GameState,
  newGame,
  project,
  projectEvent,
  runScenario,
  type Viewer,
  ZONE_NAMES,
  type ZoneName,
  zoneId,
} from '@torn-signpost/engine';
import {
  CONSOLE_COMMANDS,
  type ConsoleContext,
  completeConsole,
} from '@torn-signpost/engine/console';

const ZONE_LABELS: Record<ZoneName, string> = {
  ready: 'ready',
  torpor: 'torpor',
  uncontrolled: 'uncontrolled',
  hand: 'hand',
  research: 'research',
  ashHeap: 'ash',
  removed: 'removed',
  library: 'library',
  crypt: 'crypt',
};

/** A three-player table with the invented test cards, opening draws already done. */
export function defaultSetup(seed: number): string {
  const seats = [
    ['A', 'alice', 'Vera Nightfall', 'Iron Ward'],
    ['B', 'bob', 'Tomas Grey', 'Quick Feed'],
    ['C', 'carol', 'Ilse Várga', 'Night Errand'],
  ];
  return [
    `seed ${seed}`,
    ...seats.flatMap(([id, user, vamp, card]) => [
      `seat ${id} ${user}`,
      `crypt ${id} "${vamp}" *6 "Tomas Grey" *6`,
      `library ${id} "${card}" *20 "Signal Fire" *20`,
    ]),
    'start',
    ...seats.flatMap(([id]) => [`${id}> draw crypt 4`, `${id}> draw 7`]),
  ].join('\n');
}

export class Session {
  private lines: string[];
  private run;
  /** Who is acting and viewing: a seat ID, `judge`, `admin` or `public`. */
  who: string;

  constructor(
    setup: string,
    private readonly catalog: CardCatalog,
  ) {
    this.lines = setup.split('\n');
    this.run = runScenario(setup, catalog);
    if (this.run.failure) {
      throw new Error(`Setup failed at line ${this.run.failure.line}: ${this.run.failure.message}`);
    }
    this.who = this.run.state.seats[0]?.id ?? 'public';
  }

  get state(): GameState {
    return this.run.state;
  }

  get script(): string {
    return `${this.lines.join('\n')}\n`;
  }

  get viewer(): Viewer {
    if (this.who === 'judge') return { kind: 'judge' };
    if (this.who === 'admin' || this.who === 'public') return { kind: 'spectator' };
    return { kind: 'player', seat: this.who };
  }

  private get context(): ConsoleContext {
    const ctx: ConsoleContext = { view: project(this.state, this.viewer), catalog: this.catalog };
    if (this.viewer.kind === 'player') ctx.seat = this.who;
    return ctx;
  }

  /** Handle one line of input; returns the lines to print. */
  execute(input: string): string[] {
    const text = input.trim();
    if (!text) return [];
    if (text.startsWith('.')) return this.meta(text);
    if (this.who === 'public') return ['Spectators cannot act. Switch with .as <seat|judge|admin>'];
    const before = this.run.events.length;
    const line = `${this.who}> ${text}`;
    const next = runScenario([...this.lines, line].join('\n'), this.catalog);
    if (next.failure) return [next.failure.message.replace(/^Parse error: /, '')];
    this.lines.push(line);
    this.run = next;
    return this.describe(next.events.slice(before));
  }

  complete(line: string): [string[], string] {
    const last = /("[^"]*|\S*)$/.exec(line)?.[1] ?? '';
    if (line.startsWith('.')) {
      const metas = ['.as', '.view', '.log', '.undo', '.save', '.script', '.help', '.quit'];
      return [metas.filter((m) => m.startsWith(line)), line];
    }
    return [completeConsole(line, this.context), last];
  }

  view(): string[] {
    const v = project(this.state, this.viewer);
    const name = (c: CardInstance | undefined) => {
      if (!c) return '?';
      const known = c.cardId && this.catalog.get(c.cardId)?.name;
      const base = known
        ? c.faceDown
          ? `${known} (face down)`
          : known
        : c.faceDown
          ? '(face down)'
          : '(hidden)';
      const marks = [
        c.locked && 'locked',
        c.contested && 'contested',
        ...Object.entries(c.counters).map(([k, n]) => `${n} ${k}`),
      ].filter(Boolean);
      return marks.length ? `${base} [${marks.join(', ')}]` : base;
    };
    const t = v.turn;
    const out = [
      t
        ? `Turn ${t.number} · ${t.seat}'s ${t.phase} phase · play passes to the ${v.turnDirection === 'toPrey' ? 'prey' : 'predator'}`
        : 'Not started',
      `Viewing as ${this.who}`,
    ];
    for (const seat of v.seats) {
      const flags = [seat.hasEdge && 'Edge', seat.ousted && 'ousted'].filter(Boolean).join(', ');
      out.push(
        '',
        `${seat.id} (${seat.occupant})  pool ${seat.pool}  VP ${seat.vp}${flags ? `  ${flags}` : ''}`,
      );
      for (const zone of ZONE_NAMES) {
        const ids = v.zones[zoneId(seat.id, zone)] ?? [];
        if (ids.length === 0) continue;
        const cards = ids.map((id) => v.cards[id]);
        if (cards.every((c) => !c?.cardId) && cards.every((c) => !c?.faceDown)) {
          const counters = cards.some((c) => c && Object.keys(c.counters).length > 0);
          if (!counters) {
            out.push(`  ${ZONE_LABELS[zone]}: ${ids.length} hidden`);
            continue;
          }
        }
        out.push(`  ${ZONE_LABELS[zone]}:`);
        cards.forEach((c, i) => {
          const host = c?.attachedTo ? `  ↳ on ${name(v.cards[c.attachedTo])}` : '';
          out.push(`    ${zone === 'ashHeap' ? 'ash' : zone}:${i + 1}  ${name(c)}${host}`);
        });
      }
    }
    return out;
  }

  private meta(text: string): string[] {
    const [cmd = '', ...args] = text.split(/\s+/);
    switch (cmd) {
      case '.as': {
        const who = args[0] ?? '';
        const ok =
          ['judge', 'admin', 'public'].includes(who) || this.state.seats.some((s) => s.id === who);
        if (!ok)
          return [`Unknown seat "${who}". Seats: ${this.state.seats.map((s) => s.id).join(', ')}`];
        this.who = who;
        return [`Now acting as ${who}`];
      }
      case '.view':
        return this.view();
      case '.log': {
        const n = Number(args[0] ?? 15);
        return this.describe(this.run.events).slice(-n);
      }
      case '.undo': {
        const last = this.lines.at(-1);
        if (!last || !/^\w+>/.test(last)) return ['Nothing to undo'];
        this.lines.pop();
        this.run = runScenario(this.lines.join('\n'), this.catalog);
        return [`Undid: ${last}`];
      }
      case '.script':
        return this.script.trimEnd().split('\n');
      case '.help':
        return [
          'Type console commands as the current seat (docs/console.md):',
          ...Object.values(CONSOLE_COMMANDS).map((s) => `  ${s.usage}`),
          'Sandbox commands:',
          '  .as <seat|judge|admin|public>  act and view as someone else',
          '  .view                          show the table as the current viewer sees it',
          '  .log [n]                       last n log lines for the current viewer',
          '  .undo                          take back the last command (sandbox only)',
          '  .save <file>                   save the session as a .scenario script',
          '  .script                        print the session script',
          '  .quit',
        ];
      default:
        return [`Unknown sandbox command ${cmd}. Try .help`];
    }
  }

  /** Log lines for events as the current viewer sees them. */
  private describe(events: GameEvent[]): string[] {
    const all = this.run.events;
    const start = all.length - events.length;
    let state = all.slice(0, start).reduce(evolve, newGame('sandbox'));
    const out: string[] = [];
    for (const ev of events) {
      const after = evolve(state, ev);
      const seen = projectEvent(state, after, ev, this.viewer);
      out.push(describeEvent(seen, project(state, this.viewer), { catalog: this.catalog }));
      state = after;
    }
    return out;
  }
}
