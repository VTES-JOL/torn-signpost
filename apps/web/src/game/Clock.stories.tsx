import type { Meta, StoryObj } from '@storybook/react-vite';
import type { GameState } from '@torn-signpost/engine';
import { Scenario, type ScenarioProps } from '../stories/fixtures.tsx';
import { Clock } from './Clock.tsx';

/**
 * The table timer (TEMPO-03) and pauses (TEMPO-05), from scenarios 12 and 14. The clock's and the
 * pause's timestamps are moved to the present, so a running clock ticks from its last start and a
 * pause counts down from its full length.
 */
const meta = {
  title: 'Game/Clock',
  render: (args) => (
    <Scenario {...args} adjust={toNow}>
      {({ view, seat, client, seatName, send }) => (
        <Clock
          view={view}
          seat={seat}
          judge={client.getSnapshot().viewer.kind === 'judge'}
          seatName={seatName}
          send={send}
        />
      )}
    </Scenario>
  ),
} satisfies Meta<Omit<ScenarioProps, 'children'>>;
export default meta;

type Story = StoryObj<typeof meta>;

/** Shifts the clock's and the pause's timestamps so that their anchor is now. */
function toNow(view: GameState): GameState {
  const clock = view.clock;
  const anchor = view.pause?.since ?? clock?.runningSince;
  if (!clock || !anchor) return view;
  const by = Date.now() - Date.parse(anchor);
  const shift = (t: string) => new Date(Date.parse(t) + by).toISOString();
  return {
    ...view,
    clock: { ...clock, ...(clock.runningSince ? { runningSince: shift(clock.runningSince) } : {}) },
    ...(view.pause
      ? { pause: { ...view.pause, since: shift(view.pause.since), until: shift(view.pause.until) } }
      : {}),
  };
}

const alice = { kind: 'player', seat: 'A' } as const;

/** Everyone is at the table: the clock runs (from its last start), and a player may pause. */
export const Running: Story = { args: { name: '12-clock-and-deadlines', line: 27, viewer: alice } };

/** Bob paused the game: he may resume it early. */
export const PausedByYou: Story = {
  args: { name: '12-clock-and-deadlines', line: 32, viewer: { kind: 'player', seat: 'B' } },
};

/** Paused by someone else: the time left on the pause. */
export const PausedBySomeoneElse: Story = {
  args: { name: '12-clock-and-deadlines', line: 32, viewer: alice },
};

/** Judges pause as long as needed, and resume anyone's pause. */
export const AsJudge: Story = {
  args: { name: '12-clock-and-deadlines', line: 32, viewer: { kind: 'judge' } },
};

/** Not everyone is at the table yet: the clock waits. */
export const WaitingForPlayers: Story = {
  args: { name: '12-clock-and-deadlines', line: 18, viewer: alice },
};

/** Time is up: the game ends at the end of the phase. */
export const TimeUp: Story = { args: { name: '14-game-end', line: 27, viewer: alice } };
