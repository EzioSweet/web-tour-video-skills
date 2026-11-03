#!/usr/bin/env node
/**
 * web-tour-video-record/scripts/record.mjs
 *
 *   node .../record.mjs --run runs/sample
 *
 * 只负责录屏：读 storyboard.json + out/durations.json，写 out/video.webm + work/timings.json。
 * 不编码、不烧字幕。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  ensureDir,
  fmtClock,
  loadStoryboard,
  moveFile,
  parseArgs,
  probeDuration,
  readJson,
  resolveRunDir,
  sleep,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args.flags.run || args._[0]);
const HEADED = process.env.HEADED === '1';
const FINAL_HOLD_MS = 800;
const NARRATION_TAIL_MS = 600;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function fail(message) {
  throw new Error(message);
}

function resolveActionUrl(url, storyboard) {
  if (/^(https?:|file:|data:|about:)/i.test(url)) return url;
  if (String(url).startsWith('#')) return `${storyboard.resolvedUrl}${url}`;
  // 相对 action.url 以 run 目录为基准，避免从已解析的 file URL 再叠加 ../..
  const local = path.resolve(storyboard.dir, url);
  if (fs.existsSync(local)) return pathToFileURL(local).href;
  if (/^https?:/i.test(storyboard.resolvedUrl)) return new URL(url, storyboard.resolvedUrl).href;
  return pathToFileURL(local).href;
}

function installCursorOverlay() {
  if (window.__piDemoCursorInstalled) return;
  window.__piDemoCursorInstalled = true;

  const style = document.createElement('style');
  style.id = '__pi_demo_cursor_style';
  style.textContent = `
    @keyframes __pi_ripple {
      0%   { transform: scale(0.35); opacity: 1; }
      100% { transform: scale(2.9);  opacity: 0; }
    }
  `;

  const cursor = document.createElement('div');
  cursor.id = '__pi_demo_cursor';
  // macOS 风格箭头：黑色填充 + 白色描边，热点在左上角
  cursor.innerHTML = `
    <svg width="22" height="24" viewBox="0 0 22 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M1.6 1.2 L1.6 19.2 L6.3 14.9 L9.2 22.2 L12.1 21 L9.3 13.8 L15.9 13.6 Z"
            fill="#000000" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`;
  cursor.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:22px',
    'height:24px',
    'pointer-events:none',
    'z-index:2147483647',
    'will-change:transform',
    'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))',
  ].join(';');

  let cx = 0;
  let cy = 0;
  let moved = false;
  const place = (x, y) => {
    cx = x;
    cy = y;
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const ripple = (x, y) => {
    const dot = document.createElement('div');
    dot.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      'width:18px',
      'height:18px',
      'margin:-9px 0 0 -9px',
      'border:3px solid rgba(255,45,45,.95)',
      'border-radius:50%',
      'pointer-events:none',
      'z-index:2147483646',
      'animation:__pi_ripple .55s ease-out forwards',
    ].join(';');
    document.documentElement.appendChild(dot);
    setTimeout(() => dot.remove(), 650);
  };

  const mount = () => {
    if (!document.getElementById('__pi_demo_cursor_style')) {
      (document.head || document.documentElement).appendChild(style);
    }
    if (!document.getElementById('__pi_demo_cursor')) {
      document.documentElement.appendChild(cursor);
    }
    if (!moved) {
      cx = Math.round(window.innerWidth / 2);
      cy = Math.round(window.innerHeight / 2);
    }
    place(cx, cy);
  };

  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  document.addEventListener(
    'mousemove',
    (event) => {
      // 新文档加载时 Chromium 可能补发一个 (0,0) 的 mousemove；
      // 把它当成真实移动会让光标卡在左上角。
      if (!moved && event.clientX === 0 && event.clientY === 0) return;
      if (!document.getElementById('__pi_demo_cursor')) mount();
      moved = true;
      place(event.clientX, event.clientY);
    },
    true,
  );

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!document.getElementById('__pi_demo_cursor_style')) mount();
      ripple(event.clientX, event.clientY);
    },
    true,
  );

  // 个别页面的 init script 执行时 innerWidth 还是 0；等布局稳定后再居中一次。
  setTimeout(() => {
    if (moved) return;
    if (!document.getElementById('__pi_demo_cursor')) mount();
    cx = Math.round(window.innerWidth / 2);
    cy = Math.round(window.innerHeight / 2);
    place(cx, cy);
  }, 150);
}

async function moveMouse(page, x, y, ctx, duration = 420) {
  const from = ctx.mouse;
  const steps = Math.max(30, Math.round(duration / 12));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    await page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
    await sleep(duration / steps);
  }
  ctx.mouse = { x, y };
  await sleep(60);
}

async function getVisibleBox(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 15_000 });
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await sleep(100);
  const box = await locator.boundingBox();
  if (!box) fail(`${label} 没有可见的 boundingBox`);
  return box;
}

async function clickSelector(page, selector, ctx) {
  const locator = page.locator(selector).first();
  await getVisibleBox(locator, `click ${selector}`);

  // 不用 locator.click({trial:true})：在部分页面它会让每个点击多耗 1s 以上。
  // 这里用 elementFromPoint 快速确认中心点没有被遮挡，再用鼠标点击以保留光标/涟漪动画。
  const covered = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const px = rect.left + rect.width / 2;
    const py = rect.top + rect.height / 2;
    const top = document.elementFromPoint(px, py);
    return !top || !(top === el || el.contains(top) || top.contains(el));
  });
  if (covered) fail(`click ${selector} 被其他元素遮挡或不可点击`);

  const box = await locator.boundingBox();
  if (!box) fail(`click ${selector} 没有可见的 boundingBox`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveMouse(page, x, y, ctx);
  await sleep(250);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(220);
}

async function typeInto(page, action, ctx) {
  const selector = action.selector;
  const locator = page.locator(selector).first();
  const box = await getVisibleBox(locator, `type ${selector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveMouse(page, x, y, ctx);
  await sleep(250);
  await page.mouse.down();
  await sleep(50);
  await page.mouse.up();
  await sleep(150);

  if (action.clear !== false) {
    await locator.fill('').catch(() => {});
  }
  const delay = Math.min(150, Math.max(80, Number(action.delay ?? 110)));
  await locator.pressSequentially(String(action.text ?? ''), { delay });
  await sleep(180);
}

async function scrollPage(page, action, ctx) {
  const totalY = Number(action.y ?? 0);
  const totalX = Number(action.x ?? 0);
  if (!totalY && !totalX) return;

  await moveMouse(page, ctx.viewport.width * 0.62, ctx.viewport.height * 0.55, ctx, 350);
  const chunks = Math.max(6, Math.min(18, Math.ceil(Math.max(Math.abs(totalY), Math.abs(totalX)) / 90)));
  let doneY = 0;
  let doneX = 0;
  for (let i = 0; i < chunks; i += 1) {
    const remainY = totalY - doneY;
    const remainX = totalX - doneX;
    const stepY = remainY / (chunks - i);
    const stepX = remainX / (chunks - i);
    await page.mouse.wheel(stepX, stepY);
    doneY += stepY;
    doneX += stepX;
    await sleep(70);
  }
  await sleep(320);
}

async function doAction(page, action, ctx, storyboard) {
  switch (action.type) {
    case 'goto': {
      const target = resolveActionUrl(String(action.url ?? storyboard.resolvedUrl), storyboard);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: action.timeout ?? 30_000 });
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await sleep(action.waitAfter ?? 800);
      ctx.mouse = { x: ctx.viewport.width / 2, y: ctx.viewport.height / 2 };
      break;
    }
    case 'click':
      if (!action.selector) fail('click action 缺少 selector');
      await clickSelector(page, action.selector, ctx);
      break;
    case 'type':
      if (!action.selector) fail('type action 缺少 selector');
      await typeInto(page, action, ctx);
      break;
    case 'scroll':
      await scrollPage(page, action, ctx);
      break;
    case 'hover': {
      if (!action.selector) fail('hover action 缺少 selector');
      const locator = page.locator(action.selector).first();
      const box = await getVisibleBox(locator, `hover ${action.selector}`);
      await moveMouse(page, box.x + box.width / 2, box.y + box.height / 2, ctx);
      await sleep(action.ms ?? 500);
      break;
    }
    case 'wait':
      await sleep(Number(action.ms ?? 500));
      break;
    default:
      fail(`不支持的 action.type：${action.type}`);
  }
}


function prepareRecordOut(runDir) {
  const out = path.join(runDir, 'out');
  ensureDir(out);
  for (const name of ['video.webm', 'raw_video', 'subs.srt', 'final.mp4', 'frames', 'qa_report.md']) {
    fs.rmSync(path.join(out, name), { recursive: true, force: true });
  }
  for (const name of ['timings.json', 'encode.json', 'qa.json']) {
    fs.rmSync(path.join(runDir, 'work', name), { force: true });
  }
}

function loadDurations(runDir) {
  const file = path.join(runDir, 'out', 'durations.json');
  if (!fs.existsSync(file)) {
    throw new Error(`缺少 out/durations.json：${file}
先运行 AUDIO 阶段。`);
  }
  const data = readJson(file);
  if (!Array.isArray(data.segments) || !data.segments.length) {
    throw new Error('out/durations.json 没有 segments');
  }
  return data;
}

async function main() {
  const storyboard = loadStoryboard(runDir);
  const durations = loadDurations(runDir);

  const durationByStep = new Map(durations.segments.map((s) => [s.step, Number(s.durationSeconds)]));
  for (const step of storyboard.steps) {
    if (!durationByStep.has(step.index)) {
      throw new Error(`out/durations.json 缺少第 ${step.index} 步的时长`);
    }
  }

  const outDir = path.join(runDir, 'out');
  prepareRecordOut(runDir);

  const authFile = path.resolve(runDir, storyboard.storageState || 'auth.json');
  let storageState;
  if (fs.existsSync(authFile)) {
    storageState = authFile;
    log(`✓ 使用登录态：${authFile}`);
  } else {
    log('! 未找到登录态，按无登录处理。');
    log(`  生成登录态：cd ${runDir} && npx playwright codegen --save-storage=auth.json ${storyboard.url}`);
  }

  const hasGoto = storyboard.steps.some((s) => s.actions.some((a) => a.type === 'goto'));

  const chromeHeight = Number(storyboard.chrome?.height ?? 0);
  const pageHeight = storyboard.height - chromeHeight;
  if (chromeHeight) log(`  ！浏览器外框 ${storyboard.width}x${chromeHeight}：录制视口 ${storyboard.width}x${pageHeight}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: storyboard.width, height: pageHeight },
    recordVideo: {
      dir: path.join(outDir, 'raw_video'),
      size: { width: storyboard.width, height: pageHeight },
    },
    storageState,
    locale: 'zh-CN',
    colorScheme: 'light',
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(30_000);
  await context.addInitScript(installCursorOverlay);

  let page;
  let video;
  const timings = [];
  const logLines = [];
  let trimStartMs = 0;
  const videoStartWall = Date.now();

  try {
    page = await context.newPage();
    video = page.video();
    const ctx = {
      viewport: { width: storyboard.width, height: pageHeight },
      mouse: { x: storyboard.width - 80, y: pageHeight - 60 },
    };

    if (!hasGoto) {
      log('  预加载首页（不计入时间轴）');
      await page.goto(storyboard.resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await sleep(1200);
    }
    const recordStart = Date.now();
    trimStartMs = Math.max(0, recordStart - videoStartWall);
    await page.mouse.move(ctx.mouse.x, ctx.mouse.y);

    for (let i = 0; i < storyboard.steps.length; i += 1) {
      const step = storyboard.steps[i];
      const audioMs = durationByStep.get(step.index) * 1000;
      const startMs = Date.now() - recordStart;
      const actionStart = Date.now();

      log(`  [${step.index}/${storyboard.steps.length}] ${step.narration}`);
      for (const action of step.actions) {
        await doAction(page, action, ctx, storyboard);
      }
      const actionMs = Date.now() - actionStart;
      const targetMs = audioMs + NARRATION_TAIL_MS;
      const waitMs = Math.max(0, targetMs - actionMs);
      if (actionMs > targetMs) {
        warn(`  ! 第 ${step.index} 步操作耗时 ${actionMs}ms，超过旁白 ${(audioMs / 1000).toFixed(2)}s，这段旁白会延续到下一步`);
      }
      if (waitMs > 0) await sleep(waitMs);
      const endMs = Date.now() - recordStart;

      timings.push({
        index: step.index,
        startMs,
        endMs,
        actionMs,
        waitMs: Math.round(waitMs),
        audioDurationSeconds: Number((audioMs / 1000).toFixed(3)),
      });
      const line = `${fmtClock(startMs)} – ${fmtClock(endMs)}  action=${actionMs}ms  wait=${Math.round(waitMs)}ms  audio=${(audioMs / 1000).toFixed(2)}s`;
      log(`    ${line}`);
      logLines.push(`[step ${step.index}] ${line}`);
    }

    await sleep(FINAL_HOLD_MS);
  } finally {
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!video) fail('没有拿到 Playwright 录屏对象');
  const rawPath = await video.path();
  if (!rawPath || !fs.existsSync(rawPath)) fail(`录屏文件不存在：${rawPath}`);
  const videoWebm = path.join(outDir, 'video.webm');
  moveFile(rawPath, videoWebm);
  fs.rmSync(path.join(outDir, 'raw_video'), { recursive: true, force: true });

  const videoDuration = probeDuration(videoWebm);
  const expected = (timings.at(-1).endMs + FINAL_HOLD_MS) / 1000;
  const trimmedDuration = videoDuration - trimStartMs / 1000;
  log(`✓ 录屏完成：out/video.webm  ${trimmedDuration.toFixed(3)}s（已裁预加载 ${(trimStartMs / 1000).toFixed(2)}s，时间轴预期 ${expected.toFixed(3)}s）`);
  if (Math.abs(trimmedDuration - expected) > 1.0) {
    warn(`  ! 视频实际时长与时间轴相差 ${(trimmedDuration - expected).toFixed(3)}s；可用 OFFSET_MS 微调音画`);
  }

  writeJson(path.join(runDir, 'work', 'timings.json'), {
    generatedAt: new Date().toISOString(),
    video: {
      file: 'out/video.webm',
      durationSeconds: Number((videoDuration - trimStartMs / 1000).toFixed(3)),
      trimStartMs,
      width: storyboard.width,
      height: pageHeight,
      finalWidth: storyboard.width,
      finalHeight: storyboard.height,
      chromeHeight,
    },
    offsetMs: 0,
    steps: timings,
  });
  fs.writeFileSync(path.join(runDir, 'work', 'record.log'), `${logLines.join('\n')}\n`);
  log('  → work/timings.json');
}

main().catch((err) => {
  console.error(`\n✗ 录屏失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
