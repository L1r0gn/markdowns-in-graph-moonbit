/**
 * 无头冒烟测试：在 jsdom 中加载 Webview 脚本，注入模拟图谱数据，
 * 验证渲染循环、筛选、搜索、聚焦、右键菜单等路径不抛异常。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = 'F:/markdowns_in_graph';
const panelSrc = fs.readFileSync(path.join(root, 'src/graphPanel.ts'), 'utf8');
const bodyStart = panelSrc.indexOf('<body>') + '<body>'.length;
const bodyEnd = panelSrc.indexOf('<script nonce');
if (bodyStart < 0 || bodyEnd < 0) throw new Error('无法从 graphPanel.ts 提取 body');
const bodyHtml = panelSrc.slice(bodyStart, bodyEnd);

const graphJs = fs.readFileSync(path.join(root, 'media/graph.js'), 'utf8');

const dom = new JSDOM(`<!DOCTYPE html><html><body class="vscode-dark">${bodyHtml}</body></html>`, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://localhost/'
});
const { window } = dom;

const messages = [];
const errors = [];
let ctxCalls = 0;

function makeCtx() {
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'canvas') return window.document.querySelector('#graph');
      return function () { ctxCalls++; };
    },
    set(t, prop, value) { t[prop] = value; return true; }
  });
}

window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(); };
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { width: 1280, height: 820, left: 0, top: 0, right: 1280, bottom: 820, x: 0, y: 0 };
};
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.id === 'graph') {
    return { width: 1280, height: 820, left: 0, top: 0, right: 1280, bottom: 820, x: 0, y: 0 };
  }
  return { width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0 };
};
window.acquireVsCodeApi = function () {
  return {
    postMessage(m) { messages.push(m); },
    setState() {},
    getState() { return undefined; }
  };
};
window.addEventListener('error', (e) => errors.push('window error: ' + e.message));

// 执行 webview 脚本
window.eval(graphJs);

// 构造测试图谱
const nodes = [];
const links = [];
const folders = ['', 'notes', 'notes/深层', 'projects'];
for (let i = 0; i < 40; i++) {
  const folder = folders[i % folders.length];
  const id = (folder ? folder + '/' : '') + 'note-' + i + '.md';
  nodes.push({
    id, label: 'note-' + i, path: id, kind: 'note', ext: '.md',
    folder, tags: i % 3 === 0 ? ['moc', 'tag-' + (i % 5)] : ['tag-' + (i % 7)],
    size: 100, mtime: Date.now(), degree: 0
  });
}
nodes.push({ id: 'u:missing note', label: 'missing note', path: 'missing note', kind: 'unresolved', ext: '', folder: '', tags: [], size: 0, mtime: 0, degree: 0 });
nodes.push({ id: 'assets/pic.png', label: 'pic', path: 'assets/pic.png', kind: 'attachment', ext: '.png', folder: 'assets', tags: [], size: 10, mtime: 0, degree: 0 });

for (let i = 0; i < 40; i++) {
  links.push({ source: nodes[i].id, target: nodes[(i * 3 + 7) % 40].id, kind: i % 4 === 0 ? 'md' : 'wiki' });
  if (i % 5 === 0) links.push({ source: nodes[i].id, target: 'u:missing note', kind: 'wiki' });
  if (i === 3) links.push({ source: nodes[i].id, target: 'assets/pic.png', kind: 'embed' });
}
const data = {
  nodes, links,
  stats: { notes: 40, attachments: 1, unresolved: 1, links: links.length },
  generatedAt: Date.now(), rootName: 'demo'
};

function send(msg) {
  window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async function run() {
  await wait(60);
  send({ type: 'config', changed: false, config: {
    showOrphans: true, showUnresolved: true, showAttachments: false,
    colorMode: 'folder', nodeScale: 1, linkDistance: 70, repulsion: 1,
    labelThreshold: 0.5, openInNewTab: false
  }});
  send({ type: 'graph', data, reset: true });
  await wait(500);

  const stats = window.document.querySelector('#stats').textContent;
  const legend = window.document.querySelector('#legend').textContent;
  const folderChips = window.document.querySelectorAll('#folder-chips .chip').length;
  const tagChips = window.document.querySelectorAll('#tag-chips .chip').length;
  console.log('ready 消息:', messages.filter((m) => m.type === 'ready').length);
  console.log('stats:', stats);
  console.log('legend:', legend);
  console.log('folder chips:', folderChips, 'tag chips:', tagChips);
  console.log('canvas 绘制调用:', ctxCalls);

  // 搜索
  const search = window.document.querySelector('#search');
  search.value = 'missing';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(120);
  console.log('搜索后 stats:', window.document.querySelector('#stats').textContent);
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));

  // 筛选：显示附件
  const att = window.document.querySelector('#f-attachments');
  att.checked = true;
  att.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);

  // 聚焦（模拟 showLocal）
  send({ type: 'focus', path: 'notes/note-1.md', depth: 2 });
  await wait(200);
  console.log('聚焦后 stats:', window.document.querySelector('#stats').textContent);
  console.log('焦点名称:', window.document.querySelector('#focus-name').textContent);

  // 深度切换
  const depthBtn = window.document.querySelector('#depth-group button[data-depth="3"]');
  depthBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);

  // 清除聚焦
  window.document.querySelector('#focus-clear').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);

  // 工具栏
  window.document.querySelector('#btn-zoom-in').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  window.document.querySelector('#btn-fit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  window.document.querySelector('#btn-panel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);

  // 键盘
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '0' }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '+' }));

  // 画布交互：滚轮 / 拖拽平移 / 点击节点 / 右键菜单
  const canvas = window.document.querySelector('#graph');
  canvas.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -120, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
  canvas.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, clientX: 200, clientY: 200, bubbles: true }));
  canvas.dispatchEvent(new window.MouseEvent('pointermove', { button: 0, clientX: 260, clientY: 250, bubbles: true }));
  canvas.dispatchEvent(new window.MouseEvent('pointerup', { button: 0, clientX: 260, clientY: 250, bubbles: true }));
  const tip = window.document.querySelector('#tip');
  let hitPoint = null;
  for (let y = 8; y < 800 && !hitPoint; y += 6) {
    for (let x = 8; x < 1280; x += 6) {
      canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
      if (!tip.classList.contains('hidden')) { hitPoint = { x, y }; break; }
    }
  }
  console.log('悬停命中节点:', !!hitPoint, hitPoint || '');
  if (hitPoint) {
    canvas.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: hitPoint.x, clientY: hitPoint.y, bubbles: true, cancelable: true }));
  }
  await wait(120);
  console.log('右键菜单项:', window.document.querySelectorAll('#menu .menu-item').length);

  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

  // 布局参数
  const dist = window.document.querySelector('#s-dist');
  dist.value = '120';
  dist.dispatchEvent(new window.Event('input', { bubbles: true }));
  const color = window.document.querySelector('#s-color');
  color.value = 'degree';
  color.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(300);

  // 空数据
  send({ type: 'graph', data: { nodes: [], links: [], stats: { notes: 0, attachments: 0, unresolved: 0, links: 0 }, generatedAt: Date.now(), rootName: '' }, reset: true });
  await wait(100);
  console.log('空状态可见:', !window.document.querySelector('#empty').classList.contains('hidden'));

  console.log('postMessage 类型:', Array.from(new Set(messages.map((m) => m.type))).join(','));
  console.log('运行时错误:', errors.length ? errors : '无');
  process.exit(errors.length ? 1 : 0);
})();
