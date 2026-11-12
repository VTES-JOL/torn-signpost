import type { Meta, StoryObj } from '@storybook/react-vite';
import { Scenario } from '../stories/fixtures.tsx';
import { ConsolePanel } from './ConsolePanel.tsx';

/**
 * The command console (GAME-13, UX-12): the same commands as the table, typed. Try `next`,
 * `action A:ready:1 B` or `help`; commands play on from the scenario's minion phase.
 */
const meta = {
  title: 'Game/ConsolePanel',
  decorators: [(Story) => <div style={{ maxWidth: 420 }}>{Story()}</div>],
} satisfies Meta;
export default meta;

export const MinionPhase: StoryObj<typeof meta> = {
  render: () => (
    <Scenario name="real-cards/02-bleed-and-block" line={31}>
      {({ client, snapshot, catalog }) => (
        <ConsolePanel client={client} snapshot={snapshot} catalog={catalog} />
      )}
    </Scenario>
  ),
};
