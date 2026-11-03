#!/usr/bin/env node
/**
 * 通用无头登录 → storageState(auth.json)
 *
 *   node .agents/skills/web-tour-video/scripts/headless-login.mjs \
 *     --url https://app.example.com \
 *     --out runs/<slug>/auth.json \
 *     --secrets runs/<slug>/work/secrets.json \
 *     --user-selector '#username' --pass-selector '#password' \
 *     --submit-selector 'button[type="submit"]' \
 *     --success-selector 'nav'
 *
 * 凭据来源优先级：--secrets JSON > LOGIN_USER/LOGIN_PASS > 环境变量。
 * secrets.json: { "username": "...", "password": "..." }
 * 不打印密码；成功后可截图，供人工确认落地页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const url = opt('url');
const out = opt('out');
const secretsFile = opt('secrets');
const userSel = opt('user-selector', '#username');
const passSel = opt('pass-selector', '#password');
const submitSel = opt('submit-selector', 'button[type="submit"]');
const successSel = opt('success-selector');
const screenshot = opt('screenshot');
const timeout = Number(opt('timeout', 30000));

if (!url || !out) {
  console.error('用法：node .agents/skills/web-tour-video/scripts/headless-login.mjs --url <登录页> --out <auth.json> [--secrets <secrets.json>] [--user-selector ...] [--pass-selector ...] [--submit-selector ...] [--success-selector ...] [--screenshot <png>]');
  process.exit(1);
}

function loadCreds() {
  if (secretsFile && fs.existsSync(secretsFile)) {
    const raw = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    const username = raw.username || raw.user || raw.email;
    const password = raw.password || raw.pass;
    if (username && password) return { username, password };
  }
  if (process.env.LOGIN_USER && process.env.LOGIN_PASS) {
    return { username: process.env.LOGIN_USER, password: process.env.LOGIN_PASS };
  }
  throw new Error('缺少凭据：提供 --secrets <json>（{username,password}）或 LOGIN_USER/LOGIN_PASS');
}

const { username, password } = loadCreds();
console.log(`▶ 无头登录 ${url}（账号长度 ${username.length}）`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-CN',
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.setDefaultTimeout(timeout);
page.setDefaultNavigationTimeout(timeout);

let loginStatus = null;
page.on('response', (res) => {
  if (/login|signin|session|token/i.test(res.url()) && res.request().method() === 'POST') {
    loginStatus = res.status();
  }
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.locator(userSel).first().fill(username);
  await page.locator(passSel).first().fill(password);
  await page.locator(submitSel).first().click();

  if (successSel) {
    await page.locator(successSel).first().waitFor({ state: 'visible', timeout });
  } else {
    await page.waitForTimeout(3000);
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await context.storageState({ path: out });
  fs.chmodSync(out, 0o600);
  if (screenshot) {
    fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    await page.screenshot({ path: screenshot });
  }
  const cookies = JSON.parse(fs.readFileSync(out, 'utf8')).cookies || [];
  console.log(`✓ 登录完成（HTTP ${loginStatus ?? '?'}），auth.json ${cookies.length} 个 cookie`);
  if (screenshot) console.log(`✓ 落地页截图：${screenshot}`);
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
