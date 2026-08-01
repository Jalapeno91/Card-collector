// Test runner: starts the static server and a headless Chrome, runs each
// suite in turn, then tears both down. Run: npm test

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LEDGER_PORT) || 8765;
const CDP = Number(process.env.LEDGER_CDP) || 9222;
const SUITES = ['smoke.test.mjs', 'storage.test.mjs', 'ledger-sort.test.mjs', 'scan.test.mjs', 'sync.test.mjs'];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome',
].filter(Boolean);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function waitForCdp(timeoutMs = 15000){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    try{
      const res = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (res.ok) return true;
    }catch(e){ /* not up yet */ }
    await wait(250);
  }
  return false;
}

const server = createStaticServer();
await new Promise(res => server.listen(PORT, '127.0.0.1', res));
console.log(`server  → http://127.0.0.1:${PORT}/`);

const profile = mkdtempSync(join(tmpdir(), 'ledger-chrome-'));
let chrome = null;
for (const bin of CHROME_CANDIDATES){
  try{
    chrome = spawn(bin, [
      '--headless=new',
      `--remote-debugging-port=${CDP}`,
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: 'ignore' });
    await wait(500);
    if (chrome.exitCode === null) break;
  }catch(e){ chrome = null; }
}

if (!chrome || !(await waitForCdp())){
  console.error('Could not start a headless Chrome. Set CHROME_PATH to a browser binary.');
  chrome?.kill();
  server.close();
  process.exit(1);
}
console.log(`browser → CDP on ${CDP}\n`);

let failed = 0;
for (const suite of SUITES){
  console.log(`── ${suite.replace('.test.mjs', '')} ${'─'.repeat(Math.max(0, 50 - suite.length))}`);
  const code = await new Promise(res => {
    const p = spawn(process.execPath, [join(HERE, suite)], {
      stdio: 'inherit',
      env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_CDP: String(CDP) },
    });
    p.on('exit', res);
  });
  if (code !== 0) failed++;
  console.log('');
}

// Let Chrome finish flushing its profile before the directory goes away.
const exited = new Promise(res => chrome.on('exit', res));
chrome.kill();
await Promise.race([exited, wait(3000)]);
server.close();
try{ rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch(e){ /* a stray lock file in a temp dir is not worth failing the run over */ }

console.log(failed ? `${failed} suite(s) failed` : 'all suites passed');
process.exit(failed ? 1 : 0);
