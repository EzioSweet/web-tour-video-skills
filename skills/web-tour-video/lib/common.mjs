/**
 * common.mjs — 共享路径、进程、JSON、ffprobe、storyboard 工具。
 * 不包含 TTS / Playwright / ffmpeg 编码逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agents')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取 JSON 失败：${file}\n${err.message}`);
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  if (r.error) throw new Error(`无法执行 ${cmd}：${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().slice(-4000);
    throw new Error(`${cmd} 执行失败（exit ${r.status}）：\n${detail}`);
  }
  return r;
}

export function moveFile(src, dst) {
  ensureDir(path.dirname(dst));
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dst);
    fs.rmSync(src, { force: true });
  }
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
}

export function fmtSrtTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** 支持 `--key value`、`--flag`、位置参数。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.flags[key] = next;
      i += 1;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

export function resolveRunDir(explicit) {
  const value = explicit || 'runs/sample';
  const dir = path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
  if (!fs.existsSync(dir)) {
    throw new Error(`run 目录不存在：${dir}\n先创建 runs/<slug>/ 并写入 brief.md / storyboard.json。`);
  }
  return dir;
}

export function resolveStoryboardUrl(url, runDir) {
  if (/^(https?:|file:|data:|about:)/i.test(String(url))) return String(url);
  const candidate = path.resolve(runDir, String(url));
  if (!fs.existsSync(candidate)) {
    throw new Error(`storyboard.url 指向的本地文件不存在：${candidate}`);
  }
  return pathToFileURL(candidate).href;
}

export function loadStoryboard(runDir) {
  const file = path.join(runDir, 'storyboard.json');
  if (!fs.existsSync(file)) throw new Error(`缺少 storyboard.json：${file}`);
  const raw = readJson(file);
  if (!raw.url || typeof raw.url !== 'string') throw new Error('storyboard 缺少 url');
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('storyboard.steps 必须是非空数组');

  const width = Number(raw.video?.width ?? 1920);
  const height = Number(raw.video?.height ?? 1080);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('video.width / video.height 必须是正整数');
  }
  if (width % 2 || height % 2) throw new Error('视频宽高必须是偶数（HEVC 编码要求）');

  let chrome = null;
  if (raw.chrome != null) {
    const chromeHeight = Number(raw.chrome.height ?? 76);
    if (!Number.isInteger(chromeHeight) || chromeHeight < 40 || chromeHeight >= height) {
      throw new Error('chrome.height 必须是整数，且 40 <= height < video.height');
    }
    if ((height - chromeHeight) % 2) throw new Error('去掉浏览器外框后的页面高度必须是偶数');
    chrome = { height: chromeHeight, title: String(raw.chrome.title ?? ''), url: String(raw.chrome.url ?? '') };
  }

  const steps = raw.steps.map((step, i) => {
    const narration = String(step?.narration ?? '').trim();
    if (!narration) throw new Error(`第 ${i + 1} 步缺少 narration`);
    return {
      ...step,
      index: i + 1,
      narration,
      actions: Array.isArray(step.actions) ? step.actions : [],
    };
  });

  return {
    ...raw,
    file,
    dir: runDir,
    width,
    height,
    chrome,
    recordHeight: height - (chrome?.height ?? 0),
    steps,
    lexicon: Array.isArray(raw.lexicon) ? raw.lexicon : [],
    resolvedUrl: resolveStoryboardUrl(raw.url, runDir),
  };
}

export function probeDuration(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) throw new Error(`ffprobe 无法执行：${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffprobe 读取 ${file} 失败：${(r.stderr || '').trim()}`);
  let duration;
  try {
    duration = Number(JSON.parse(r.stdout).format?.duration);
  } catch {
    throw new Error(`ffprobe 输出无法解析：${r.stdout?.slice(0, 300)}`);
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe 返回的时长无效：${file}`);
  return duration;
}

export function ffprobeJson(file) {
  const r = runCapture(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    timeout: 60_000,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`ffprobe JSON 输出无法解析：${r.stdout.slice(0, 500)}`);
  }
}

export function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function shorthandAction(action) {
  if (!action || typeof action !== 'object') return String(action);
  if (action.type === 'goto') return `goto ${action.url}`;
  if (action.type === 'click') return `click ${action.selector}`;
  if (action.type === 'type') return `type ${action.selector} = ${JSON.stringify(action.text ?? '')}`;
  if (action.type === 'scroll') return `scroll x=${action.x ?? 0} y=${action.y ?? 0}`;
  if (action.type === 'hover') return `hover ${action.selector}`;
  if (action.type === 'wait') return `wait ${action.ms ?? 500}ms`;
  return JSON.stringify(action);
}
