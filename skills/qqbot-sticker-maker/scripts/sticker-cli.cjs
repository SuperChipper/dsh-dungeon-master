#!/usr/bin/env node
/**
 * sticker-cli.cjs
 * Deterministic local image alignment, splicing, matting, previewing, and
 * index.json registration CLI for cat, fish, Gemini, Claude, and GPT stickers.
 *
 * Zero network calls. Powered by `dsh-qqbot/node_modules/sharp`.
 * Always writes full structured results to `--output <json-path>` to keep stdout concise.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exportSticker } = require('./sticker-export.cjs');

const SKILL_ROOT = path.resolve(__dirname, '..');
const PKG_OR_PARENT_ROOT = path.resolve(SKILL_ROOT, '../..');
const OUTER_ROOT = path.resolve(SKILL_ROOT, '../../..');

function resolveDefaultStickersDir() {
  const candidates = [
    process.env.DSH_CWD ? path.join(path.resolve(process.env.DSH_CWD), 'stickers') : null,
    path.join(process.cwd(), 'stickers'),
    path.join(PKG_OR_PARENT_ROOT, 'stickers'),
    path.join(OUTER_ROOT, 'dsh-qqbot', 'stickers'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(process.cwd(), 'stickers');
}

function loadSharp() {
  const candidates = [
    path.join(PKG_OR_PARENT_ROOT, 'node_modules', 'sharp'),
    path.join(OUTER_ROOT, 'sharp'),
    path.join(OUTER_ROOT, 'dsh-qqbot', 'node_modules', 'sharp'),
    path.join(process.cwd(), 'node_modules', 'sharp'),
    path.join(process.cwd(), 'dsh-qqbot', 'node_modules', 'sharp'),
    'sharp',
  ];
  for (const modPath of candidates) {
    try {
      return require(modPath);
    } catch (_) {
      // try next candidate
    }
  }
  throw new Error(
    `Cannot resolve 'sharp'. Install optional dependency 'sharp' in your project or under ${PKG_OR_PARENT_ROOT}.`
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx !== -1) {
        const k = token.slice(2, eqIdx);
        args[k] = token.slice(eqIdx + 1);
      } else {
        const k = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          args[k] = true;
        } else {
          args[k] = next;
          i++;
        }
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function writeJsonReport(outPath, payload) {
  const abs = path.resolve(outPath);
  ensureParentDir(abs);
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return abs;
}

function fail(message, outPath, extra = {}) {
  if (outPath && typeof outPath === 'string') {
    try {
      writeJsonReport(outPath, { ok: false, error: message, ...extra });
    } catch (_) {
      // ignore secondary report error
    }
  }
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseIntList(spec, expectedLen, label) {
  const nums = String(spec)
    .split(',')
    .map((s) => Number(s.trim()));
  if (nums.length !== expectedLen || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid ${label} "${spec}" (expected ${expectedLen} comma-separated numbers).`);
  }
  return nums.map((n) => Math.round(n));
}

function parseBoxes(spec, label = 'box list') {
  if (!spec || typeof spec !== 'string') return [];
  return spec
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [x0, y0, x1, y1] = parseIntList(entry, 4, label);
      return {
        x0: Math.min(x0, x1),
        y0: Math.min(y0, y1),
        x1: Math.max(x0, x1),
        y1: Math.max(y0, y1),
      };
    });
}

function parseSeeds(spec) {
  if (!spec || typeof spec !== 'string') return [];
  return spec
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [x, y] = parseIntList(entry, 2, 'seed coordinate');
      return { x, y };
    });
}

function printHelp(subcmd) {
  const general = `Usage: node sticker-cli.cjs <subcommand> [options]

Subcommands:
  align-guide   Normalize source meme to 1024x1024, overlay coordinate grid, measure proportions, and optionally diff against a draft
  splice        Composite a newly polished local patch into a locked 1024x1024 base without global proportion drift
  process       Flood-fill white background to RGBA, detect enclosed white pockets, protect light fills, and export 1024 + target PNG + dark/light preview
  export        Preserve native alpha, export 1024 + target PNG, validate content/size, and preview final PNG pixels at 1:1
  register      Validate transparent PNG, copy to stickers/, compute sha256, and atomically update index.json

Run "node sticker-cli.cjs <subcommand> --help" for subcommand options.`;

  const helps = {
    'align-guide': `Usage: node sticker-cli.cjs align-guide --ref <path> --out-dir <dir> --output <json> [options]

Options:
  --ref <path>          Source meme reference image (single meme or sticker sheet)
  --crop "x,y,w,h"      Optional pixel crop on --ref before normalizing to 1024x1024
  --compare <path>      Optional generated draft to compare against normalized --ref (builds 3-panel overlay strip)
  --out-dir <dir>       Output directory for *_ref_1024.png, *_ref_grid.png, and *_align_compare.png
  --tag <label>         Optional filename prefix/tag (defaults to --ref basename)
  --output <json>       Required path to write JSON proportion metrics & file paths`,

    splice: `Usage: node sticker-cli.cjs splice --base <path> --patch <path> --patch-crop "x,y,w,h" --target-box "x,y,w,h" --out <png> --output <json> [options]

Options:
  --base <path>         Locked base image (normalized to 1024x1024 white canvas if not already 1024x1024)
  --patch <path>        Newly generated image containing the polished detail region
  --patch-crop "x,y,w,h" Crop box in 1024x1024 normalized patch coordinates (or raw patch pixels if --raw-patch-coords is passed)
  --target-box "x,y,w,h" Destination box on the 1024x1024 base canvas
  --clear-box "x0,y0,x1,y1;..." Optional 1024x1024 base regions filled with #FFFFFF prior to compositing (removes ghost outlines)
  --raw-patch-coords    Interpret --patch-crop in raw unscaled --patch pixel coordinates instead of 1024x1024
  --out <png>           Output path for spliced 1024x1024 PNG
  --output <json>       Required path to write JSON splice report`,

    process: `Usage: node sticker-cli.cjs process --input <path> --name <cat_xxx|fish_xxx> --out-dir <dir> --output <json> [options]

Options:
  --input <path>                White-background illustration (.jpg/.png)
  --name <stem>                 Sticker stem (e.g. cat_看书, fish_盯着你, gpt_夸夸我)
  --out-dir <dir>               Directory for <name>_1024.png and <name>.png
  --preview-dir <dir>           Directory for dark/light preview PNG (defaults to --out-dir)
  --size <int>                  Final square sticker size in px (default: 256)
  --tag <vN>                    Optional version tag to also emit <name>_<tag>_preview.png (avoids UI cache)
  --bg-hard <int>               Min RGB channel value treated as pure background white (default: 248)
  --bg-soft <int>               Min RGB channel value for 2px edge unpremultiply ramp (default: 226)
  --extra-seeds "x,y;..."       Extra 1024x1024 flood-fill seeds for enclosed background pockets
  --protect-boxes "x0,y0,x1,y1;..." 1024x1024 rectangles shielded from flood-fill (protects sclera, book pages, pale skirt pleats, maid frills)
  --gap-close-radius <int>      Dilate dark outlines by N px (0-4) when computing flood barrier to seal tiny crayon line gaps (default: 0)
  --white-border <int>          Optional outer solid #FFFFFF sticker border radius on 1024 master (default: 0 = no white border)
  --output <json>               Required path to write JSON matting & pocket-inspection report`,

    export: `Usage: node sticker-cli.cjs export --input <transparent-png> --name <stem> --out-dir <dir> --output <json> [options]

Options:
  --input <png>         Static transparent PNG (native alpha is preserved; no white flood-fill)
  --name <stem>         Output filename stem (e.g. gpt_夸夸我; optional .png suffix)
  --out-dir <dir>       Directory for <stem>_1024.png master and <stem>.png sticker
  --preview-dir <dir>   Directory for <stem>_preview.png (defaults to --out-dir)
  --size <int>          Final square sticker size, 64..2048 (default: 256)
  --tag <label>         Append a version label to ALL output image filenames
  --max-kb <number>    Max final PNG size in KiB (default: 300)
  --force              Replace existing export artifacts/report; never replace the input
  --output <json>       Required report path, distinct from input and exported images

Non-square inputs are padded transparently without stretching. Preview tiles decode
the exact final PNG at its native pixel size. Existing outputs are kept by default.`,

    register: `Usage: node sticker-cli.cjs register --input <png> --emotion <str> --look <str> --note <str> --output <json> [options]

Options:
  --input <png>         Approved transparent RGBA sticker PNG
  --file <filename>     Target filename in stickers/ (defaults to basename of --input)
  --allow-custom-prefix Allow another prefix; basename/path validation still applies
  --emotion <str>       Short emotion/intent label
  --look <str>          Objective visual description of the sticker
  --note <str>          When/why the bot should pick this sticker
  --stickers-dir <dir>  Target stickers directory (auto-detects <cwd>/stickers or plugin stickers/)
  --init                Create stickers/ and initialize an empty index.json if missing
  --auto <true|false>   Set "auto" boolean field in index.json (default: false)
  --max-kb <number>     Max allowed file size in KB before failing (default: 300)
  --allow-large         Allow registering files larger than --max-kb
  --dry-run             Validate and compute sha256 without writing to stickers/ or index.json
  --output <json>       Required path to write JSON registration report`,
  };

  console.log(helps[subcmd] || general);
}

/**
 * Estimate border background RGB by taking per-channel median along the 4 edges of an RGBA buffer.
 */
function detectBorderBgRgb(raw, width, height) {
  const rs = [];
  const gs = [];
  const bs = [];
  const pushPx = (x, y) => {
    const idx = (y * width + x) * 4;
    if (raw[idx + 3] < 25) {
      rs.push(255);
      gs.push(255);
      bs.push(255);
    } else {
      rs.push(raw[idx]);
      gs.push(raw[idx + 1]);
      bs.push(raw[idx + 2]);
    }
  };
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 128))) {
    pushPx(x, 0);
    pushPx(x, height - 1);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 128))) {
    pushPx(0, y);
    pushPx(width - 1, y);
  }
  const median = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 255;
  };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/**
 * Normalize an image (with optional crop) onto a 1024x1024 solid #FFFFFF RGB/RGBA buffer
 * (or auto-detected border background color when preserveBorderBg=true for sticker sheets).
 */
async function normalizeTo1024White(sharp, inputPath, cropSpec, preserveBorderBg = false) {
  let pipeline = sharp(path.resolve(inputPath));
  const origMeta = await pipeline.metadata();
  if (cropSpec) {
    const [left, top, width, height] = parseIntList(cropSpec, 4, '--crop');
    pipeline = sharp(path.resolve(inputPath)).extract({ left, top, width, height });
  }
  let bg = { r: 255, g: 255, b: 255 };
  if (preserveBorderBg) {
    const { data: probeRaw, info: probeInfo } = await pipeline
      .clone()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    bg = detectBorderBgRgb(probeRaw, probeInfo.width, probeInfo.height);
  }
  const buf = await pipeline
    .flatten({ background: bg })
    .resize(1024, 1024, {
      fit: 'contain',
      background: bg,
    })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { raw: buf, origWidth: origMeta.width, origHeight: origMeta.height, bg };
}

/**
 * Measure foreground bounding box and 10-band horizontal width profile on a 1024x1024 buffer
 * relative to its background color `bg` (handles white, dark-gray sticker sheets, etc.).
 */
function measureProportions1024(raw, bg = { r: 255, g: 255, b: 255 }) {
  const W = 1024;
  const H = 1024;
  let minX = W,
    minY = H,
    maxX = -1,
    maxY = -1;
  let fgPixels = 0;

  const isFg = (idx) => {
    const r = raw[idx];
    const g = raw[idx + 1];
    const b = raw[idx + 2];
    const a = raw[idx + 3];
    if (a < 25) return false;
    const dist = Math.max(Math.abs(r - bg.r), Math.abs(g - bg.g), Math.abs(b - bg.b));
    return dist > 22;
  };

  const bands = [];
  for (let b = 0; b < 10; b++) {
    const yStart = Math.round((b * H) / 10);
    const yEnd = Math.round(((b + 1) * H) / 10) - 1;
    let bMinX = W,
      bMaxX = -1,
      bCount = 0;
    for (let y = yStart; y <= yEnd; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        if (isFg(idx)) {
          fgPixels++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          bCount++;
        }
      }
    }
    bands.push({
      yRangePx: [yStart, yEnd],
      yRangePct: `${b * 10}%-${(b + 1) * 10}%`,
      leftPx: bMaxX >= bMinX ? bMinX : null,
      rightPx: bMaxX >= bMinX ? bMaxX : null,
      spanPx: bMaxX >= bMinX ? bMaxX - bMinX + 1 : 0,
      spanPct: bMaxX >= bMinX ? Number((((bMaxX - bMinX + 1) / W) * 100).toFixed(1)) : 0,
      fgPixels: bCount,
    });
  }

  if (maxX < minX) {
    return { empty: true, fgPixels: 0, bands };
  }

  const widthPx = maxX - minX + 1;
  const heightPx = maxY - minY + 1;
  return {
    empty: false,
    fgPixels,
    bboxPx: { x0: minX, y0: minY, x1: maxX, y1: maxY, width: widthPx, height: heightPx },
    bboxPct: {
      left: Number(((minX / W) * 100).toFixed(1)),
      top: Number(((minY / H) * 100).toFixed(1)),
      right: Number(((maxX / W) * 100).toFixed(1)),
      bottom: Number(((maxY / H) * 100).toFixed(1)),
      width: Number(((widthPx / W) * 100).toFixed(1)),
      height: Number(((heightPx / H) * 100).toFixed(1)),
      centerX: Number(((((minX + maxX) / 2 / W) * 100)).toFixed(1)),
      centerY: Number(((((minY + maxY) / 2 / H) * 100)).toFixed(1)),
    },
    edgeBleed: {
      touchesLeft: minX <= 8,
      touchesRight: maxX >= W - 9,
      touchesTop: minY <= 8,
      touchesBottom: maxY >= H - 9,
    },
    horizontalBands: bands,
  };
}

function buildGridSvg1024(metrics, boxColor = '#E11D48', titleText = '') {
  const lines = [];
  for (let i = 1; i < 10; i++) {
    const pos = Math.round((i * 1024) / 10);
    const pct = i * 10;
    const isMid = i === 5;
    const stroke = isMid ? 'rgba(37,99,235,0.55)' : 'rgba(59,130,246,0.32)';
    const width = isMid ? 2 : 1;
    lines.push(`<line x1="${pos}" y1="0" x2="${pos}" y2="1024" stroke="${stroke}" stroke-width="${width}" />`);
    lines.push(`<line x1="0" y1="${pos}" x2="1024" y2="${pos}" stroke="${stroke}" stroke-width="${width}" />`);
    lines.push(
      `<rect x="${pos + 2}" y="4" width="66" height="20" rx="3" fill="rgba(255,255,255,0.82)" />`,
      `<text x="${pos + 5}" y="18" font-family="Consolas, monospace" font-size="12" fill="#1E3A8A">${pct}%/${pos}</text>`,
      `<rect x="4" y="${pos + 2}" width="66" height="20" rx="3" fill="rgba(255,255,255,0.82)" />`,
      `<text x="7" y="${pos + 16}" font-family="Consolas, monospace" font-size="12" fill="#1E3A8A">${pct}%/${pos}</text>`
    );
  }
  if (metrics && !metrics.empty) {
    const { x0, y0, width, height } = metrics.bboxPx;
    lines.push(
      `<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="none" stroke="${boxColor}" stroke-width="3" stroke-dasharray="10,6" />`
    );
  }
  if (titleText) {
    lines.push(
      `<rect x="330" y="986" width="364" height="32" rx="6" fill="rgba(15,23,42,0.82)" />`,
      `<text x="512" y="1007" text-anchor="middle" font-family="Consolas, sans-serif" font-size="15" font-weight="bold" fill="#F8FAFC">${titleText}</text>`
    );
  }
  return Buffer.from(`<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${lines.join('\n')}</svg>`);
}

async function cmdAlignGuide(sharp, args) {
  const outReport = args.output;
  if (!outReport) fail('Missing required --output <json-path>.');
  if (!args.ref) fail('Missing required --ref <source-meme-path>.', outReport);
  if (!args['out-dir']) fail('Missing required --out-dir <dir>.', outReport);
  if (!fs.existsSync(path.resolve(args.ref))) {
    fail(`Reference file not found: ${args.ref}`, outReport);
  }

  const outDir = path.resolve(args['out-dir']);
  fs.mkdirSync(outDir, { recursive: true });
  const prefix = args.tag || path.parse(args.ref).name;

  const refNorm = await normalizeTo1024White(sharp, args.ref, args.crop, true);
  const refMetrics = measureProportions1024(refNorm.raw, refNorm.bg);

  const ref1024Path = path.join(outDir, `${prefix}_ref_1024.png`);
  const refGridPath = path.join(outDir, `${prefix}_ref_grid.png`);

  await sharp(refNorm.raw, { raw: { width: 1024, height: 1024, channels: 4 } })
    .png()
    .toFile(ref1024Path);

  const refGridSvg = buildGridSvg1024(refMetrics, '#E11D48', 'SOURCE MEME (1024 GRID)');
  const refGridPng = await sharp(refNorm.raw, { raw: { width: 1024, height: 1024, channels: 4 } })
    .composite([{ input: refGridSvg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  fs.writeFileSync(refGridPath, refGridPng);

  const result = {
    ok: true,
    command: 'align-guide',
    refInput: path.resolve(args.ref),
    detectedRefBgRgb: refNorm.bg,
    crop: args.crop || null,
    files: {
      ref1024: ref1024Path,
      refGrid: refGridPath,
      alignCompare: null,
    },
    refMetrics,
    compareMetrics: null,
    proportionDiff: null,
  };

  if (args.compare) {
    if (!fs.existsSync(path.resolve(args.compare))) {
      fail(`Compare draft file not found: ${args.compare}`, outReport);
    }
    const cmpNorm = await normalizeTo1024White(sharp, args.compare, null, true);
    const cmpMetrics = measureProportions1024(cmpNorm.raw, cmpNorm.bg);

    // Build tinted 50/50 overlay on clean white base: source meme fg -> rose-red, draft fg -> teal-blue
    const overlayRaw = Buffer.alloc(1024 * 1024 * 4);
    for (let i = 0; i < 1024 * 1024; i++) {
      const idx = i * 4;
      const rDist = Math.max(
        Math.abs(refNorm.raw[idx] - refNorm.bg.r),
        Math.abs(refNorm.raw[idx + 1] - refNorm.bg.g),
        Math.abs(refNorm.raw[idx + 2] - refNorm.bg.b)
      );
      const cDist = Math.max(
        Math.abs(cmpNorm.raw[idx] - cmpNorm.bg.r),
        Math.abs(cmpNorm.raw[idx + 1] - cmpNorm.bg.g),
        Math.abs(cmpNorm.raw[idx + 2] - cmpNorm.bg.b)
      );
      const refSig = rDist <= 18 ? 0 : Math.min(1, (rDist - 18) / 145);
      const cmpSig = cDist <= 18 ? 0 : Math.min(1, (cDist - 18) / 145);
      const r = Math.round(255 * (1 - 0.78 * cmpSig));
      const g = Math.round(255 * (1 - 0.75 * refSig - 0.22 * cmpSig));
      const b = Math.round(255 * (1 - 0.65 * refSig));
      overlayRaw[idx] = Math.max(0, Math.min(255, r));
      overlayRaw[idx + 1] = Math.max(0, Math.min(255, g));
      overlayRaw[idx + 2] = Math.max(0, Math.min(255, b));
      overlayRaw[idx + 3] = 255;
    }

    const overlaySvg = buildGridSvg1024(refMetrics, '#E11D48', 'OVERLAY: RED=REF / CYAN=DRAFT');
    const overlayPng = await sharp(overlayRaw, { raw: { width: 1024, height: 1024, channels: 4 } })
      .composite([{ input: overlaySvg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const cmpSvg = buildGridSvg1024(cmpMetrics, '#0284C7', 'DRAFT (1024 GRID)');
    const cmpGridPng = await sharp(cmpNorm.raw, { raw: { width: 1024, height: 1024, channels: 4 } })
      .composite([{ input: cmpSvg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const comparePath = path.join(outDir, `${prefix}_align_compare.png`);
    await sharp({
      create: {
        width: 1024 * 3 + 32,
        height: 1024,
        channels: 4,
        background: { r: 30, g: 41, b: 59, alpha: 1 },
      },
    })
      .composite([
        { input: refGridPng, left: 0, top: 0 },
        { input: overlayPng, left: 1040, top: 0 },
        { input: cmpGridPng, left: 2080, top: 0 },
      ])
      .png()
      .toFile(comparePath);

    result.files.alignCompare = comparePath;
    result.compareMetrics = cmpMetrics;
    if (!refMetrics.empty && !cmpMetrics.empty) {
      result.proportionDiff = {
        widthPctDelta: Number((cmpMetrics.bboxPct.width - refMetrics.bboxPct.width).toFixed(1)),
        heightPctDelta: Number((cmpMetrics.bboxPct.height - refMetrics.bboxPct.height).toFixed(1)),
        centerXPctDelta: Number((cmpMetrics.bboxPct.centerX - refMetrics.bboxPct.centerX).toFixed(1)),
        centerYPctDelta: Number((cmpMetrics.bboxPct.centerY - refMetrics.bboxPct.centerY).toFixed(1)),
        topPxDelta: cmpMetrics.bboxPx.y0 - refMetrics.bboxPx.y0,
        bottomPxDelta: cmpMetrics.bboxPx.y1 - refMetrics.bboxPx.y1,
        bandSpanPctDeltas: refMetrics.horizontalBands.map((rb, idx) => ({
          yRangePct: rb.yRangePct,
          refSpanPct: rb.spanPct,
          draftSpanPct: cmpMetrics.horizontalBands[idx].spanPct,
          deltaPct: Number((cmpMetrics.horizontalBands[idx].spanPct - rb.spanPct).toFixed(1)),
        })),
      };
    }
  }

  const reportAbs = writeJsonReport(outReport, result);
  console.log(`align-guide OK -> grid: ${refGridPath} | report: ${reportAbs}`);
}

async function cmdSplice(sharp, args) {
  const outReport = args.output;
  if (!outReport) fail('Missing required --output <json-path>.');
  for (const req of ['base', 'patch', 'patch-crop', 'target-box', 'out']) {
    if (!args[req]) fail(`Missing required --${req}.`, outReport);
  }
  if (!fs.existsSync(path.resolve(args.base))) fail(`Base image not found: ${args.base}`, outReport);
  if (!fs.existsSync(path.resolve(args.patch))) fail(`Patch image not found: ${args.patch}`, outReport);

  const baseNorm = await normalizeTo1024White(sharp, args.base, null);
  const baseRaw = Buffer.from(baseNorm.raw);

  const clearBoxes = parseBoxes(args['clear-box'], '--clear-box');
  for (const box of clearBoxes) {
    const x0 = Math.max(0, box.x0);
    const y0 = Math.max(0, box.y0);
    const x1 = Math.min(1023, box.x1);
    const y1 = Math.min(1023, box.y1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = (y * 1024 + x) * 4;
        baseRaw[idx] = 255;
        baseRaw[idx + 1] = 255;
        baseRaw[idx + 2] = 255;
        baseRaw[idx + 3] = 255;
      }
    }
  }

  const [cropLeft, cropTop, cropW, cropH] = parseIntList(args['patch-crop'], 4, '--patch-crop');
  const [dstLeft, dstTop, dstW, dstH] = parseIntList(args['target-box'], 4, '--target-box');

  let patchPipeline;
  if (args['raw-patch-coords']) {
    patchPipeline = sharp(path.resolve(args.patch))
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH });
  } else {
    const patchNorm = await normalizeTo1024White(sharp, args.patch, null);
    patchPipeline = sharp(patchNorm.raw, { raw: { width: 1024, height: 1024, channels: 4 } }).extract({
      left: cropLeft,
      top: cropTop,
      width: cropW,
      height: cropH,
    });
  }

  const resizedPatchPng = await patchPipeline
    .resize(dstW, dstH, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const outPngPath = path.resolve(args.out);
  ensureParentDir(outPngPath);
  await sharp(baseRaw, { raw: { width: 1024, height: 1024, channels: 4 } })
    .composite([{ input: resizedPatchPng, left: dstLeft, top: dstTop }])
    .png()
    .toFile(outPngPath);

  const reportAbs = writeJsonReport(outReport, {
    ok: true,
    command: 'splice',
    base: path.resolve(args.base),
    patch: path.resolve(args.patch),
    patchCrop: { left: cropLeft, top: cropTop, width: cropW, height: cropH },
    targetBox: { left: dstLeft, top: dstTop, width: dstW, height: dstH },
    clearedBoxes: clearBoxes,
    outFile: outPngPath,
  });
  console.log(`splice OK -> ${outPngPath} | report: ${reportAbs}`);
}

async function cmdProcess(sharp, args) {
  const outReport = args.output;
  if (!outReport) fail('Missing required --output <json-path>.');
  for (const req of ['input', 'name', 'out-dir']) {
    if (!args[req]) fail(`Missing required --${req}.`, outReport);
  }
  const inputAbs = path.resolve(args.input);
  if (!fs.existsSync(inputAbs)) fail(`Input image not found: ${args.input}`, outReport);

  const stem = String(args.name).replace(/\.(png|jpg|jpeg|webp)$/i, '');
  if (!stem || /[\\/:*?"<>|\x00-\x1f]/.test(stem) || stem === '.' || stem === '..') {
    fail('Invalid --name: expected a filename stem without path separators or invalid characters.', outReport);
  }
  const outDir = path.resolve(args['out-dir']);
  const previewDir = args['preview-dir'] ? path.resolve(args['preview-dir']) : outDir;
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });

  const targetSize = args.size !== undefined ? Number(args.size) : 256;
  if (!Number.isInteger(targetSize) || targetSize < 64 || targetSize > 2048) {
    fail(`Invalid --size "${args.size}" (expected integer 64..2048).`, outReport);
  }
  const bgHard = args['bg-hard'] !== undefined ? Number(args['bg-hard']) : 248;
  const bgSoft = args['bg-soft'] !== undefined ? Number(args['bg-soft']) : 226;
  const gapCloseRadius = args['gap-close-radius'] !== undefined ? Number(args['gap-close-radius']) : 0;
  const whiteBorder = args['white-border'] !== undefined ? Number(args['white-border']) : 0;
  const protectBoxes = parseBoxes(args['protect-boxes'], '--protect-boxes');
  const extraSeeds = parseSeeds(args['extra-seeds']);

  const W = 1024;
  const H = 1024;
  const norm = await normalizeTo1024White(sharp, inputAbs, null);
  const rgba = Buffer.from(norm.raw);

  // Build protected pixel mask
  const protectedMask = new Uint8Array(W * H);
  for (const box of protectBoxes) {
    const x0 = Math.max(0, box.x0);
    const y0 = Math.max(0, box.y0);
    const x1 = Math.min(W - 1, box.x1);
    const y1 = Math.min(H - 1, box.y1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        protectedMask[y * W + x] = 1;
      }
    }
  }

  // Optional morphological gap closing on dark outline barrier (flood barrier only; does not alter visible RGB)
  const darkBarrier = new Uint8Array(W * H);
  if (gapCloseRadius > 0) {
    const rad = Math.min(6, Math.max(0, Math.round(gapCloseRadius)));
    const rawDark = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const idx = p * 4;
      const minCh = Math.min(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
      if (minCh < 155) rawDark[p] = 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!rawDark[y * W + x]) continue;
        for (let dy = -rad; dy <= rad; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -rad; dx <= rad; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (dx * dx + dy * dy <= rad * rad) {
              darkBarrier[ny * W + nx] = 1;
            }
          }
        }
      }
    }
  }

  const canFlood = (p) => {
    if (protectedMask[p] || darkBarrier[p]) return false;
    const idx = p * 4;
    return rgba[idx] >= bgHard && rgba[idx + 1] >= bgHard && rgba[idx + 2] >= bgHard;
  };

  const bgVisited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let qHead = 0;
  let qTail = 0;

  const tryPush = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const p = y * W + x;
    if (bgVisited[p] || !canFlood(p)) return;
    bgVisited[p] = 1;
    queue[qTail++] = p;
  };

  for (let x = 0; x < W; x++) {
    tryPush(x, 0);
    tryPush(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    tryPush(0, y);
    tryPush(W - 1, y);
  }
  for (const s of extraSeeds) {
    tryPush(s.x, s.y);
  }

  while (qHead < qTail) {
    const p = queue[qHead++];
    const x = p % W;
    const y = (p - x) / W;
    if (x > 0) tryPush(x - 1, y);
    if (x + 1 < W) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y + 1 < H) tryPush(x, y + 1);
  }

  // Zero out flooded background
  for (let p = 0; p < W * H; p++) {
    if (bgVisited[p]) {
      rgba[p * 4 + 3] = 0;
    }
  }

  // 2-pass 1px edge unpremultiply ramp to eliminate white fringe on dark chat backgrounds
  for (let pass = 0; pass < 2; pass++) {
    const prevAlpha = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) prevAlpha[p] = rgba[p * 4 + 3];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (prevAlpha[p] === 0 || protectedMask[p]) continue;
        let touchesTrans = false;
        for (let dy = -1; dy <= 1 && !touchesTrans; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (prevAlpha[ny * W + nx] < 32) {
              touchesTrans = true;
              break;
            }
          }
        }
        if (!touchesTrans) continue;
        const idx = p * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const minCh = Math.min(r, g, b);
        if (minCh >= bgSoft) {
          const t = Math.max(0, Math.min(1, (bgHard - minCh) / Math.max(1, bgHard - bgSoft)));
          const newA = Math.round(prevAlpha[p] * t);
          rgba[idx + 3] = newA;
          if (newA > 8) {
            const aFrac = newA / 255;
            rgba[idx] = Math.max(0, Math.min(255, Math.round((r - 255 * (1 - aFrac)) / aFrac)));
            rgba[idx + 1] = Math.max(0, Math.min(255, Math.round((g - 255 * (1 - aFrac)) / aFrac)));
            rgba[idx + 2] = Math.max(0, Math.min(255, Math.round((b - 255 * (1 - aFrac)) / aFrac)));
          }
        }
      }
    }
  }

  // Optional outer white sticker border if explicitly requested (--white-border > 0)
  if (whiteBorder > 0) {
    const rad = Math.min(24, Math.round(whiteBorder));
    const fgMask = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      if (rgba[p * 4 + 3] >= 100) fgMask[p] = 1;
    }
    const borderMask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!fgMask[y * W + x]) continue;
        for (let dy = -rad; dy <= rad; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -rad; dx <= rad; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            if (dx * dx + dy * dy <= rad * rad) borderMask[ny * W + nx] = 1;
          }
        }
      }
    }
    for (let p = 0; p < W * H; p++) {
      if (!borderMask[p]) continue;
      const idx = p * 4;
      const a = rgba[idx + 3] / 255;
      rgba[idx] = Math.round(rgba[idx] * a + 255 * (1 - a));
      rgba[idx + 1] = Math.round(rgba[idx + 1] * a + 255 * (1 - a));
      rgba[idx + 2] = Math.round(rgba[idx + 2] * a + 255 * (1 - a));
      rgba[idx + 3] = 255;
    }
  }

  // Detect remaining enclosed pure-white pockets (outside --protect-boxes)
  const pocketVisited = new Uint8Array(W * H);
  const enclosedWhitePockets = [];
  for (let p = 0; p < W * H; p++) {
    if (pocketVisited[p] || protectedMask[p]) continue;
    const idx = p * 4;
    if (rgba[idx + 3] < 220 || rgba[idx] < bgHard || rgba[idx + 1] < bgHard || rgba[idx + 2] < bgHard) {
      continue;
    }
    // BFS component
    let head = 0;
    let tail = 0;
    queue[tail++] = p;
    pocketVisited[p] = 1;
    let sumX = 0,
      sumY = 0,
      minX = W,
      minY = H,
      maxX = 0,
      maxY = 0;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % W;
      const cy = (cur - cx) / W;
      sumX += cx;
      sumY += cy;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;

      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx + 1 < W ? cur + 1 : -1,
        cy > 0 ? cur - W : -1,
        cy + 1 < H ? cur + W : -1,
      ];
      for (const nb of neighbors) {
        if (nb < 0 || pocketVisited[nb] || protectedMask[nb]) continue;
        const nIdx = nb * 4;
        if (rgba[nIdx + 3] >= 220 && rgba[nIdx] >= bgHard && rgba[nIdx + 1] >= bgHard && rgba[nIdx + 2] >= bgHard) {
          pocketVisited[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }
    if (tail >= 25) {
      // Pick an actual pixel from the component closest to centroid so --extra-seeds hits inside
      const avgX = sumX / tail;
      const avgY = sumY / tail;
      let bestP = queue[0];
      let bestDist = Infinity;
      for (let k = 0; k < tail; k++) {
        const qp = queue[k];
        const qx = qp % W;
        const qy = (qp - qx) / W;
        const d = (qx - avgX) * (qx - avgX) + (qy - avgY) * (qy - avgY);
        if (d < bestDist) {
          bestDist = d;
          bestP = qp;
        }
      }
      const seedX = bestP % W;
      const seedY = (bestP - seedX) / W;
      enclosedWhitePockets.push({
        areaPx: tail,
        seed: `${seedX},${seedY}`,
        bbox: `${minX},${minY},${maxX},${maxY}`,
      });
    }
  }
  enclosedWhitePockets.sort((a, b) => b.areaPx - a.areaPx);

  // Foreground bounding box after matting
  let fgMinX = W,
    fgMinY = H,
    fgMaxX = -1,
    fgMaxY = -1,
    opaqueCount = 0;
  for (let p = 0; p < W * H; p++) {
    if (rgba[p * 4 + 3] >= 20) {
      opaqueCount++;
      const x = p % W;
      const y = (p - x) / W;
      if (x < fgMinX) fgMinX = x;
      if (x > fgMaxX) fgMaxX = x;
      if (y < fgMinY) fgMinY = y;
      if (y > fgMaxY) fgMaxY = y;
    }
  }

  const master1024Path = path.join(outDir, `${stem}_1024.png`);
  const finalPngPath = path.join(outDir, `${stem}.png`);

  const masterPngBuf = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(master1024Path, masterPngBuf);

  const finalPngBuf = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .resize(targetSize, targetSize, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(finalPngPath, finalPngBuf);

  // Build side-by-side Dark (#252830) & Light (#F2F4F8) preview card
  const cardSize = 480;
  const pad = 24;
  const previewCardImg = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .resize(cardSize, cardSize, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const previewSvg = Buffer.from(
    `<svg width="${cardSize * 2 + pad * 3}" height="${cardSize + pad * 2 + 34}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${cardSize * 2 + pad * 3}" height="${cardSize + pad * 2 + 34}" fill="#181A20" />
      <rect x="${pad}" y="${pad}" width="${cardSize}" height="${cardSize}" rx="14" fill="#252830" />
      <rect x="${cardSize + pad * 2}" y="${pad}" width="${cardSize}" height="${cardSize}" rx="14" fill="#F2F4F8" />
      <text x="${pad + cardSize / 2}" y="${cardSize + pad + 24}" text-anchor="middle" font-family="Consolas, sans-serif" font-size="14" fill="#CBD5E1">DARK (#252830) - ${targetSize}x${targetSize}</text>
      <text x="${cardSize + pad * 2 + cardSize / 2}" y="${cardSize + pad + 24}" text-anchor="middle" font-family="Consolas, sans-serif" font-size="14" fill="#CBD5E1">LIGHT (#F2F4F8) - ${stem}.png</text>
    </svg>`
  );

  const previewBuf = await sharp(previewSvg)
    .composite([
      { input: previewCardImg, left: pad, top: pad },
      { input: previewCardImg, left: cardSize + pad * 2, top: pad },
    ])
    .png()
    .toBuffer();

  const defaultPreviewPath = path.join(previewDir, `${stem}_preview.png`);
  fs.writeFileSync(defaultPreviewPath, previewBuf);

  let taggedPreviewPath = null;
  if (args.tag) {
    taggedPreviewPath = path.join(previewDir, `${stem}_${args.tag}_preview.png`);
    fs.writeFileSync(taggedPreviewPath, previewBuf);
  }

  const report = {
    ok: true,
    command: 'process',
    name: stem,
    targetSize,
    whiteBorder,
    files: {
      master1024: master1024Path,
      stickerPng: finalPngPath,
      stickerBytes: finalPngBuf.length,
      preview: taggedPreviewPath || defaultPreviewPath,
      defaultPreview: defaultPreviewPath,
    },
    foregroundStats: {
      opaquePixels1024: opaqueCount,
      opaqueCoveragePct: Number(((opaqueCount / (W * H)) * 100).toFixed(1)),
      bbox1024: fgMaxX >= fgMinX ? { x0: fgMinX, y0: fgMinY, x1: fgMaxX, y1: fgMaxY } : null,
    },
    enclosedWhitePocketCount: enclosedWhitePockets.length,
    enclosedWhitePockets: enclosedWhitePockets.slice(0, 20),
    hint:
      enclosedWhitePockets.length > 0
        ? 'Inspect enclosedWhitePockets: pass background holes to --extra-seeds "x,y;..." or intentional white fills (sclera/book/pleats) to --protect-boxes "x0,y0,x1,y1;...".'
        : 'No unshielded pure-white pockets (>=25px) detected.',
  };

  const reportAbs = writeJsonReport(outReport, report);
  console.log(
    `process OK -> ${finalPngPath} (${finalPngBuf.length} B, pockets=${enclosedWhitePockets.length}) | preview: ${
      taggedPreviewPath || defaultPreviewPath
    } | report: ${reportAbs}`
  );
}

async function cmdRegister(sharp, args) {
  const outReport = args.output;
  if (!outReport) fail('Missing required --output <json-path>.');
  for (const req of ['input', 'emotion', 'look', 'note']) {
    if (!args[req]) fail(`Missing required --${req}.`, outReport);
  }

  const inputAbs = path.resolve(args.input);
  if (!fs.existsSync(inputAbs)) fail(`Sticker PNG not found: ${args.input}`, outReport);

  const fileName = args.file ? String(args.file) : path.basename(inputAbs);
  if (path.basename(fileName) !== fileName || /[\\/:*?"<>|\x00-\x1f]/.test(fileName) || !/\.png$/i.test(fileName)) {
    fail('Invalid target filename: expected a PNG basename without path separators or invalid characters.', outReport);
  }
  if (!args['allow-custom-prefix'] && !/^(cat|fish|gemini|claude|gpt)_.+\.png$/i.test(fileName)) {
    fail(
      `Invalid target filename "${fileName}". Expected cat_, fish_, gemini_, claude_, or gpt_ prefix (pass --allow-custom-prefix to override).`,
      outReport
    );
  }

  const meta = await sharp(inputAbs).metadata();
  if (meta.format !== 'png') {
    fail(`Expected PNG format, got "${meta.format}".`, outReport);
  }
  if (!meta.hasAlpha) {
    fail(`Sticker PNG "${fileName}" does not have an alpha channel (RGBA required).`, outReport);
  }
  if (meta.width !== meta.height) {
    fail(`Sticker PNG "${fileName}" must be square, got ${meta.width}x${meta.height}.`, outReport);
  }

  const { data: pixels } = await sharp(inputAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let hasTransparentPixel = false;
  let hasVisiblePixel = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) hasTransparentPixel = true;
    if (pixels[i] > 0) hasVisiblePixel = true;
    if (hasTransparentPixel && hasVisiblePixel) break;
  }
  if (!hasTransparentPixel || !hasVisiblePixel) {
    fail('Sticker must contain both visible content and actual transparency; empty or fully opaque PNGs are not stickers.', outReport);
  }

  const rawBytes = fs.readFileSync(inputAbs);
  const maxKb = args['max-kb'] !== undefined ? Number(args['max-kb']) : 300;
  if (!args['allow-large'] && rawBytes.length > maxKb * 1024) {
    fail(
      `Sticker "${fileName}" is ${(rawBytes.length / 1024).toFixed(1)} KB (> ${maxKb} KB limit). Pass --allow-large if intentional.`,
      outReport
    );
  }

  const sha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const stickersDir = args['stickers-dir'] ? path.resolve(args['stickers-dir']) : resolveDefaultStickersDir();
  const indexPath = path.join(stickersDir, 'index.json');
  const dryRun = Boolean(args['dry-run']);
  let indexList;
  if (!fs.existsSync(indexPath)) {
    if (args.init) {
      if (!dryRun) {
        fs.mkdirSync(stickersDir, { recursive: true });
      }
      indexList = [];
    } else {
      fail(`stickers/index.json not found at ${indexPath}. Pass --stickers-dir <dir> or --init to initialize.`, outReport);
    }
  } else {
    try {
      indexList = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(indexList)) throw new Error('Root JSON value is not an array.');
    } catch (err) {
      fail(`Failed to parse ${indexPath}: ${err.message}`, outReport);
    }
  }

  const autoVal = String(args.auto || 'false').toLowerCase() === 'true';
  const existingIdx = indexList.findIndex((item) => item && item.file === fileName);
  const nowMs = Date.now();
  const entry = {
    emotion: String(args.emotion).trim(),
    file: fileName,
    bytes: rawBytes.length,
    sha256,
    auto: autoVal,
    createdAt: existingIdx >= 0 && indexList[existingIdx].createdAt ? indexList[existingIdx].createdAt : nowMs,
    look: String(args.look).trim(),
    note: String(args.note).trim(),
  };

  const destPngPath = path.join(stickersDir, fileName);

  if (!dryRun) {
    if (path.resolve(inputAbs) !== path.resolve(destPngPath)) {
      fs.copyFileSync(inputAbs, destPngPath);
    }
    if (existingIdx >= 0) {
      indexList[existingIdx] = entry;
    } else {
      indexList.push(entry);
    }
    const tmpIndexPath = `${indexPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpIndexPath, JSON.stringify(indexList, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpIndexPath, indexPath);
  }

  const reportAbs = writeJsonReport(outReport, {
    ok: true,
    command: 'register',
    dryRun,
    action: existingIdx >= 0 ? 'updated' : 'inserted',
    totalEntries: dryRun && existingIdx < 0 ? indexList.length + 1 : indexList.length,
    dimensions: `${meta.width}x${meta.height}`,
    destFile: destPngPath,
    indexPath,
    entry,
  });

  console.log(
    `register ${dryRun ? '(DRY-RUN) ' : ''}OK -> ${fileName} (${entry.bytes} B, ${entry.sha256.slice(
      0,
      12
    )}..., ${existingIdx >= 0 ? 'updated' : 'inserted'}) | report: ${reportAbs}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const subcmd = args._[0];

  if (!subcmd || args.help) {
    printHelp(subcmd);
    process.exit(0);
  }

  let sharp;
  try {
    sharp = loadSharp();
  } catch (err) {
    fail(err.message, subcmd === 'export' ? undefined : args.output);
  }

  try {
    if (subcmd === 'align-guide') {
      await cmdAlignGuide(sharp, args);
    } else if (subcmd === 'splice') {
      await cmdSplice(sharp, args);
    } else if (subcmd === 'process') {
      await cmdProcess(sharp, args);
    } else if (subcmd === 'export') {
      const report = await exportSticker(sharp, args);
      console.log(`export OK -> ${report.files.stickerPng} (${report.final.bytes} B) | preview: ${report.files.preview} | report: ${report.reportPath}`);
    } else if (subcmd === 'register') {
      await cmdRegister(sharp, args);
    } else {
      fail(`Unknown subcommand "${subcmd}". Run with --help to see available subcommands.`, args.output);
    }
  } catch (err) {
    fail(err.stack || err.message || String(err), subcmd === 'export' ? err.exportReportPath : args.output);
  }
}

main();
