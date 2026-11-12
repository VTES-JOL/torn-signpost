import type { Meta, StoryObj } from '@storybook/react-vite';
import { Scenario } from '../stories/fixtures.tsx';
import { EndGameControls, endingOf, GameOver, ResultPanel } from './GameEnd.tsx';

/** How a game ends (GAME-09, docs/m6-plan.md M6.1, M6.6), from scenario 14: time runs out. */
const meta = {
  title: 'Game/GameEnd',
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

const alice = { kind: 'player', seat: 'A' } as const;

/** The table's Game over panel, for everyone watching. */
export const GameOverPanel: Story = {
  render: () => (
    <Scenario name="14-game-end" viewer={alice}>
      {({ view, seatName }) => <GameOver view={view} seatName={seatName} />}
    </Scenario>
  ),
};

/** On a game's result page; counted games link to each player's page (M6.3). */
export const ResultPage: Story = {
  render: () => (
    <Scenario name="14-game-end" viewer={alice}>
      {({ view, seatName }) => {
        const ending = endingOf(view, seatName);
        return ending && <ResultPanel ending={{ ...ending, counted: true }} label="Result" />;
      }}
    </Scenario>
  ),
};

/** Nobody won: everyone ended on the same VP. */
export const NobodyWon: Story = {
  render: () => (
    <Scenario name="14-game-end" viewer={alice}>
      {({ view, seatName }) => {
        const ending = endingOf(view, seatName);
        if (!ending) return null;
        const { winner: _, gameWin: __, ...rest } = ending;
        return (
          <ResultPanel
            ending={{ ...rest, standings: rest.standings.map((s) => ({ ...s, vp: 0.5 })) }}
          />
        );
      }}
    </Scenario>
  ),
};

/** A casual game: a player still in it may propose ending it, scored as a timeout. */
export const ProposeEnding: Story = {
  render: () => (
    <Scenario name="14-game-end" line={23} viewer={alice}>
      {({ view, seat, seatName, send }) => (
        <EndGameControls view={view} seat={seat} admin={false} seatName={seatName} send={send} />
      )}
    </Scenario>
  ),
};

/** Bob proposed ending it: the others agree or play on. */
export const ProposalOpen: Story = {
  render: () => (
    <Scenario
      name="14-game-end"
      line={23}
      viewer={alice}
      adjust={(v) => ({ ...v, endProposal: { by: 'B', agreed: ['B'] } })}
    >
      {({ view, seat, seatName, send }) => (
        <EndGameControls view={view} seat={seat} admin={false} seatName={seatName} send={send} />
      )}
    </Scenario>
  ),
};

/** A server admin may end any game. */
export const AdminEnds: Story = {
  render: () => (
    <Scenario name="14-game-end" line={23} viewer={{ kind: 'spectator' }}>
      {({ view, seat, seatName, send }) => (
        <EndGameControls view={view} seat={seat} admin seatName={seatName} send={send} />
      )}
    </Scenario>
  ),
};
