/**
 * 用 CDP 对预览页截图（真实等待指定毫秒，能正确捕获 canvas 内容）
 * 用法: node scripts/shot.js <url> <out.png> [waitMs] [actionsJson]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const waitMs = Number(process.argv[4] || 3500);
const actions = process.argv[5] ? JSON.parse(process.argv[5]) : [];

const port = 9333;
const userDir = path.join(os.tmpdir(), 'edge-shot-profile-' + Date.now());

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--window-size=1400,900',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDir,
  'about:blank'
], { stdio: 'ignore' });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { /* retry */ }
    await sleep(200);
  }
  throw new Error('无法连接 CDP');
}

(async () => {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false
  });

  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text + ' ' +
        (msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description || ''));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await send('Page.navigate', { url });
  await sleep(waitMs);

  for (const action of actions) {
    if (action.type === 'mouse') {
      await send('Input.dispatchMouseEvent', {
        type: action.event, x: action.x, y: action.y, button: action.button || 'left',
        clickCount: action.clickCount || 1, buttons: action.event === 'mouseMoved' ? 0 : 1
      });
    } else if (action.type === 'wheel') {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: action.x, y: action.y, deltaX: 0, deltaY: action.deltaY
      });
    } else if (action.type === 'key') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, text: action.text || '' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key });
    } else if (action.type === 'eval') {
      const r = await send('Runtime.evaluate', { expression: action.expr, returnByValue: true });
      console.log('eval>', JSON.stringify(r.result && r.result.value));
    } else if (action.type === 'wait') {
      await sleep(action.ms || 500);
    }
  }

  await sleep(200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out, errors.length ? '\n页面错误: ' + errors.join('\n') : '');

  ws.close();
  child.kill();
  setTimeout(() => process.exit(errors.length ? 1 : 0), 300);
})().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
