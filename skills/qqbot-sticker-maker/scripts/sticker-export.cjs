'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function required(args, key) {
  if (typeof args[key] !== 'string' || args[key].trim() === '') {
    throw new Error(`Missing required --${key} <value>.`);
  }
  return args[key];
}

function pathKey(file) {
  const resolved = path.resolve(file);
  // Resolve existing ancestors too: an output-directory symlink must not disguise the input.
  if (fs.existsSync(resolved)) return normalize(fs.realpathSync(resolved));
  if (path.dirname(resolved) === resolved) throw new Error(`Cannot resolve path root: ${resolved}`);
  return normalize(path.join(pathKey(path.dirname(resolved)), path.basename(resolved)));
}

function normalize(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function alphaStats(data, width, height) {
  let transparent = 0, opaque = 0, partial = 0;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let p = 0; p < width * height; p++) {
    const alpha = data[p * 4 + 3];
    if (alpha === 0) transparent++;
    else if (alpha === 255) opaque++;
    else partial++;
    if (alpha >= 20) {
      const x = p % width, y = Math.floor(p / width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return {
    transparentPixels: transparent, opaquePixels: opaque, partialPixels: partial,
    visiblePixels: opaque + partial,
    foregroundBBox: x1 < x0 ? null : { x0, y0, x1, y1 },
  };
}

function requireCutout(stats, label) {
  if (stats.visiblePixels === 0) throw new Error(`${label} is empty (fully transparent).`);
  if (stats.transparentPixels === 0) {
    throw new Error(`${label} has no fully transparent background pixels; use process for a white-background draft.`);
  }
}

async function exportSticker(sharp, args) {
  let safeReportPath;
  try {
    const input = path.resolve(required(args, 'input'));
    const output = path.resolve(required(args, 'output'));
    const inputKey = pathKey(input);
    const reportKey = pathKey(output);
    const force = args.force === true;
    if (inputKey === reportKey) throw new Error('--output must not overwrite the input image.');
    const reportWritable = force || !fs.existsSync(output);
    const name = required(args, 'name').replace(/\.png$/i, '');
    if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || name.trim() !== name) {
      throw new Error('Invalid --name: use a filename stem without path separators or invalid characters.');
    }
    const tag = args.tag === undefined ? '' : required(args, 'tag');
    if (tag && !/^[A-Za-z0-9_-]+$/.test(tag)) throw new Error('Invalid --tag: use letters, numbers, underscores, or hyphens.');
    const stem = tag ? `${name}_${tag}` : name;
    const outDir = path.resolve(required(args, 'out-dir'));
    const previewDir = args['preview-dir'] === undefined ? outDir : path.resolve(required(args, 'preview-dir'));
    const files = {
      master1024: path.join(outDir, `${stem}_1024.png`),
      stickerPng: path.join(outDir, `${stem}.png`),
      preview: path.join(previewDir, `${stem}_preview.png`),
    };
    const keys = Object.values(files).map(pathKey);
    if (keys.includes(inputKey)) throw new Error('Export files must not overwrite the input image, even with --force.');
    if (keys.includes(reportKey)) throw new Error('--output must be distinct from all exported images.');
    if (new Set(keys).size !== keys.length) throw new Error('Export file paths must be distinct.');
    if (!reportWritable) throw new Error(`Report already exists: ${output} (choose a new --output or use --force).`);
    safeReportPath = output;
    for (const file of Object.values(files)) {
      if (!force && fs.existsSync(file)) throw new Error(`Export file already exists: ${file} (use --tag or --force).`);
    }
    const size = args.size === undefined ? 256 : Number(required(args, 'size'));
    if (!Number.isInteger(size) || size < 64 || size > 2048) throw new Error('Invalid --size: expected an integer in 64..2048.');
    const maxKb = args['max-kb'] === undefined ? 300 : Number(required(args, 'max-kb'));
    if (!Number.isFinite(maxKb) || maxKb <= 0) throw new Error('Invalid --max-kb: expected a positive finite number.');
    const metadata = await sharp(input).metadata();
    if (metadata.format !== 'png') throw new Error(`Expected a transparent PNG input, got ${metadata.format}.`);
    if ((metadata.pages || 1) > 1) throw new Error('Animated PNG input is unsupported; export a single frame first.');
    if (!metadata.hasAlpha) throw new Error('Input PNG has no alpha channel; use process for a white-background draft.');
    const source = await sharp(input).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const inputAlpha = alphaStats(source.data, source.info.width, source.info.height);
    requireCutout(inputAlpha, 'Input PNG');
    const resize = (target) => sharp(source.data, {
      raw: { width: source.info.width, height: source.info.height, channels: 4 },
    }).resize(target, target, {
      fit: 'contain', kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 9 }).toBuffer();
    const masterPng = await resize(1024);
    const finalPng = await resize(size);
    if (finalPng.length > maxKb * 1024) {
      throw new Error(`Final PNG is ${finalPng.length} bytes, exceeding --max-kb ${maxKb}.`);
    }
    const final = await sharp(finalPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const finalAlpha = alphaStats(final.data, final.info.width, final.info.height);
    requireCutout(finalAlpha, 'Final PNG');
    const pad = 24, labelHeight = 30;
    const dark = '#252830', light = '#F2F4F8';
    const darkBox = { left: pad, top: pad, width: size, height: size };
    const lightBox = { left: size + 2 * pad, top: pad, width: size, height: size };
    // Decode the exact final PNG bytes. A larger master would conceal small-text defects.
    const darkTile = await sharp(finalPng).flatten({ background: dark }).png().toBuffer();
    const lightTile = await sharp(finalPng).flatten({ background: light }).png().toBuffer();
    const previewWidth = size * 2 + pad * 3, previewHeight = size + pad * 2 + labelHeight;
    const labels = Buffer.from(`<svg width="${previewWidth}" height="${previewHeight}" xmlns="http://www.w3.org/2000/svg"><g font-family="Arial,sans-serif" font-size="12" fill="#CBD5E1"><text x="${pad}" y="${size + pad + 22}">DARK / ${size}px</text><text x="${size + 2 * pad}" y="${size + pad + 22}">LIGHT / ${size}px</text></g></svg>`);
    const previewPng = await sharp({ create: { width: previewWidth, height: previewHeight, channels: 4, background: '#181A20' } })
      .composite([{ input: darkTile, left: darkBox.left, top: darkBox.top }, { input: lightTile, left: lightBox.left, top: lightBox.top }, { input: labels, left: 0, top: 0 }])
      .png().toBuffer();
    const report = {
      ok: true, command: 'export',
      input: { path: input, width: source.info.width, height: source.info.height, alpha: inputAlpha },
      targetSize: size, files,
      final: { width: final.info.width, height: final.info.height, bytes: finalPng.length,
        sha256: crypto.createHash('sha256').update(finalPng).digest('hex'), alpha: finalAlpha },
      preview: { source: 'final PNG bytes, decoded at 1:1 pixel size', width: previewWidth, height: previewHeight,
        dark: { background: dark, ...darkBox }, light: { background: light, ...lightBox } },
      checks: { png: true, square: final.info.width === size && final.info.height === size,
        visibleContent: true, transparentBackgroundPixels: true, withinSizeLimit: true },
    };
    const artifacts = [[files.master1024, masterPng], [files.stickerPng, finalPng], [files.preview, previewPng], [output, JSON.stringify(report, null, 2) + '\n']];
    for (const [file, bytes] of artifacts) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: force ? 'w' : 'wx' });
    }
    return { ...report, reportPath: output };
  } catch (error) {
    error.exportReportPath = safeReportPath;
    throw error;
  }
}

module.exports = { exportSticker };
