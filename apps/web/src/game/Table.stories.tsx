import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { GameFrame, Scenario, type ScenarioProps } from '../stories/fixtures.tsx';
import { Table } from './Table.tsx';

/**
 * The game table, at moments from the real-card scenarios in packages/engine/scenarios/real-cards
 * (the same scripts as the Replay page). Everything is playable: what you do here plays on from
 * that moment, and the commands show in the Actions panel.
 */
const meta = {
  title: 'Game/Table',
  parameters: { layout: 'fullscreen' },
  args: { as: 'A' },
  argTypes: {
    name: { description: 'A script in packages/engine/scenarios' },
    as: { control: 'select', options: ['A', 'B', 'C', 'D', 'judge', 'spectator'] },
    line: { control: 'number', description: 'Show the game after this line of the script' },
  },
  render: ({ as, ...args }) => (
    <TableAt
      {...args}
      viewer={as === 'judge' || as === 'spectator' ? { kind: as } : { kind: 'player', seat: as }}
    />
  ),
} satisfies Meta<Args>;
export default meta;

type Story = StoryObj<typeof meta>;

/** Whose view: a seat, the judge or a spectator. */
type As = 'A' | 'B' | 'C' | 'D' | 'judge' | 'spectator';
type Args = Pick<ScenarioProps, 'name' | 'line'> & { as: As };

function TableAt(props: Omit<ScenarioProps, 'children'>) {
  const [error, setError] = useState<string>();
  return (
    <Scenario {...props}>
      {({ client, snapshot, catalog }) => (
        <GameFrame>
          {error && (
            <p className="toast" role="alert">
              {error}
            </p>
          )}
          <Table
            client={client}
            snapshot={snapshot}
            catalog={catalog}
            judge={snapshot.viewer.kind === 'judge'}
            onError={setError}
            live={false}
          />
        </GameFrame>
      )}
    </Scenario>
  );
}

/** Just after the start: four uncontrolled vampires each, seven cards in hand. */
export const GameStart: Story = { args: { name: 'real-cards/01-first-turn', line: 23 } };

/** A few turns in: masters in play and blood on the first vampires. */
export const AfterTheFirstRound: Story = { args: { name: 'real-cards/01-first-turn' } };

/** Alice bleeds Bob; Bob decides whether to block. */
export const BlockDecision: Story = {
  args: { name: 'real-cards/02-bleed-and-block', line: 36, as: 'B' },
};

/** Combat in steps: Theo Bell's .44 Magnum at long range against Beast. */
export const Combat: Story = { args: { name: 'real-cards/05-combat-with-cards', line: 54 } };

/** A referendum, mid-vote: the panel tallies the votes cast so far. */
export const Referendum: Story = {
  args: { name: 'real-cards/08-referendum', line: 55, as: 'C' },
};

/** A blood hunt: the prisci block's ballots decide 3 votes. */
export const BloodHunt: Story = {
  args: { name: 'real-cards/09-blood-hunt', line: 53, as: 'D' },
};

/** After Bob is ousted: what he controlled has left the game; what others took stays. */
export const AfterAnOusting: Story = { args: { name: 'real-cards/04-ousting' } };

/** The table as the judge sees it. */
export const AsJudge: Story = {
  args: { name: 'real-cards/05-combat-with-cards', line: 54, as: 'judge' },
};

/** A spectator sees only public information. */
export const AsSpectator: Story = {
  args: { name: 'real-cards/05-combat-with-cards', line: 54, as: 'spectator' },
};
