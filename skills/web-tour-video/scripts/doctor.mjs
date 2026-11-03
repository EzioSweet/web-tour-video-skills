#!/usr/bin/env node
/**
 * doctor.mjs — 环境检查。只提示安装命令，不执行 sudo。
 *
 *   node .agents/skills/web-tour-video/scripts/doctor.mjs
 *   node .agents/skills/web-tour-video/scripts/doctor.mjs --run runs/sample --audio-only
 *   node .agents/skills/web-tour-video/scripts/doctor.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FFMPEG,
  FFPROBE,
  PROJECT_ROOT,
  loadStoryboard,
  parseArgs,
  readJson,
  resolveRunDir,
} from '../lib/common.mjs';
import { buildTtsConfig } from '../lib/tts-config.mjs';

const args = parseArgs();
const audioOnly = Boolean(args.flags['audio-only']);
const asJson = Boolean(args.flags.json);
const runArg = typeof args.flags.run === 'string' ? args.flags.run : args._[0];
const runDir = runArg ? resolveRunDir(runArg) : null;

let storyboardTts = {};
if (runDir && fs.existsSync(path.join(runDir, 'storyboard.json'))) {
  try {
    storyboardTts = loadStoryboard(runDir).tts || {};
  } catch {
    storyboardTts = {};
  }
}
const config = buildTtsConfig(storyboardTts);

const problems = [];
const notes = [];

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  problems.push(`Node.js 版本过低（${process.version}），需要 >= 18。`);
}

for (const [cmd, label] of [
  [FFMPEG, 'ffmpeg'],
  [FFPROBE, 'ffprobe'],
]) {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    problems.push(`未找到 ${label}。Fedora: sudo dnf install ffmpeg；Debian/Ubuntu: sudo apt install ffmpeg`);
  }
}

let filters = '';
let encoders = '';
let decoders = '';
if (!problems.some((p) => p.includes('ffmpeg'))) {
  filters = spawnSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '';
  encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  decoders = spawnSync(FFMPEG, ['-hide_banner', '-decoders'], { encoding: 'utf8' }).stdout || '';
  if (!/\bsubtitles\b/.test(filters)) {
    problems.push('当前 ffmpeg 缺少 subtitles 滤镜（libass），无法烧录字幕。请安装带 libass 的 ffmpeg。');
  }
}

if (!audioOnly) {
  const fontList = spawnSync('fc-list', [':lang=zh'], { encoding: 'utf8' });
  if (fontList.error) {
    problems.push('未找到 fc-list（fontconfig）。安装 fontconfig 后再检查中文字体。');
  } else if (!fontList.stdout.trim()) {
    problems.push(
      '没有检测到中文字体（fc-list :lang=zh 无输出）。\n' +
        '  Debian/Ubuntu: sudo apt install fonts-noto-cjk\n' +
        '  Fedora/RHEL:   sudo dnf install google-noto-sans-cjk-fonts\n' +
        '  安装后运行 fc-cache -fv，再重试。',
    );
  } else {
    const match = spawnSync('fc-match', ['-f', '%{family}', 'Noto Sans CJK SC'], { encoding: 'utf8' });
    if (match.status !== 0 || !/Noto Sans CJK SC/i.test(match.stdout || '')) {
      notes.push(`未精确匹配到 "Noto Sans CJK SC"（fc-match 返回：${(match.stdout || '').trim() || '空'}）。字幕可能回退到其他中文字体。`);
    }
  }

  let chromiumPath = '';
  try {
    const { chromium } = await import('playwright');
    chromiumPath = chromium.executablePath();
  } catch (err) {
    problems.push(`无法加载 Playwright：${err.message}\n  运行：npm install && npx playwright install chromium`);
  }
  if (chromiumPath && !fs.existsSync(chromiumPath)) {
    problems.push(`Playwright Chromium 不存在：${chromiumPath}\n  运行：npx playwright install chromium`);
  }

  if (process.env.HEADED === '1' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    problems.push('HEADED=1 但没有 DISPLAY/WAYLAND_DISPLAY。无显示器环境用：xvfb-run -a <命令>');
  }
}

// TTS 可达性：GET 根路径，任何 HTTP 状态码都算服务活着。
let ttsStatus = 'unreachable';
try {
  const res = await fetch(config.baseUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
  ttsStatus = `reachable (HTTP ${res.status})`;
} catch (err) {
  problems.push(
    `TTS 接口不可达：${config.baseUrl}\n  ${err.message}\n  请先启动 OmniVoice（默认 http://localhost:8735），或用 TTS_BASE_URL 指定地址。`,
  );
}

const vaapiDevice = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const vaapiReasons = [];
if (!fs.existsSync(vaapiDevice)) vaapiReasons.push(`设备节点不存在：${vaapiDevice}`);
if (!/\bhevc_vaapi\b/.test(encoders)) vaapiReasons.push('ffmpeg -encoders 中没有 hevc_vaapi');
const vaapi = {
  available: vaapiReasons.length === 0,
  device: vaapiDevice,
  reasons: vaapiReasons,
  hasLibx265: /\blibx265\b/.test(encoders),
  hasHevcDecoder: /\bhevc\b/.test(decoders),
};

if (!vaapi.hasLibx265) notes.push('ffmpeg 没有 libx265；ENCODER=cpu 会失败，默认使用 VAAPI。');
if (!vaapi.hasHevcDecoder) notes.push('ffmpeg 没有 HEVC 解码器；QA 抽帧会自动改用 GStreamer VAAPI 或 video.webm + 字幕滤镜。');
const gst = spawnSync('gst-launch-1.0', ['--version'], { encoding: 'utf8' });
if (!gst.error && gst.status === 0) {
  const gstDec = spawnSync('gst-inspect-1.0', ['vah265dec'], { encoding: 'utf8' });
  if (gst.status === 0 && gstDec.status === 0) notes.push('GStreamer vah265dec 可用（HEVC 抽帧后备）。');
}

const result = {
  ok: problems.length === 0,
  node: process.version,
  ffmpeg: !problems.some((p) => p.includes('ffmpeg')),
  fonts: audioOnly ? 'skipped' : undefined,
  playwright: audioOnly ? 'skipped' : undefined,
  tts: { baseUrl: config.baseUrl, model: config.model || '(default)', voice: config.voice || '(default)', status: ttsStatus },
  vaapi,
  problems,
  notes,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? '✓ 环境检查通过' : '✗ 环境检查未通过');
  console.log(`  Node ${process.version}`);
  console.log(`  TTS: ${config.baseUrl}  model=${config.model || '(服务端默认)'}  voice=${config.voice || '(服务端默认)'}  [${ttsStatus}]`);
  console.log(`  VAAPI: ${vaapi.available ? `可用（${vaapiDevice}）` : `不可用（${vaapi.reasons.join('；')}）`}`);
  console.log(`  软件 HEVC (libx265): ${vaapi.hasLibx265 ? '可用' : '不可用'}`);
  console.log(`  ffmpeg HEVC 解码器: ${vaapi.hasHevcDecoder ? '可用' : '不可用'}`);
  for (const n of notes) console.log(`  ! ${n}`);
  if (problems.length) {
    console.error('');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\n（以上命令只提示，不会自动 sudo 安装。）');
  }
  if (runDir) console.log(`  run: ${runDir}`);
}

process.exit(result.ok ? 0 : 1);
