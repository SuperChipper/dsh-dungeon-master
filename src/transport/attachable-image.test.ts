import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attachableImageFor } from './inbound.ts';

const MEDIA = 'C:/Users/16257/Desktop/Dsh-bot/dsh-qqbot/media';
const ANIMATED_GIF = `${MEDIA}/1BFB1482D2721A67B8B3E2EB5E667049_1795615902052_1dd07d1c.gif`;
const STATIC_PNG = 'C:/Users/16257/Desktop/Dsh-bot/dsh-qqbot/stickers/cat_骑肥龙.png';

describe('attachableImageFor', () => {
  it('keeps a static image exactly as given', async () => {
    const prepared = await attachableImageFor(STATIC_PNG, '');
    expect(prepared.path).toBe(STATIC_PNG);
    expect(prepared.note).toBeUndefined();
  });

  it('swaps an animated gif for its contact sheet and adds the reading note', async () => {
    const prepared = await attachableImageFor(ANIMATED_GIF, '');
    expect(prepared.path).not.toBe(ANIMATED_GIF);
    expect(prepared.path.endsWith('_sheet.png')).toBe(true);
    expect(existsSync(prepared.path)).toBe(true);
    expect(readFileSync(prepared.path).length).toBeGreaterThan(1024);
    expect(prepared.note).toContain('宫格');
    expect(prepared.note).toContain('从左到右');
  });

  it('falls back to the original path when the file is unreadable', async () => {
    const prepared = await attachableImageFor(`${MEDIA}/does-not-exist.gif`, '');
    expect(prepared.path.endsWith('does-not-exist.gif')).toBe(true);
    expect(prepared.note).toBeUndefined();
  });
});
