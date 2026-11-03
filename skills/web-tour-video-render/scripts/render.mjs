#!/usr/bin/env node
/**
 * web-tour-video-render/scripts/render.mjs
 *
 *   node .../render.mjs --run runs/sample
 *
 * 读 out/video.webm + work/timings.json + out/durations.json + storyboard.json，
 * 写 out/subs.srt、out/final.mp4、work/encode.json、out/pron_report.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FFMPEG,
  FFPROBE,
  ensureDir,
  fmtSrtTime,
  ffprobeJson,
  loadStoryboard,
  parseArgs,
  readJson,
  resolveRunDir,
  runCapture,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';
import { writePronReport } from '../../web-tour-video/lib/report.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args.flags.run || args._[0]);
const OUT_DIR = path.join(runDir, 'out');
const SUB_FONT_SIZE = Number(process.env.SUB_FONT_SIZE || 12);
const SUB_MARGIN_V = Number(process.env.SUB_MARGIN_V || 26);
const OFFSET = Number(process.env.OFFSET_MS ?? 0);
// UI 文字对量化很敏感：qp24 会明显发糊，默认 18（可用 VIDEO_QP 覆盖）
const VIDEO_QP = String(process.env.VIDEO_QP || '18');
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function fail(message) {
  throw new Error(message);
}

function buildSrt(prepared, videoDuration) {
  const cues = [];
  for (let i = 0; i < prepared.length; i += 1) {
    const step = prepared[i];
    const next = prepared[i + 1];
    const start = Math.max(0, (step.startMs + OFFSET) / 1000);
    let end = start + step.duration + 0.35;
    if (next) end = Math.min(end, Math.max(start + 0.5, (next.startMs + OFFSET) / 1000 - 0.08));
    end = Math.min(end, videoDuration - 0.05);
    if (end <= start + 0.25) end = Math.min(videoDuration - 0.05, start + Math.max(0.8, step.duration));
    if (end <= start) continue;
    const text = step.narration.replace(/\r\n/g, '\n').trim();
    if (/\[[A-Z0-9 ]+\]/.test(text) || /(?<=[\u3400-\u9fff])[A-Z]+[1-4]/.test(text)) {
      fail(`第 ${step.index} 步 narration 中出现了拼音/音素标记，字幕必须使用干净原文：${text}`);
    }
    cues.push({ start, end, text });
  }
  return {
    srt: cues.map((c, i) => `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`).join('\n'),
    cues,
  };
}

function buildSubtitleFilter(srtFile = 'subs.srt') {
  const style = [
    'FontName=Noto Sans CJK SC',
    `FontSize=${SUB_FONT_SIZE}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BackColour=&H64000000',
    'BorderStyle=1',
    'Outline=1.5',
    'Shadow=0',
    `MarginV=${SUB_MARGIN_V}`,
    'MarginL=80',
    'MarginR=80',
    'Alignment=2',
    'WrapStyle=0',
  ].join(',');
  return `subtitles=filename=${srtFile}:force_style='${style}'`;
}

function ffmpegArgsFor(mode, { videoFile, prepared, videoDuration, trimStartMs = 0, srtFile, chromeFiles = [] }) {
  const subtitles = buildSubtitleFilter(srtFile);
  const chromeIndex0 = 1 + prepared.length;

  const argv = [];
  if (mode === 'vaapi') argv.push('-vaapi_device', VAAPI_DEVICE);
  if (trimStartMs > 0) argv.push('-ss', (trimStartMs / 1000).toFixed(3));
  argv.push('-i', videoFile);
  for (const step of prepared) argv.push('-i', step.audioFile);
  for (const c of chromeFiles) argv.push('-i', c.file);

  const filter = [];
  let vlabel = '[0:v]';
  if (chromeFiles.length) {
    filter.push(`[${chromeIndex0}:v][0:v]vstack=inputs=2[vbase]`);
    vlabel = '[vbase]';
    for (let i = 1; i < chromeFiles.length; i += 1) {
      const from = (chromeFiles[i].fromMs / 1000).toFixed(3);
      const nextMs = chromeFiles[i + 1]?.fromMs ?? videoDuration * 1000;
      const to = (nextMs / 1000).toFixed(3);
      filter.push(`${vlabel}[${chromeIndex0 + i}:v]overlay=0:0:enable='between(t,${from},${to})'[vo${i}]`);
      vlabel = `[vo${i}]`;
    }
  }
  filter.push(mode === 'vaapi'
    ? `${vlabel}${subtitles},format=nv12,hwupload[vout]`
    : `${vlabel}${subtitles},format=yuv420p[vout]`);
  prepared.forEach((step, i) => {
    const delay = Math.max(0, Math.round(step.startMs + OFFSET));
    filter.push(`[${i + 1}:a]adelay=${delay}:all=1[a${i + 1}]`);
  });
  const labels = prepared.map((_, i) => `[a${i + 1}]`).join('');
  if (prepared.length === 1) {
    filter.push(`${labels}apad=whole_dur=${videoDuration.toFixed(3)}[aout]`);
  } else {
    filter.push(`${labels}amix=inputs=${prepared.length}:normalize=0:duration=longest,apad=whole_dur=${videoDuration.toFixed(3)},alimiter=limit=0.95[aout]`);
  }

  argv.push('-filter_complex', filter.join(';'));
  argv.push('-map', '[vout]', '-map', '[aout]');
  if (mode === 'vaapi') {
    argv.push('-c:v', 'hevc_vaapi', '-qp', VIDEO_QP, '-tag:v', 'hvc1');
  } else {
    argv.push('-c:v', 'libx265', '-crf', VIDEO_QP, '-preset', 'medium', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
  }
  argv.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  argv.push('-t', videoDuration.toFixed(3), '-movflags', '+faststart', '-y', 'final.mp4');
  return argv;
}

function runFfmpeg(argv) {
  const pretty = `${FFMPEG} ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  log(`  ffmpeg: ${pretty.length > 600 ? `${pretty.slice(0, 600)}…` : pretty}`);
  return runCapture(FFMPEG, ['-hide_banner', '-loglevel', 'warning', ...argv], {
    cwd: OUT_DIR,
    timeout: 30 * 60_000,
  });
}

function getEncoderInfo() {
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  const device = VAAPI_DEVICE;
  const reasons = [];
  if (!fs.existsSync(device)) reasons.push(`设备节点不存在：${device}`);
  if (!/\bhevc_vaapi\b/.test(encoders)) reasons.push('ffmpeg -encoders 中没有 hevc_vaapi');
  return {
    device,
    vaapiAvailable: reasons.length === 0,
    vaapiReasons: reasons,
    hasLibx265: /\blibx265\b/.test(encoders),
  };
}

function writeChromeImages(storyboard, prepared) {
  const chrome = storyboard.chrome;
  if (!chrome) return [];
  const height = Number(chrome.height ?? 76);
  if (!Number.isInteger(height) || height < 40 || height >= storyboard.height) {
    fail(`chrome.height 不合法：${chrome.height}`);
  }
  const script = path.join(import.meta.dirname, '../../web-tour-video/lib/browser_chrome.mjs');
  const seq = [{ url: chrome.url || '', fromMs: 0 }];
  for (const step of prepared) {
    const url = String(step.chromeUrl || '').trim();
    if (url && url !== seq.at(-1).url) seq.push({ url, fromMs: step.startMs });
  }
  const out = [];
  for (let i = 0; i < seq.length; i += 1) {
    const file = path.join(OUT_DIR, seq.length === 1 ? 'chrome.png' : `chrome-${i + 1}.png`);
    const res = spawnSync(
      process.execPath,
      [script, '--out', file, '--width', String(storyboard.width), '--height', String(height),
        '--title', String(chrome.title || 'App'), '--url', seq[i].url],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) {
      fail(`生成浏览器外框失败：${(res.stderr || res.stdout || '').slice(0, 800)}`);
    }
    out.push({ file, fromMs: seq[i].fromMs, url: seq[i].url });
  }
  log(`✓ 浏览器外框 ${storyboard.width}x${height}（${out.length} 个地址状态）`);
  return out;
}

function encodeVideo({ prepared, videoDuration, trimStartMs, srtFile, chromeFiles, requestedMode }) {
  const info = getEncoderInfo();
  let mode = requestedMode;
  let fallbackReason = null;

  if (!['vaapi', 'cpu'].includes(mode)) fail(`ENCODER 只能是 vaapi 或 cpu，当前：${mode}`);

  if (mode === 'vaapi' && !info.vaapiAvailable) {
    fallbackReason = `VAAPI 不可用：${info.vaapiReasons.join('；')}`;
    log(`  ! ${fallbackReason}，回退 CPU`);
    mode = 'cpu';
  }
  if (mode === 'cpu' && !info.hasLibx265) {
    fail(
      'CPU 编码需要 ffmpeg 的 libx265，但当前 ffmpeg 没有编译 libx265。\n' +
        '  Fedora/RHEL: 安装 RPM Fusion 的 ffmpeg（sudo dnf install ffmpeg）\n' +
        '  Debian/Ubuntu: sudo apt install ffmpeg\n' +
        '  也可以继续用默认的 ENCODER=vaapi。',
    );
  }

  try {
    const argv = ffmpegArgsFor(mode, { videoFile: 'video.webm', prepared, videoDuration, trimStartMs, srtFile, chromeFiles });
    runFfmpeg(argv);
    return { mode, fallbackReason, encoderInfo: info };
  } catch (err) {
    if (mode !== 'vaapi') throw err;
    const vaapiError = err.message;
    log('  ! VAAPI 编码失败，尝试回退 CPU');
    if (!info.hasLibx265) {
      fail(
        `VAAPI 编码失败，且当前 ffmpeg 没有 libx265，无法回退 CPU。\n` +
          `VAAPI 错误：${vaapiError.slice(0, 1200)}\n` +
          '提示：无权限时把用户加入 render 组；Docker 需映射 /dev/dri；花屏先检查 format=nv12 和 hwupload 顺序。',
      );
    }
    const argv = ffmpegArgsFor('cpu', { videoFile: 'video.webm', prepared, videoDuration, trimStartMs, srtFile, chromeFiles });
    runFfmpeg(argv);
    return { mode: 'cpu', fallbackReason: `VAAPI 编码失败：${vaapiError.split('\n')[0]}`, encoderInfo: info };
  }
}

function verifyOutput(expectedDuration, storyboard) {
  const file = path.join(OUT_DIR, 'final.mp4');
  const info = ffprobeJson(file);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration ?? video?.duration);
  const problems = [];

  if (!video) problems.push('没有视频流');
  else {
    if (video.codec_name !== 'hevc') problems.push(`视频编码是 ${video.codec_name}，不是 hevc`);
    if (Number(video.width) !== storyboard.width) problems.push(`宽度是 ${video.width}，期望 ${storyboard.width}`);
    if (Number(video.height) !== storyboard.height) problems.push(`高度是 ${video.height}，期望 ${storyboard.height}`);
  }
  if (!audio) problems.push('没有音频流');
  else if (audio.codec_name !== 'aac') problems.push(`音频编码是 ${audio.codec_name}，不是 aac`);
  if (!Number.isFinite(duration)) problems.push('无法读取时长');
  else if (Math.abs(duration - expectedDuration) > 0.9) problems.push(`时长 ${duration.toFixed(3)}s 与录屏 ${expectedDuration.toFixed(3)}s 相差超过 0.9s`);

  if (problems.length) fail(`final.mp4 自检失败：\n- ${problems.join('\n- ')}`);
  return {
    duration,
    videoCodec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    audioCodec: audio.codec_name,
    fps: video.r_frame_rate,
  };
}

function prepareRenderOut(runDir) {
  for (const name of ['subs.srt', 'final.mp4', 'frames', 'qa_report.md']) {
    fs.rmSync(path.join(runDir, 'out', name), { recursive: true, force: true });
  }
  for (const name of ['encode.json', 'qa.json']) {
    fs.rmSync(path.join(runDir, 'work', name), { force: true });
  }
  fs.readdirSync(path.join(runDir, 'out'))
    .filter((f) => /^chrome(-\d+)?\.png$/.test(f))
    .forEach((f) => fs.rmSync(path.join(runDir, 'out', f), { force: true }));
}

async function main() {
  const storyboard = loadStoryboard(runDir);
  const durationsFile = path.join(runDir, 'out', 'durations.json');
  const timingsFile = path.join(runDir, 'work', 'timings.json');
  if (!fs.existsSync(durationsFile)) fail(`缺少 out/durations.json，先运行 AUDIO 阶段。`);
  if (!fs.existsSync(timingsFile)) fail(`缺少 work/timings.json，先运行 RECORD 阶段。`);
  if (!fs.existsSync(path.join(OUT_DIR, 'video.webm'))) fail(`缺少 out/video.webm，先运行 RECORD 阶段。`);

  const durations = readJson(durationsFile);
  const timings = readJson(timingsFile);
  const durationByStep = new Map(durations.segments.map((s) => [s.step, s]));
  const timingByStep = new Map(timings.steps.map((s) => [s.index, s]));

  const prepared = storyboard.steps.map((step) => {
    const d = durationByStep.get(step.index);
    const t = timingByStep.get(step.index);
    if (!d) fail(`durations.json 缺少第 ${step.index} 步`);
    if (!t) fail(`timings.json 缺少第 ${step.index} 步`);
    return {
      index: step.index,
      narration: step.narration,
      duration: Number(d.durationSeconds),
      audioFile: path.join(OUT_DIR, d.audio),
      startMs: t.startMs,
      endMs: t.endMs,
      chromeUrl: step.chromeUrl,
    };
  });

  const videoDuration = Number(timings.video.durationSeconds);
  const trimStartMs = Number(timings.video.trimStartMs || 0);
  if (trimStartMs) log(`  ！裁掉录屏预加载 ${(trimStartMs / 1000).toFixed(2)}s`);
  prepareRenderOut(runDir);

  const chromeFiles = writeChromeImages(storyboard, prepared);

  log(`\n▶ 字幕 + 编码（${prepared.length} 段）`);
  const { srt, cues } = buildSrt(prepared, videoDuration);
  fs.writeFileSync(path.join(OUT_DIR, 'subs.srt'), srt);
  log(`✓ out/subs.srt（${cues.length} 条）`);

  const requestedMode = (process.env.ENCODER || 'vaapi').toLowerCase();
  const result = encodeVideo({ prepared, videoDuration, trimStartMs, srtFile: 'subs.srt', chromeFiles, requestedMode });
  const videoInfo = verifyOutput(videoDuration, storyboard);

  const encodeData = {
    generatedAt: new Date().toISOString(),
    mode: result.mode,
    fallbackReason: result.fallbackReason,
    encoderInfo: result.encoderInfo,
    video: videoInfo,
    duration: videoInfo.duration,
  };
  writeJson(path.join(runDir, 'work', 'encode.json'), encodeData);

  writePronReport(runDir, storyboard, durations, timings);

  log(`✓ out/final.mp4  ${videoInfo.videoCodec} ${videoInfo.width}x${videoInfo.height} / ${videoInfo.audioCodec} / ${videoInfo.duration.toFixed(3)}s`);
  log(`  编码模式：${result.mode}${result.fallbackReason ? `（${result.fallbackReason}）` : ''}`);
  log(`  → work/encode.json`);
  log(`  → out/pron_report.md`);
}

main().catch((err) => {
  console.error(`\n✗ 渲染失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
