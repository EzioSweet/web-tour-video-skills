#!/usr/bin/env node
/**
 * 生成 Safari 风格浏览器外框（交通灯 + 标签页 + 地址栏）PNG。
 *
 *   node .agents/skills/web-tour-video/lib/browser_chrome.mjs --out out/chrome.png --height 76 \
 *     --title "Example App" --url "app.example.com"
 *
 * 用 Playwright 渲染 HTML，避免引入 Python/PIL 依赖；只画 UI，不含账号信息。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const out = opt('out');
const width = Number(opt('width', 1920));
const height = Number(opt('height', 76));
const title = opt('title', 'Example App');
const url = opt('url', 'app.example.com');
if (!out) {
  console.error('缺少 --out');
  process.exit(1);
}

const tabH = Math.round(height / 2);
const toolbarH = height - tabH;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin:0; padding:0; width:${width}px; height:${height}px; overflow:hidden;
    font-family: -apple-system, "Helvetica Neue", "Noto Sans CJK SC", "DejaVu Sans", sans-serif; }
  .tabbar { position:relative; height:${tabH}px; background:#e1e1e2; border-bottom:1px solid #c6c6c8; box-sizing:border-box; }
  .lights { position:absolute; left:16px; top:${Math.round(tabH / 2) - 6}px; display:flex; gap:8px; }
  .light { width:12px; height:12px; border-radius:50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18); }
  .tab { position:absolute; left:92px; top:7px; width:280px; height:${tabH + 2 - 7}px; background:#fafafa;
    border-radius:7px 7px 0 0; display:flex; align-items:center; gap:8px; padding:0 12px; box-sizing:border-box; z-index:2; }
  .fav { width:16px; height:16px; border-radius:4px; background:#1a73e8; color:#fff; font-size:11px; font-weight:700;
    display:flex; align-items:center; justify-content:center; flex:none; }
  .title { font-size:12px; color:#2d2d2e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; }
  .close { font-size:13px; color:#6e6e70; line-height:1; flex:none; }
  .toolbar { position:relative; height:${toolbarH}px; background:#f5f5f6; display:flex; align-items:center; }
  .left, .right { position:absolute; top:0; height:100%; display:flex; align-items:center; gap:18px; }
  .left { left:18px; }
  .right { right:22px; gap:22px; }
  .pill { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:760px; height:28px;
    background:#ebebec; border:1px solid #d6d6d8; border-radius:8px; display:flex; align-items:center; box-sizing:border-box; }
  .lock { margin-left:14px; flex:none; }
  .urltxt { position:absolute; left:0; right:0; text-align:center; font-size:12.5px; color:#2d2d2e;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 36px; box-sizing:border-box; }
  svg { display:block; }
</style></head><body>
  <div class="tabbar">
    <div class="lights">
      <div class="light" style="background:#ff5f57"></div>
      <div class="light" style="background:#febc2e"></div>
      <div class="light" style="background:#28c840"></div>
    </div>
    <div class="tab">
      <div class="fav">C</div>
      <div class="title">${esc(title)}</div>
      <div class="close">✕</div>
    </div>
  </div>
  <div class="toolbar">
    <div class="left">
      <svg width="12" height="16" viewBox="0 0 12 16"><path d="M10 2 L3 8 L10 14" fill="none" stroke="#6e6e70" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg width="12" height="16" viewBox="0 0 12 16"><path d="M2 2 L9 8 L2 14" fill="none" stroke="#bcbcbe" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg width="18" height="14" viewBox="0 0 18 14"><rect x="0.7" y="0.7" width="16.6" height="12.6" rx="2" fill="none" stroke="#6e6e70" stroke-width="1.4"/><line x1="7" y1="0.7" x2="7" y2="13.3" stroke="#6e6e70" stroke-width="1.4"/></svg>
    </div>
    <div class="pill">
      <svg class="lock" width="10" height="11" viewBox="0 0 10 11"><path d="M2.6 4.4 V3.2 a2.4 2.4 0 0 1 4.8 0 V4.4" fill="none" stroke="#6e6e70" stroke-width="1.3"/><rect x="1.4" y="4.2" width="7.2" height="6.2" rx="1.4" fill="#6e6e70"/></svg>
      <div class="urltxt">${esc(url)}</div>
    </div>
    <div class="right">
      <svg width="14" height="16" viewBox="0 0 14 16"><path d="M7 1 V11" stroke="#6e6e70" stroke-width="1.5" stroke-linecap="round"/><path d="M3 5 L7 1 L11 5" fill="none" stroke="#6e6e70" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1.5 9 V14.5 H12.5 V9" fill="none" stroke="#6e6e70" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2 V14 M2 8 H14" stroke="#6e6e70" stroke-width="1.6" stroke-linecap="round"/></svg>
      <svg width="20" height="16" viewBox="0 0 20 16"><rect x="0.7" y="0.7" width="14.6" height="11.6" rx="2" fill="none" stroke="#6e6e70" stroke-width="1.4"/><path d="M18 3.6 V15 H4" fill="none" stroke="#6e6e70" stroke-width="1.4" stroke-linecap="round"/></svg>
    </div>
  </div>
</body></html>`;

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: out });
} finally {
  await browser.close();
}
console.log(`✓ ${out}  ${width}x${height}`);
