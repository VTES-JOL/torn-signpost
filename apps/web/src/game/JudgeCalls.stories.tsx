import type { Meta, StoryObj } from '@storybook/react-vite';
import { Scenario, type ScenarioProps } from '../stories/fixtures.tsx';
import { JudgeCalls } from './JudgeCalls.tsx';

/** Judge calls at the table (GAME-18), from scenario 13. In a scenario the judge's user is `judge`. */
const meta = {
  title: 'Game/JudgeCalls',
  render: (args) => (
    <Scenario {...args}>
      {({ view, seat, client, seatName, send }) => {
        const judge = client.getSnapshot().viewer.kind === 'judge';
        return (
          <JudgeCalls
            view={view}
            seat={seat}
            judge={judge}
            user={judge ? 'judge' : seat && view.seats.find((s) => s.id === seat)?.occupant}
            seatName={seatName}
            send={send}
          />
        );
      }}
    </Scenario>
  ),
} satisfies Meta<Omit<ScenarioProps, 'children'>>;
export default meta;

type Story = StoryObj<typeof meta>;

const alice = { kind: 'player', seat: 'A' } as const;
const judge = { kind: 'judge' } as const;

/** No call open: a player may call a judge, with a reason and a note. */
export const NoCalls: Story = { args: { name: '13-judge-calls', line: 24, viewer: alice } };

/** Bob's rules question, waiting for a judge, as another player sees it. */
export const OpenCall: Story = { args: { name: '13-judge-calls', line: 28, viewer: alice } };

/** The same call for a judge: claim it, then rule. */
export const OpenCallAsJudge: Story = { args: { name: '13-judge-calls', line: 28, viewer: judge } };

/** Claimed: the judge who claimed it rules. */
export const Claimed: Story = { args: { name: '13-judge-calls', line: 35, viewer: judge } };

/** A deadline ran out: the game called a judge about Alice. */
export const DeadlineCall: Story = { args: { name: '13-judge-calls', line: 54, viewer: judge } };
