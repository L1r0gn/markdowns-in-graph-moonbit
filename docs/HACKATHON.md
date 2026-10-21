# 参赛说明（MoonBit Hackathon 2026 · 十月赛）

## 一句话

**Markdowns In Graph v2.1 不只是把解析和布局搬进 MoonBit，而是在它们之上新增了一层
NoteQL：一个面向 Markdown 知识图的查询与增量复用引擎。**

- 底座：`mdparse` / `vault` / `layout` —— 双链解析、链接解析、构图、力导向布局
- 新增贡献：`core/query` —— 查询语言、关系模型、图递归、依赖感知缓存、CLI 与 VS Code 查询面板
- 同一份 MoonBit 源码产出 wasm-gc 与 js；同一套查询语义跑在扩展宿主、Webview 与 CI

---

## 对上一版驳回意见的回应

上一版的叙事把「解析 + 布局」当成主贡献，评审指出这些已是成熟件，剩余部分不足以
构成独立项目的核心深度。v2.1 的改法是**换重心，而不是补功能**：

| 上一版被质疑的点 | v2.1 的处理 |
| --- | --- |
| 解析、布局是成熟件 | 明确降为底座；不再把它们当作主要创新点 |
| 路径查找、构图、宿主适配不足以构成深度 | 新增查询语言、图递归、增量缓存与 CI 接口；这些不依赖解析器/布局库 |
| 未建立与现有 MoonBit 库的复用/差异 | 底座保持可替换；`core/query` 是新的独立包，解决的是「派生查询与失效」而不是「文本/几何」 |
| 缺少可验证的核心 | 41 个 MoonBit 测试；缓存与全量重算的差分测试；1200 篇笔记基准；CLI SARIF 输出 |

---

## 与验收标准的对应

| 验收标准 | 本项目如何满足 | 可检查的位置 |
| --- | --- | --- |
| **MoonBit 为主** | 解析、索引、构图、布局、查询语言、求值器、增量缓存全部是 MoonBit；TS 只负责 VS Code API、Webview 渲染与 CLI 转发 | `core/**/*.mbt`；`src/queryPanel.ts` 只有消息与 DOM |
| **仓库公开** | GitHub 公共仓库；保留完整提交历史 | `git log --oneline` |
| **能够运行** | `npm run core:build` → `npm run compile` → F5；或安装 2.1.0 VSIX（wasm/mjs 产物已入库） | `README.md`「安装」 |
| **工作有效** | 新增 `core/query` 包；查询可在 VS Code、CLI、CI 中运行；缓存与重算结果有差分测试 | `core/query/**`、`scripts/noteql*.mjs` |
| **开源合规** | MIT；未引入与许可证不兼容的第三方运行时 | `LICENSE`、`core/moon.mod` |
| **AI 可解释** | 语言语义、增量模型、性能数据、限制全部写入 `docs/NOTEQL.md` 与本节 | `docs/NOTEQL.md` |

---

## 复现（10 分钟）

```bash
git clone <repo> && cd markdowns-in-graph
npm install

# 1. 内核测试（需要 moon 工具链，见 docs/MOONBIT.md）
npm run core:test        # 41 passed

# 2. 编译 TypeScript
npm run compile

# 3. 查询 CLI：跑仓库自带的 10 条查询
node scripts/noteql.mjs --vault example-vault --queries queries

# 4. JS/CLI 冒烟测试
npm run noteql:test

# 5. 基准（1200 篇合成笔记 / 约 48,000 条链接）
node scripts/noteql-bench.mjs 1200

# 6. 在 VS Code 里跑
#    打开项目 F5 → 在开发宿主打开 example-vault → Ctrl+Alt+Q
```

---

## 技术亮点

### 1. 新的派生层：关系 + 图函数

NoteQL 把知识库拆成 8 个内置关系：

```text
note  file  link  tag  unresolved  ambiguous  orphan  cycle
```

并提供 `distance` / `reachable` / `in_cycle` / `indegree` / `outdegree` 等图函数。
查询可以直接问：

```sql
-- 从首页出发不可达的笔记
SELECT n.path, distance('首页.md', n.path) AS hops
FROM note n
WHERE distance('首页.md', n.path) < 0
ORDER BY n.path;

-- 带 #draft 但没有任何入链的笔记
SELECT n.path, indegree(n.path) AS refs
FROM note n
WHERE n.tags CONTAINS 'draft' AND indegree(n.path) = 0;
```

`distance` 用 BFS，结果按源节点缓存；`cycle` 用 Kosaraju SCC。
这些都不是解析器或布局库能提供的能力。

### 2. 依赖感知的增量缓存

`vault` 维护 5 条独立的变更序列：

```text
note  link  tag  name  file
```

查询记录自己依赖的关系，例如：

- `tag` 依赖 `tag + name`
- `link` 依赖 `link + name`
- `orphan` / `cycle` / 图函数依赖 `link + name`

于是：

- 只改链接、标签不变 → `tag` 查询命中缓存；
- 只改标签、链接不变 → `link` 查询命中缓存；
- 改文件名 → 依赖图的查询失效，因为同名链接的归属可能变了。

这不是完整的 Datalog delta 维护，但它是可解释、可测试的增量复用；
`core/query/query_test.mbt` 会把缓存结果与全量重算逐单元格比较。

### 3. 按需建图

只有 `note` / `orphan` / `cycle` 或图函数才构建 `GraphIndex`。
只查 `tag`、`file`、`link` 的查询不会为整张图付出成本。
在 1200 篇笔记的语料上，`tag` 冷查询约 8 ms，而完整图查询约 160 ms。

### 4. 双宿主 + CLI/CI

- 扩展宿主：查询在 Node 侧执行，结果通过 `postMessage` 交给查询面板；
- Webview：图谱布局继续逐帧调用 wasm；
- CLI：同一份 JS 后端直接读工作区，输出 table / JSON / CSV / SARIF；
- `--fail-on-results` 可把断链、孤立笔记等体检变成 CI 闸门。

### 5. 查询语义检查

拒绝而不是静默算错：

- 未知关系/列；
- 聚合函数出现在 `WHERE`；
- 分组查询里出现未分组的列；
- 聚合嵌套；
- `DISTINCT` 用在非聚合函数上；
- `GROUP BY` 任意表达式（2.1 明确不支持）。

---

## 设计取舍（诚实记录）

| 决策 | 理由 | 代价 |
| --- | --- | --- |
| 单关系 `FROM`，不做 `JOIN` | 2.1 先把关系、图函数、增量语义做扎实；JOIN 会拖长实现与验证 | 复杂查询需要拆成多条 |
| SQL 风格表面 + 图函数 | 对熟悉 SQL 的用户友好；不需要先学 Cypher | 不是标准 SQL，`HAVING` 别名等语义由我们定义 |
| 解析/布局保留原实现 | 它们是稳定底座，已有测试与基准；换掉不会增加本项目深度 | 仓库中仍有旧模块 |
| 增量做结果级依赖失效 | 可在有限周期内做对、测清楚 | 不是逐元组 delta；递归视图在依赖变化时整体重算 |
| 查询在扩展宿主执行 | 避免 Webview 与宿主各维护一份索引 | 查询面板不能离线单独运行 |
| 缓存上限 64 条 | 防止长时间会话无限增长 | 大量不同查询会互相驱逐 |

---

## 基准

本机（Node 24 / Windows，JS 后端，1200 篇合成笔记 / 约 48,000 条链接）：

| 场景 | 结果 |
| --- | --- |
| 端到端建索引 | ~198 ms |
| `tag` 过滤冷查询 | ~8.3 ms |
| `tag` 过滤热缓存 | ~0.22 ms |
| `indegree` 图查询冷 | ~160 ms |
| 递归 `distance` 冷 | ~84 ms |
| 只改链接后 · `tag` 查询 | ~0.22 ms（命中） |
| 改标签后 · `tag` 查询 | ~2.5 ms（重算） |

```bash
node scripts/noteql-bench.mjs 1200
```

Wasm 与 JS 后端的查询结果一致，由 `noteql_selftest` 覆盖。

---

## 测试矩阵

| 层次 | 命令 | 覆盖 |
| --- | --- | --- |
| MoonBit 单元测试 | `npm run core:test` | 路径、解析、构图、布局、查询语法、聚合、图递归、缓存失效、差分一致性（41 个） |
| JS/CLI 冒烟 | `node scripts/noteql-test.mjs` | wasm/mjs 加载、查询、缓存、CLI JSON/SARIF |
| 解析一致性 | `npm run parity` | 旧 TS 解析器 ⇄ MoonBit 内核 |
| 索引器集成 | `node scripts/test-indexer.js` | 桩 `vscode` 下的扫描与查询 |
| 界面预览 | `node scripts/query-preview.js` | 查询面板静态预览（mock `vscode` API） |
| 基准 | `node scripts/noteql-bench.mjs` | 索引、冷/热查询、增量场景 |

---

## 与现有 MoonBit 库的关系

- `mdparse` / `layout` 继续作为底座；本项目不把「双链解析」和「Barnes–Hut 布局」当作新贡献。
- `core/query` 是新的包，解决的问题是**派生查询与增量复用**，与文本解析、几何布局没有重叠。
- 如果未来社区有更成熟的 Markdown 解析库或布局库，可以替换底座而不改变 NoteQL 的语义；
  查询层只依赖 `vault` 暴露的 `notes` / `resolve` / `candidates` / 变更序列。

---

## AI 使用说明

- **由人决定**：查询语言边界、关系模型、增量失效粒度、缓存策略、UI 交互；
- **由人验证**：每个模块都经过 `moon check` / `moon test` / CLI 冒烟 / 预览页检查；
- **可追溯**：设计、基准、限制写入 `docs/NOTEQL.md`；基准脚本可复现。

---

## 后续计划

1. 多关系 `JOIN` 与相关子查询；
2. 递归查询按连通分量/脏分量做更细粒度的增量重算；
3. 锚点与 Frontmatter 字段关系；
4. 查询结果接到「批量修复链接」的编辑计划器（LinkSmith 方向）。
