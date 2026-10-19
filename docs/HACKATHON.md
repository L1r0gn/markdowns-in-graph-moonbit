# 参赛说明（MoonBit Hackathon 2026 · 十月赛）

## 一句话

**Markdowns In Graph** 是一个 VS Code 的关系图谱扩展；本期把它的计算内核
（Markdown 双链解析、链接解析、图谱构建、力导向布局）用 **MoonBit** 重写并编译为
**WebAssembly**，在真实的开发者工具里跑起来。

- 扩展本体：已在 Marketplace 生态内使用的 1.3.1 版本（本次基线）
- 本期新增：`core/`（MoonBit 源码 2262 行 + 测试 384 行）+ 宿主适配层 + 基准脚本
- 演示：打开任意 Markdown 笔记库 → `Ctrl+Alt+G` → 图谱实时渲染，
  布局由 `core.wasm` 逐帧计算

---

## 与验收标准的对应

| 验收标准 | 本项目如何满足 | 可检查的位置 |
| --- | --- | --- |
| **MoonBit 为主** | 解析器、索引、链接解析、构图、布局、JSON 序列化全部是 MoonBit；TypeScript 只剩 VS Code API 调用与 Canvas 绘制 | `core/**/*.mbt`（2262 行）vs `src/*.ts`（适配层，其中 `indexer.ts` 由 667 行降到 429 行） |
| **仓库公开** | 建议推送至 GitHub 公共仓库，保留本期 5 个提交 | `git log --oneline` |
| **能够运行** | `npm run core:build` → `npm run compile` → F5；或直接安装 `markdowns-in-graph-2.0.0.vsix`（wasm 产物已入库，无需装 MoonBit） | `README.md`「安装」「开发与调试」 |
| **工作有效** | 已有项目，但内核是本期从头实现的实质新增：`core/` 全部为新增文件，`src/indexer.ts` 由 667 行降到 429 行，且不再含任何解析、索引与图算法 | `git show --stat baa7b62` |
| **开源合规** | MIT；`core/` 亦为 MIT；参考来源在 `docs/MOONBIT.md` 注明（Obsidian 的链接解析规则、d3-force 的 Barnes-Hut 思路） | `LICENSE`、`core/moon.mod` |
| **AI 可解释** | 架构取舍、性能数据、已知限制全部写进 `docs/MOONBIT.md`；关键决策在下面「设计取舍」里逐条说明 | `docs/MOONBIT.md` |

---

## 复现（10 分钟）

```bash
git clone <repo> && cd markdowns-in-graph
npm install

# 1. 内核：单元测试
#    需要 moon 工具链（https://www.moonbitlang.com/download）
npm run core:test        # 33 passed

# 2. 一致性：旧 TS 解析器 ⇄ MoonBit 内核
npm run compile
npm run parity           # ✓ 12 个文件解析结果完全一致

# 3. 基准
npm run bench            # 建索引 ~4.7k 篇/秒；布局 1000 节点 ~815 帧/秒

# 4. 端到端：无头浏览器确认 Webview 真的用上了 wasm
node scripts/preview.js
npx http-server . -p 8765 &        # 或任意静态服务器
node scripts/smoke-core.js http://127.0.0.1:8765/scripts/preview.html
# 引擎： wasm / ✓ Webview 正在使用 MoonBit 内核

# 5. 在 VS Code 里跑
#    用 VS Code 打开项目，F5，然后在开发宿主里打开 example-vault
```

---

## 技术亮点

### 1. 双后端、双宿主

同一份 MoonBit 源码配置了 `wasm-gc` 与 `js` 两种链接产物：

- **扩展宿主（Node）**：`media/core.wasm` 通过 `WebAssembly.Module/Instance` 加载，
  负责解析与构图；
- **Webview（Chromium）**：同一个 wasm 负责逐帧力导向布局；
- 若运行时缺少 WasmGC / js-string 内建，自动退回 `media/core.mjs`，接口完全一致。

### 2. 字符串零拷贝过河

MoonBit 的 `String` 在 wasm-gc 里是 GC 数组，和 JS 字符串不兼容。
开启 `use-js-builtin-string` 后，编译器把 `String` 编译为 JS 字符串，
并用 `wasm:js-string` 内建指令操作它；模块里的字符串字面量以
`_` 模块的 `externref` 全局导入，宿主用一个 `Proxy` 把「变量名」当作值提供：

```ts
const strings = new Proxy({}, { get: (_t, key) => (typeof key === 'symbol' ? undefined : key) });
const module = new WebAssembly.Module(bytes, { builtins: ['js-string'], importedStringConstants: '_' });
const instance = new WebAssembly.Instance(module, { _: strings });
```

于是宿主与内核之间只有 `String` 与数值两种值，没有手写内存布局、没有 free。

### 3. 布局接口走数值，不过 JSON

Webview 每帧只调用 `layout_step(alpha, rest, repulsion)` 与 `2N` 次
`layout_x/layout_y`，避免把上千个坐标序列化成字符串再解析。

### 4. 确定性布局

四叉树用扁平对象池（每帧只重置计数器，不新建对象），随机扰动来自固定种子的 LCG。
**同样的输入永远得到同样的布局** —— 这让截图回归与单元测试成为可能。

---

## 设计取舍（诚实记录）

| 决策 | 理由 | 代价 |
| --- | --- | --- |
| 只迁移计算内核，UI 保持 TS | 交互层与 VS Code API 强耦合，迁移收益低、风险高 | 仓库里仍有约 1000 行 JS 负责绘制 |
| 保留旧 TS 解析器在 `src/legacy/` | 作为一致性回归与基准的参照物，证明语义未变 | 多一份「死代码」 |
| 手写 JSON 序列化 | 通用序列化会为每个对象建 Map，48000 条边时开销超过算法本身 | 需要自己处理转义 |
| wasm 解析比 V8 正则略慢 | V8 的字符串是 UTF-16 且切片 O(1)，wasm 侧要字符化与 UTF-8 编码 | 见 `docs/MOONBIT.md` §8 的解读 |
| 布局与解析放同一个模块 | 一次加载、两处使用，减少产物数量 | 模块体积 85 KB |

---

## AI 使用说明

本项目在 AI 辅助下完成，但目标、边界与质量门禁由作者掌握：

- **由人决定**：内核边界的划分（哪些逻辑进 MoonBit）、ABI 形状（字符串 + 数值）、
  失败时的降级策略、验收标准（一致性回归必须通过）。
- **由人验证**：每一条 MoonBit 代码都由 `moon check` / `moon test` / `parity` /
  冒烟测试验证；没有「写完就算」的模块。
- **可追溯**：`docs/MOONBIT.md` 记录了每个设计取舍的原因，基准数据可复现
  （`npm run bench`）。

---

## 后续计划

1. 把 Webview 的筛选、搜索与 BFS 局部图也搬进内核，让渲染层只负责绘制；
2. 支持多根工作区（内核已经是多实例友好的结构，只差会话管理）；
3. 把布局内核单独发布成 MoonBit 包，供其它可视化项目复用。
