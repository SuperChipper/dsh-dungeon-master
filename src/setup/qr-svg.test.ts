import { describe, it, expect } from 'vitest';
import { renderQrSvgDataUrl } from './qr-svg.ts';

describe('renderQrSvgDataUrl', () => {
  it('renders a valid base64 SVG data URL via createRequire', async () => {
    const dataUrl = await renderQrSvgDataUrl('https://q.qq.com/connect?test=1');
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(dataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
    expect(decoded).toContain('<svg');
  });
});
