#!/usr/bin/env node
/**
 * web-tour-video-recon/scripts/recon.mjs
 *
 *   node .../recon.mjs --run runs/sample
 *   node .../recon.mjs --run runs/sample --actions runs/sample/work/recon/probe.json
 *
 * 读 work/brief.json，输出 work/recon/recon.md、elements*.json、screenshots/。
 * 选择器最终由 agent 根据候选写进 work/recon/selectors.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  ensureDir,
  parseArgs,
  readJson,
  resolveRunDir,
  resolveStoryboardUrl,
  sleep,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args.flags.run || args._[0]);
const HEADED = process.env.HEADED === '1';
const reconDir = path.join(runDir, 'work', 'recon');
const screensDir = path.join(reconDir, 'screenshots');

const log = (...a) => console.log(...a);

function loadBrief() {
  const file = path.join(runDir, 'work', 'brief.json');
  if (!fs.existsSync(file)) {
    throw new Error(`缺少 work/brief.json。先让主 skill 把 brief.md 解析成：{ url, storageState, video, flow }`);
  }
  return readJson(file);
}

function authPath(brief) {
  const raw = brief.storageState || 'auth.json';
  return path.isAbsolute(raw) ? raw : path.resolve(runDir, raw);
}

async function dumpElements(page) {
  const locator = page.locator('button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [data-testid]');
  const count = Math.min(await locator.count(), 300);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const item = await locator.nth(i).evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      const testid = el.getAttribute('data-testid');
      const aria = el.getAttribute('aria-label');
      const role = el.getAttribute('role');
      const name = el.getAttribute('name');
      const id = el.id;
      const placeholder = el.getAttribute('placeholder');
      const type = el.getAttribute('type');
      const cls = typeof el.className === 'string' ? el.className : '';
      const hints = [];
      if (testid) hints.push(`[data-testid="${testid}"]`);
      if (id) hints.push(`#${id}`);
      if (name) hints.push(`[name="${name}"]`);
      if (aria) hints.push(`[aria-label="${aria}"]`);
      return {
        tag, text, testid, aria, role, name, id, placeholder, type,
        class: cls.slice(0, 160),
        visible,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        hints,
      };
    });
    if (item.visible) out.push(item);
  }
  return out;
}

async function executeActions(page, actions, prefix, state) {
  const reports = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    log(`  action ${i + 1}/${actions.length}: ${action.type}${action.selector ? ` ${action.selector}` : ''}`);
    switch (action.type) {
      case 'goto': {
        const target = resolveStoryboardUrl(String(action.url), runDir);
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
        break;
      }
      case 'click':
        await page.locator(action.selector).first().click({ timeout: 15_000 });
        break;
      case 'type':
        await page.locator(action.selector).first().fill(String(action.text ?? ''));
        break;
      case 'hover':
        await page.locator(action.selector).first().hover({ timeout: 15_000 });
        break;
      case 'scroll':
        await page.mouse.wheel(Number(action.x ?? 0), Number(action.y ?? 0));
        break;
      case 'wait':
        await sleep(Number(action.ms ?? 500));
        break;
      default:
        log(`  ! 不支持的 recon action：${action.type}`);
    }
    await sleep(action.waitAfter ?? 500);
    const shot = path.join(screensDir, `${prefix}-${String(i + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    const elements = await dumpElements(page);
    writeJson(path.join(reconDir, `elements-${prefix}-${String(i + 1).padStart(2, '0')}.json`), elements);
    reports.push({ action, screenshot: path.relative(runDir, shot), elements: elements.length });
    state.elements.push({ stage: `${prefix}-${i + 1}`, elements });
  }
  return reports;
}

async function main() {
  const brief = loadBrief();
  const configPath = args.flags.actions ? path.resolve(String(args.flags.actions)) : null;
  const probeActions = configPath ? readJson(configPath) : [];

  ensureDir(reconDir);
  ensureDir(screensDir);

  const width = Number(brief.video?.width ?? 1920);
  const height = Number(brief.video?.height ?? 1080);
  const url = resolveStoryboardUrl(brief.url, runDir);
  const auth = authPath(brief);
  const storageState = fs.existsSync(auth) ? auth : undefined;
  if (!storageState) log(`! 未找到登录态 ${auth}，按无登录侦察。`);

  log(`▶ 侦察 ${url}`);
  log(`  viewport ${width}x${height}${storageState ? '  + storageState' : ''}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width, height },
    storageState,
    locale: 'zh-CN',
    colorScheme: 'light',
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText || 'failed'}`);
  });

  const state = { url, title: '', elements: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await sleep(900);
    state.title = await page.title();

    const homeShot = path.join(screensDir, '00-home.png');
    await page.screenshot({ path: homeShot, fullPage: false });
    const homeElements = await dumpElements(page);
    writeJson(path.join(reconDir, 'elements-00-home.json'), homeElements);
    state.elements.push({ stage: 'home', elements: homeElements });

    let actionReports = [];
    if (probeActions.length) {
      actionReports = await executeActions(page, probeActions, 'probe', state);
    }

    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000);

    const lines = [];
    lines.push('# 侦察报告');
    lines.push('');
    lines.push(`- URL：${url}`);
    lines.push(`- 标题：${state.title}`);
    lines.push(`- viewport：${width}x${height}`);
    lines.push(`- 登录态：${storageState ? '已使用' : '无'}`);
    lines.push(`- 首页截图：\`${path.relative(runDir, homeShot)}\``);
    lines.push('');
    lines.push('## 控制台错误');
    lines.push('');
    if (consoleErrors.length) for (const e of consoleErrors) lines.push(`- ${e}`);
    else lines.push('无。');
    lines.push('');
    lines.push('## 页面异常');
    lines.push('');
    if (pageErrors.length) for (const e of pageErrors) lines.push(`- ${e}`);
    else lines.push('无。');
    lines.push('');
    lines.push('## 失败请求');
    lines.push('');
    if (failedRequests.length) for (const e of failedRequests) lines.push(`- ${e}`);
    else lines.push('无。');
    lines.push('');
    lines.push('## 页面文字（前 4000 字）');
    lines.push('');
    lines.push('```text');
    lines.push(bodyText);
    lines.push('```');
    lines.push('');
    lines.push('## 可交互元素（首页）');
    lines.push('');
    lines.push('| # | tag | 文本 | testid | role | name | placeholder | 候选选择器 |');
    lines.push('|---:|---|---|---|---|---|---|---|');
    homeElements.forEach((e, i) => {
      lines.push(`| ${i} | ${e.tag} | ${e.text.replace(/\|/g, '\\|')} | ${e.testid || ''} | ${e.role || ''} | ${e.name || ''} | ${e.placeholder || ''} | ${e.hints.join(' ') || ''} |`);
    });
    lines.push('');
    if (actionReports.length) {
      lines.push('## 探测动作');
      lines.push('');
      lines.push('| # | action | 截图 | 元素数 |');
      lines.push('|---:|---|---|---:|');
      actionReports.forEach((r, i) => {
        lines.push(`| ${i + 1} | ${r.action.type} ${r.action.selector || r.action.url || ''} | \`${r.screenshot}\` | ${r.elements} |`);
      });
      lines.push('');
      lines.push('每个探测步骤的完整元素列表在 `work/recon/elements-probe-NN.json`。');
      lines.push('');
    }
    lines.push('## 下一步');
    lines.push('');
    lines.push('1. 根据上面的元素和截图，为每个动作选 1 个稳定选择器（优先 testid / role / name / label，其次文本，最后 CSS）。多动作步骤用 `selectors` 数组。');
    lines.push('2. 写 `work/recon/selectors.json`：`{ "steps": [{ "step": 1, "selector": "...", "confidence": "high|medium|low", "note": "..." }] }`。');
    lines.push('3. 如果有弹窗/二级菜单，写一个 `probe.json` 动作序列再跑一次 recon，拿到弹窗里的元素。');
    lines.push('4. 低置信度不要硬猜，直接问用户或继续探测。');
    lines.push('');

    fs.writeFileSync(path.join(reconDir, 'recon.md'), `${lines.join('\n')}\n`);
    writeJson(path.join(reconDir, 'summary.json'), {
      url,
      title: state.title,
      viewport: { width, height },
      storageState: Boolean(storageState),
      consoleErrors,
      pageErrors,
      failedRequests,
      screenshots: fs.readdirSync(screensDir).sort(),
      elementCount: homeElements.length,
    });
    log(`✓ work/recon/recon.md`);
    log(`✓ work/recon/screenshots/（${fs.readdirSync(screensDir).length} 张）`);
    log(`✓ work/recon/elements-00-home.json（${homeElements.length} 个元素）`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n✗ 侦察失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
