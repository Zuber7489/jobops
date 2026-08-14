import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

export function isChromeCdpRunning(port: number = 9222): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => {
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
  if (!chromePath) {
    console.warn(`⚠️ [Chrome Launcher] Chrome executable not found in default system paths.`);
    return false;
  }

  console.log(`🚀 [Chrome Launcher] Automatically launching Chrome with --remote-debugging-port=${port}...`);
  
  const userDataDir = path.join(process.cwd(), '.chrome-user-data');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'https://www.linkedin.com'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Wait up to 5 seconds for port 9222 to become active
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isChromeCdpRunning(port)) {
      console.log(`✅ [Chrome Launcher] Chrome launched successfully on port ${port}`);
      return true;
    }
  }

  return false;
}
