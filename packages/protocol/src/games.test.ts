import { describe, expect, it } from 'vitest';
import { ClientMessage, CommandRequest, PlayerCommand } from './games.ts';

describe('PlayerCommand', () => {
  it('accepts the commands the console produces', () => {
    for (const command of [
      { type: 'MoveCard', card: 'abc', to: '1:ready', faceDown: true },
      { type: 'Draw', from: 'crypt', count: 4 },
      { type: 'TransferBlood', from: { pool: '1' }, to: { card: 'abc' }, amount: 3 },
      { type: 'AdjustVp', seat: '2', delta: 0.5 },
      { type: 'SetEdge' },
      { type: 'AdvancePhase' },
    ]) {
      expect(PlayerCommand.safeParse(command).success, JSON.stringify(command)).toBe(true);
    }
  });

  it('rejects server-only commands, unknown fields and bad values', () => {
    for (const command of [
      { type: 'StartGame', gameId: 'g', format: 'standard', seats: [] },
      { type: 'Draw', count: 1, cheat: true },
      { type: 'MoveCard', card: 'abc', to: '1:pocket' },
      { type: 'AdjustPool', seat: '1', delta: 1.5 },
      { type: 'Draw', faceDown: undefined },
    ]) {
      expect(PlayerCommand.safeParse(command).success, JSON.stringify(command)).toBe(false);
    }
  });
});

describe('requests and messages', () => {
  it('requires a well-formed command ID', () => {
    const command = { type: 'AdvancePhase' };
    expect(CommandRequest.safeParse({ commandId: 'a1b2c3d4', command }).success).toBe(true);
    expect(CommandRequest.safeParse({ commandId: 'short', command }).success).toBe(false);
  });

  it('parses WebSocket client messages', () => {
    expect(ClientMessage.parse({ type: 'subscribe', gameId: 'g1' })).toEqual({
      type: 'subscribe',
      gameId: 'g1',
    });
    expect(ClientMessage.safeParse({ type: 'shout' }).success).toBe(false);
  });
});
