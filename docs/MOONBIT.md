# MoonBit 内核设计说明

> 本文记录 v2.0 重构的动机、边界划分与工程细节，对应代码位于仓库 `core/`。

---

## 1. 为什么要重构

v1.3 的插件里，一个 `.md` 文件从磁盘到画布要经过三次实现层面的"信任跃迁"：

1. `markdownParser.ts` 用三条回溯正则扫描文本，任何新增语法都要同步维护正则与边界条件；
2. `indexer.ts` 用 `Map<string, FileRecord>` 维护两套索引，名字解析规则散落在多个分支；
3. `media/graph.js` 每帧新建上千个四叉树对象，靠 `Math.random()` 打破对称。

这三处都是**高性能、强约束、纯计算**的逻辑，却写在动态类型、随手可改的 TS/JS 里。
于是我们把它们整体搬进 MoonBit：

| 关注点 | 重构前的风险 | 重构后的做法 |
| --- | --- | --- |
| 类型 | 解析结果的形状靠约定，改字段容易漏改 | `RawLink` / `FileEntry` / `GraphNode` 全是编译期检查的结构体 |
| 正则回溯 | 畸形输入可能触发灾难性回溯 | 字符级单遍扫描，O(n)，无回溯 |
| 内存 | 每帧新建树节点，GC 抖动 | 扁平四叉树对象池，每帧只重置计数器 |
| 可复现 | `Math.random()` 让布局不可测 | 固定种子 LCG，输入相同 ⇒ 布局相同 |
| 复用 | 逻辑只能在 VS Code 里跑 | 同一份源码产出 wasm 与 js，任意宿主可加载 |

扩展的交互层（命令、面板、Canvas 绘制）保持原样——**重构范围严格限定在计算内核**，
因此 1.3 的全部交互能力（缩放、聚焦、筛选、搜索、拖拽固定、状态记忆）都保留下来。

---

## 2. 架构

```
┌──────────────────────── VS Code 扩展宿主（Node） ────────────────────────┐
│                                                                          │
│  extension.ts ──► indexer.ts ──┐                                         │
│                                │  ① 读取文件（vscode.workspace.fs）       │
│                                │  ② vault_add_note(rel, size, mtime, text)│
│                                │  ③ vault_build_graph(...) -> JSON        │
│                                ▼                                         │
│                        ┌───────────────────┐                             │
│                        │  core.wasm        │  MoonBit 内核               │
│                        │  （wasm-gc）      │  mdparse / vault / layout   │
│                        └───────────────────┘                             │
│                                │                                         │
│  graphPanel.ts ◄───────────────┘  postMessage(GraphData)                 │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │ Webview（Chromium）
                                 ▼
                      media/graph.js（绘制 / 交互）
                                 │ 每帧：layout_step / layout_x / layout_y
                                 ▼
                        core.wasm（同一份内核的布局部分）
```

宿主与内核之间只有**两种值**：

- `String`：文件路径、Markdown 原文、JSON 结果；
- 数值：`Int`（下标、计数）与 `Double`（坐标、alpha、弹簧长度）。

没有任何共享内存布局、没有手写序列化协议，也不需要 `dealloc`。

---

## 3. 包结构

| 包 | 代码 | 职责 |
| --- | --- | --- |
| `path` | `core/path/posix.mbt` | `dirname` / `basename` / `extname` / `strip_ext` / `normalize` / `join` / `depth` / `has_dot_segment` / `decode_uri` |
| `mdparse` | `core/mdparse/scan.mbt` | 双链、标准链接、行内标签、Frontmatter 标签、围栏代码与行内代码跳过 |
| `vault` | `core/vault/vault.mbt` | 文件索引、`byPath`/`byName` 查找表、Obsidian「最短路径优先」解析、目录统计 |
| `vault` | `core/vault/graph.mbt` | 构图：节点/边/度数/统计、幽灵节点、未引用附件剔除、边去重 |
| `vault` | `core/vault/json.mbt` | 手写 JSON 序列化（避免通用序列化的中间对象） |
| `layout` | `core/layout/sim.mbt` | Barnes-Hut 四叉树、弹簧力、向心力、阻尼积分、网格碰撞消解 |
| 根包 | `core/abi.mbt` | `#export_name` 导出的宿主接口与全局状态 |

### 解析器要点

- **单次字符化**：整篇文本只做一次 `String -> Array[Char]`，之后所有匹配都在
  `(数组, 起, 止)` 上进行；只有真正命中的链接才构造 `String`。
- **行扫描**：`\n` / `\r\n` / `\r` 都作为换行，行号从 1 开始，与旧实现一致。
- **优先看 Frontmatter**：首行是 `---` 时先解析前 400 行内的 `tags/tag/keywords`，
  正文从结束标记之后开始，因此 Frontmatter 里的 `[[..]]` 不会被误识别。
- **围栏与行内代码**：围栏记录开启标记（反引号/波浪号）与长度，闭合需同字符且不短于开启；
  行内代码被覆盖成空格，避免其中的双链被识别。
- **标签字符集**：ASCII 字母数字 + `_ - /` + 非 ASCII 文字，但排除 CJK 标点
  （`，。、《》` 等），这是 JS 正则 `\p{L}\p{N}` 的等价近似。

### 链接解析规则

按 Obsidian 的「最短路径优先」，依次尝试：

1. 相对当前文件所在目录（`./`、`../` 与裸路径都会先试这一步）；
2. 相对工作区根目录；
3. 按文件名兜底：唯一命中直接用；多个同名时优先同目录，否则取层级最浅、路径字典序最小者。

解析结果按「目录 + 原始目标」缓存，任何写操作（新增/更新/删除文件）都会让缓存失效。

### 布局要点

- 四叉树用 `Array[Quad]` 池 + `used` 计数器，每帧只重置指针，不产生新对象；
- Barnes-Hut 判定：`w² / d² < 0.81` 时把象限视为质点；
- 速度上限 12、阻尼 0.58、向心系数 0.0013、弹簧系数 0.045 —— 与 v1.3 的 JS 实现同值，
  因此替换内核后视觉表现连续；
- 碰撞消解用 48px 网格 + 3×3 邻域，只处理 `j > i` 的节点对。

---

## 4. 宿主 ABI

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `core_version` | `() -> String` | 内核版本 |
| `core_selftest` | `() -> String` | 跑一遍最小闭环，返回 `ok:2`；加载器用它确认运行时真的可用 |
| `parse_markdown_json` | `(text) -> String` | 调试/契约测试用：返回 `{links,tags}` |
| `vault_reset` | `() -> ()` | 清空索引 |
| `vault_add_note` | `(rel, size, mtime, text)` | 写入笔记（内部完成解析） |
| `vault_add_attachment` | `(rel, size, mtime)` | 写入附件（不解析） |
| `vault_remove` | `(rel)` | 删除文件 |
| `vault_count` / `vault_note_count` | `() -> Int` | 文件数 / 笔记数 |
| `vault_build_graph` | `(maxTags, generatedAt, rootName) -> String` | 构图，返回 `GraphData` JSON |
| `vault_folders` | `() -> String` | `[{path,count}]` |
| `vault_resolve` | `(fromRel, target) -> String` | 诊断：解析链接目标 |
| `layout_reset` / `layout_add_node` / `layout_add_link` / `layout_seed` | | 组装布局图 |
| `layout_pin` / `layout_unpin` / `layout_move` | `(i, x, y)` | 固定 / 解除 / 拖动 |
| `layout_step` | `(alpha, rest, repulsion)` | 推进一帧 |
| `layout_x` / `layout_y` / `layout_count` | | 读取坐标 |

---

## 5. 跨语言边界：字符串怎么过河

MoonBit 的 `String` 在 wasm-gc 里是 GC 数组，和 JS 字符串并不兼容。
开启 `use-js-builtin-string` 后，编译器把 `String` 编译为 JS 字符串，
并使用 `wasm:js-string` 内建指令（`length` / `charCodeAt` / `concat` / `fromCharCodeArray`）操作它。

代价是模块会用 `externref` 全局变量导入**所有字符串字面量**：

```wat
(import "_" "\"id\":\"" (global externref))
(import "_" ",\"degree\":" (global externref))
...
```

宿主侧只需一个 `Proxy` 把这些全局变量的「变量名」当成值返回：

```ts
const strings = new Proxy({}, {
  get: (_t, key) => (typeof key === 'symbol' ? undefined : key)
});
const module = new WebAssembly.Module(bytes, {
  builtins: ['js-string'],
  importedStringConstants: '_'
});
const instance = new WebAssembly.Instance(module, { _: strings });
```

> 这套组合在 Node 22（Electron 扩展宿主）与 Chromium 130+（Webview）上验证可用；
> 如果某个运行时缺失该提案，`MoonCore.load()` 会捕获异常并改用 `media/core.mjs`。

---

## 6. 构建

```bash
npm run core:build     # wasm-gc + js，产物复制到 media/
npm run core:check     # 只做类型检查
npm run core:test      # 33 个单元测试
```

`scripts/build-core.js` 会依次执行：

```bash
moon -C core build --target wasm-gc --release   # → media/core.wasm
moon -C core build --target js      --release   # → media/core.mjs
```

`media/core.wasm` 与 `media/core.mjs` 是**构建产物但会提交到仓库**，原因有两个：
安装扩展的用户不需要装 MoonBit 工具链；评审可以直接 `git clone` 后试跑。

### Windows 上的已知问题

部分 Windows 环境里 `moonc` 无法打开以 `\\?\` 开头的 verbatim 路径，
会抛出 `Sys_error("\\\\?": Invalid argument")`。这是工具链在 Windows 上的路径处理问题，
与项目代码无关。临时绕法：写一个去掉该前缀的包装器，并用 `MOONC_OVERRIDE` 指给 `moon`。

```python
# moonc_shim.py
import subprocess, sys
MOONC = r"C:\Users\<you>\.moon\bin\moonc.exe"
args = [a[4:] if a.startswith("\\\\?\\") else a for a in sys.argv[1:]]
sys.exit(subprocess.call([MOONC] + args))
```

```bash
MOONC_OVERRIDE=/path/to/moonc_shim.cmd npm run core:build
```

Linux / macOS / CI 上不需要这一步。

---

## 7. 测试策略

| 层次 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 单元测试 | `npm run core:test` | 路径运算、链接/标签解析、Frontmatter、围栏、解析规则、构图、布局收敛与可复现性（33 个用例） |
| 一致性回归 | `npm run parity` | 用重构前的 TS 解析器逐文件比对 `target/kind/line/tags`，任何差异都会失败 |
| 宿主集成 | `node scripts/test-indexer.js` | 桩 `vscode` 模块跑完整索引流程 |
| Webview 冒烟 | `npm run smoke` | 无头浏览器加载预览页，断言 `window.__graphCore === 'wasm'`、无异常、canvas 有绘制 |
| 基准 | `npm run bench` | 解析吞吐、端到端建索引、1000 节点布局帧耗时 |

一致性回归是最关键的一道闸门：它保证这次重构**没有改变任何图谱语义**，
只是把实现换了语言。

---

## 8. 基准与解读

1200 篇合成笔记 / 2.7 MB / 96000 条链接（本机 Node 22 + Windows）：

| 阶段 | 耗时 |
| --- | --- |
| 端到端建索引（解析 + 解析链接 + 构图，全在 MoonBit 内） | ~250 ms（约 4.7k 篇/秒） |
| 单篇解析（含 JSON 序列化） | ~0.1 ms |
| 布局 1000 节点 | 1.2 ms/帧（约 815 帧/秒） |

关于「解析比 v1.3 的 TS 慢一点」：V8 的字符串是 UTF-16 且切片是 O(1) 的结构共享，
而 wasm 侧需要 `String -> Array[Char]` 与逐字符 UTF-8 编码。用 Rust 的 `regex` 去对比
V8 的正则引擎，结论也常常是反过来的——这不是语言好坏，而是数据结构与运行时特性的差异。

MoonBit 版真正的收益在别处：

- **确定性**：相同输入 ⇒ 相同布局、相同图谱，可在 CI 里做快照；
- **可测性**：33 个单元测试直接跑在 wasm-gc 后端上；
- **类型安全**：解析结果的形状由编译器保证；
- **复用**：内核可以同时跑在扩展宿主、Webview、CLI 与浏览器里；
- **布局余量**：1000 节点仍有 800+ fps 的算力空间，为后续加入分组、聚类、路径高亮留出预算。

---

## 9. 已知限制与后续计划

- 只索引工作区第一个文件夹（多根工作区待支持）；
- Frontmatter 只提取标签，不解析其中的链接；
- 内核是单实例全局状态，同一进程内不支持并行索引多个工作区；
- 计划：把搜索/过滤（`rebuild()` 里的 BFS 与筛选）也搬进内核，让 Webview 只做绘制。
