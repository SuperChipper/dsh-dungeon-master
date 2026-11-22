import { describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { ACK } from '../dnd/turn-buttons.ts';
import { dispatchInteraction } from './interaction.ts';

function eventWithData(buttonData: unknown): InteractionEvent {
  return {
    id: 'evt-1',
    scene: 'group',
    group_openid: 'G1',
    user_openid: 'U1',
    data: { resolved: { button_data: buttonData as string } },
  } as unknown as InteractionEvent;
}

describe('gateway/dispatchInteraction', () => {
  it('按顶层 t 字段精准分发到 dnd / access / browser-access / image-gen-access / persona / question / approval', () => {
    const manager = {
      questionChannel: { handleInteraction: vi.fn(() => true) },
      approvalChannel: { handleInteraction: vi.fn(() => false) },
    };
    const dndButtons = { handleInteraction: vi.fn(() => 4) };
    const toolAccess = { handleInteraction: vi.fn(() => 0) };
    const browserAccess = { handleInteraction: vi.fn(() => 0) };
    const imageGenAccess = { handleInteraction: vi.fn(() => 4) };
    const personaSwitch = { handleInteraction: vi.fn(() => 0) };
    const groupAccess = { browser: browserAccess, imageGen: imageGenAccess };

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'dnd', a: 'end' })), manager as never, dndButtons as never, toolAccess as never, groupAccess as never, personaSwitch as never)).toBe(4);
    expect(dndButtons.handleInteraction).toHaveBeenCalledTimes(1);

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'access', op: 'grant' })), manager as never, dndButtons as never, toolAccess as never, groupAccess as never, personaSwitch as never)).toBe(0);
    expect(toolAccess.handleInteraction).toHaveBeenCalledTimes(1);

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'browser-access' })), manager as never, dndButtons as never, toolAccess as never, groupAccess as never, personaSwitch as never)).toBe(0);
    expect(browserAccess.handleInteraction).toHaveBeenCalledTimes(1);

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'image-gen-access' })), manager as never, dndButtons as never, toolAccess as never, groupAccess as never, personaSwitch as never)).toBe(4);
    expect(imageGenAccess.handleInteraction).toHaveBeenCalledTimes(1);

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'persona', p: 'cat' })), manager as never, dndButtons as never, toolAccess as never, groupAccess as never, personaSwitch as never)).toBe(0);
    expect(personaSwitch.handleInteraction).toHaveBeenCalledTimes(1);

    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'question', q: '1' })), manager as never)).toBe(ACK.ok);
    expect(manager.questionChannel.handleInteraction).toHaveBeenCalledTimes(1);

    // approvalChannel 返回 false 时回 ACK.duplicate
    expect(dispatchInteraction(eventWithData(JSON.stringify({ t: 'approval', id: 'a1' })), manager as never)).toBe(ACK.duplicate);
    expect(manager.approvalChannel.handleInteraction).toHaveBeenCalledTimes(1);
  });

  it('缺少或无效 button_data 时安全返回 ACK.duplicate', () => {
    const manager = {};
    expect(dispatchInteraction(eventWithData(undefined), manager as never)).toBe(ACK.duplicate);
    expect(dispatchInteraction(eventWithData('not-json'), manager as never)).toBe(ACK.duplicate);
  });
});
