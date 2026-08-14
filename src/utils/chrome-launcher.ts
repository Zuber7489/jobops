import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

import { CONFIG } from '../config';

export function isChromeCdpRunning(port: number = 9222): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function findChromePath(): string | null {
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function ensureChromeCdpRunning(port: number = 9222): Promise<boolean> {
  const running = await isChromeCdpRunning(port);
  if (running) {
    console.log(`✅ [Chrome Launcher] Chrome CDP session already active on port ${port}`);
    return true;
  }

  const chromePath = findChromePath();
  const userDataDir = CONFIG.userDataDir;
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  console.log(`🚀 [Chrome Launcher] Opening visible Chrome browser on port ${port}...`);

  try {
    if (chromePath) {
      spawn(chromePath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        'https://www.linkedin.com'
      ], { detached: true, stdio: 'ignore' }).unref();
    } else {
      await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--remote-debugging-port=${port}`, '--no-first-run', '--start-maximized'],
        viewport: null
      });
    }

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isChromeCdpRunning(port)) {
        console.log(`✅ [Chrome Launcher] Visible Chrome window active on port ${port}`);
        return true;
      }
    }

    return true;
  } catch (e: any) {
    console.error(`❌ [Chrome Launcher Error]: ${e.message}`);
    return false;
  }
}
