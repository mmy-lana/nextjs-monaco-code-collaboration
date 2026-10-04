import { launchBrowser } from './verify/harness.mjs';
const s = await launchBrowser({});
const page = await s.browser.newPage();
await page.setViewport({width:1440,height:900});
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0,200)));
page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE: ' + m.text().slice(0,200)); });
await page.goto('http://127.0.0.1:3210',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForSelector('.monaco-editor',{timeout:60000});
await new Promise(r=>setTimeout(r,5000));
const state = await page.evaluate(() => {
  const lines = document.querySelector('.monaco-editor .view-lines');
  return {
    text: (lines?.innerText ?? '').replace(/\s+/g,' ').trim().slice(0,140),
    lineCount: lines?.children.length ?? 0,
    active: document.querySelector('[data-testid="status-bar"]')?.textContent?.slice(0,80),
  };
});
console.log('EDITOR CONTENT:', JSON.stringify(state.text));
console.log('RENDERED LINES:', state.lineCount);
console.log('STATUS:', state.active);
console.log('ERRORS:', errors.length ? errors : 'none');
await s.close();
