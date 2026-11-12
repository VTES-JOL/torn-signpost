import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ChatMessage } from '@torn-signpost/protocol';
import { Scenario, type ScenarioGame } from '../stories/fixtures.tsx';
import { LogPanel } from './LogPanel.tsx';

/** The game log with chat interleaved (GAME-12), from the real-card combat scenario. */
const meta = {
  title: 'Game/LogPanel',
  decorators: [
    (Story) => <div style={{ height: 480, display: 'flex', maxWidth: 420 }}>{Story()}</div>,
  ],
} satisfies Meta;
export default meta;

type Story = StoryObj<typeof meta>;

/** Chat placed between the log lines, by the game's seq when it was sent. */
function withChat({ snapshot }: ScenarioGame) {
  const at = (i: number) => snapshot.log[Math.min(i, snapshot.log.length - 1)];
  const say = (i: number, user: string, name: string, text: string): ChatMessage => ({
    id: `c${i}`,
    user,
    name,
    text,
    at: at(i)?.at ?? '',
    seq: at(i)?.seq ?? 0,
  });
  return {
    ...snapshot,
    chat: [
      say(8, 'alice', 'alice', 'gl hf'),
      say(9, 'bob', 'bob', 'you too'),
      say(30, 'bob', 'bob', '@alice is that Magnum going to long range?'),
      say(31, 'alice', 'alice', 'of course'),
    ],
  };
}

/** A replay: the log only, no chat. */
export const ReplayLog: Story = {
  render: () => (
    <Scenario name="real-cards/05-combat-with-cards">
      {({ client, snapshot }) => <LogPanel client={client} snapshot={snapshot} canChat="none" />}
    </Scenario>
  ),
};

/** A player's view with chat; a message that mentions them is highlighted. */
export const WithChat: Story = {
  render: () => (
    <Scenario name="real-cards/05-combat-with-cards">
      {(game) => <LogPanel client={game.client} snapshot={withChat(game)} canChat me="alice" />}
    </Scenario>
  ),
};

/** Spectators read the chat but can't take part (GAME-16). */
export const Spectator: Story = {
  render: () => (
    <Scenario name="real-cards/05-combat-with-cards" viewer={{ kind: 'spectator' }}>
      {(game) => <LogPanel client={game.client} snapshot={withChat(game)} canChat={false} />}
    </Scenario>
  ),
};
