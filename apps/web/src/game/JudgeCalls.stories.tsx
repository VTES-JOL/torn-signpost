import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Scenario, type ScenarioProps } from '../stories/fixtures.tsx';
import { JudgeCalls } from './JudgeCalls.tsx';

/** The "Call a judge" form is opened from the table's ⋯ menu; here, from the story's args. */
function Calling(props: {
  open: boolean;
  children: (calling: boolean, set: (c: boolean) => void) => React.ReactNode;
}) {
  const [calling, setCalling] = useState(props.open);
  return <>{props.children(calling, setCalling)}</>;
}

/** Judge calls at the table (GAME-18), from scenario 13. In a scenario the judge's user is `judge`. */
const meta = {
  title: 'Game/JudgeCalls',
  render: ({ calling: open, ...args }) => (
    <Scenario {...args}>
      {({ view, seat, client, seatName, send }) => {
        const judge = client.getSnapshot().viewer.kind === 'judge';
        return (
          <Calling open={!!open}>
            {(calling, setCalling) => (
              <JudgeCalls
                view={view}
                seat={seat}
                judge={judge}
                user={judge ? 'judge' : seat && view.seats.find((s) => s.id === seat)?.occupant}
                seatName={seatName}
                send={send}
                calling={calling}
                setCalling={setCalling}
              />
            )}
          </Calling>
        );
      }}
    </Scenario>
  ),
} satisfies Meta<Omit<ScenarioProps, 'children'> & { calling?: boolean }>;
export default meta;

type Story = StoryObj<typeof meta>;

const alice = { kind: 'player', seat: 'A' } as const;
const judge = { kind: 'judge' } as const;

/** Calling a judge, from the table's ⋯ menu: a reason, who it's about, and a note. */
export const CallForm: Story = {
  args: { name: '13-judge-calls', line: 24, viewer: alice, calling: true },
};

/** Bob's rules question, waiting for a judge, as another player sees it. */
export const OpenCall: Story = { args: { name: '13-judge-calls', line: 28, viewer: alice } };

/** The same call for a judge: claim it, then rule. */
export const OpenCallAsJudge: Story = { args: { name: '13-judge-calls', line: 28, viewer: judge } };

/** Claimed: the judge who claimed it rules. */
export const Claimed: Story = { args: { name: '13-judge-calls', line: 35, viewer: judge } };

/** A deadline ran out: the game called a judge about Alice. */
export const DeadlineCall: Story = { args: { name: '13-judge-calls', line: 54, viewer: judge } };
