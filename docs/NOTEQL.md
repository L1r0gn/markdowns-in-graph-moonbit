# NoteQL — 面向 Markdown 知识图的增量查询引擎

> NoteQL 是 v2.1 新增的 MoonBit 查询内核。它不替代 `mdparse` / `vault` / `layout`，
> 而是建立在它们之上的**派生层**：把笔记、链接、标签、断链与图结构当成关系，
> 用一条 SQL 风格的查询语句回答「哪些笔记是孤立的」「从首页几跳能到」「哪里有引用环」
> 这类问题，并在编辑后按依赖关系复用上次结果。

## 1. 快速开始

### 命令行

```bash
npm run core:build          # 生成 media/core.wasm 与 media/core.mjs
node scripts/noteql.mjs "SELECT n.path, n.degree FROM note n ORDER BY n.degree DESC LIMIT 10"
node scripts/noteql.mjs --vault example-vault --queries queries
node scripts/noteql.mjs --vault example-vault --file queries/unresolved.nql --format sarif
```

### VS Code

- 命令面板：`关系图谱: 运行 NoteQL 查询`
- 快捷键：`Ctrl+Alt+Q` / `Cmd+Alt+Q`
- 图谱工具栏的放大镜按钮

面板左侧是示例查询、内置关系与缓存统计；右侧是查询编辑器与结果表。
点击结果行会跳到对应文件与行号。

## 2. 语言参考

### 2.1 基本形状

```sql
SELECT [DISTINCT] 表达式 [AS 别名], ...
FROM 关系 [AS 别名]
[WHERE 条件]
[GROUP BY 列, ...]
[HAVING 条件]
[ORDER BY 表达式 [ASC|DESC], ...]
[LIMIT n]
```

关键字大小写不敏感；字符串使用单引号或双引号；`--` 与 `//` 都是行注释。

```sql
SELECT n.path, n.tags, indegree(n.path) AS refs
FROM note n
WHERE n.tags CONTAINS 'draft'
  AND indegree(n.path) = 0
ORDER BY n.path
LIMIT 20
```

### 2.2 内置关系

| 关系 | 列 | 说明 |
| --- | --- | --- |
| `note` | `path`, `label`, `folder`, `ext`, `size`, `mtime`, `degree`, `tags`, `in_degree`, `out_degree` | 所有笔记；度数与图谱语义一致 |
| `file` | `path`, `kind`, `ext`, `size`, `mtime`, `folder` | 笔记与附件 |
| `link` | `from`, `to`, `kind`, `raw`, `line`, `title`, `to_kind` | 每条**已解析**的原始链接（保留重复与行号） |
| `tag` | `note`, `tag` | 笔记与标签的展开关系 |
| `unresolved` | `from`, `raw`, `target`, `line`, `kind` | 断链 |
| `ambiguous` | `from`, `raw`, `target`, `line`, `candidates` | 同名文件导致的多候选链接 |
| `orphan` | `path`, `degree` | 度数为 0 的笔记 |
| `cycle` | `path`, `out_degree` | 位于有向环上的笔记（SCC 大小 > 1） |

边的语义与图谱一致：**自引用不计边，同一对节点的重复链接只算一条边**。
`link` 关系刻意保留原始链接行，方便定位；`degree` / `in_degree` / `out_degree`
则使用去重后的图边。

### 2.3 表达式与函数

- 比较：`=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
- 布尔：`AND`, `OR`, `NOT`
- 空值：`IS NULL`, `IS NOT NULL`
- 匹配：`LIKE`（`%`、`_`）、`CONTAINS`（字符串子串或标签数组成员）、`IN (...)`
- 算术：`+`, `-`, `*`, `/`, `%`
- 聚合：`count(*)`, `count(expr)`, `count(DISTINCT expr)`, `sum`, `avg`, `min`, `max`
- 字符串/数值：`lower`, `upper`, `length`, `abs`, `coalesce`, `startswith`, `endswith`
- 图函数：
  - `indegree(path)` / `outdegree(path)` / `degree(path)`
  - `distance(from, to)`：最短跳数，不可达返回 `-1`
  - `reachable(from, to, max_depth)`：`max_depth < 0` 表示不限深度
  - `in_cycle(path)`

`distance` / `reachable` 以已解析的笔记链接为边，BFS 结果按源节点缓存。
对同一源节点反复求值不会重复 BFS。

### 2.4 聚合与分组

```sql
SELECT n.folder, count(*) AS notes, sum(n.in_degree) AS inbound
FROM note n
GROUP BY n.folder
HAVING notes >= 2
ORDER BY notes DESC, n.folder
```

- `HAVING` 与 `ORDER BY` 里可以引用 SELECT 的显式别名（会做别名替换）。
- 分组查询中，SELECT 里所有非聚合列必须出现在 `GROUP BY` 中，否则直接报错。
- `GROUP BY` 目前只支持列，不支持任意表达式；`SELECT *` 不能与分组/聚合混用。
- 空结果集上的 `count(*)` 返回一行 `0`；`sum/avg/min/max` 返回 `null`。

### 2.5 空值与比较

- 输出里 `null` 是独立值；`IS NULL` 用于判断。
- `=` 对 `null` 采用「同为空才相等」的工程语义，而不是 SQL 的三值逻辑。
- `int` 与 `float` 比较时统一成 `double`；字符串按字典序比较。
- 字符串与数字不做隐式转换；`IN` 列表会把字面量转成显示字符串进行比较。

## 3. 查询语义

### 3.1 链接与解析

NoteQL 复用 `vault` 的「最短路径优先」解析规则：

1. 相对当前文件目录；
2. 相对工作区根目录；
3. 按文件名兜底（同目录优先，其次层级最浅、路径字典序最小）。

`unresolved` 是解析失败的链接；`ambiguous` 是同名文件有多个候选的链接。
后者即使最终按规则选出了一个目标，也会出现在 `ambiguous` 里，方便做链接治理。

### 3.2 查询计划

```text
FROM 关系（物化） → WHERE → GROUP BY / 聚合 → HAVING
→ SELECT → DISTINCT → ORDER BY → LIMIT
```

- 只有查询需要图结构时才构建 `GraphIndex`（`note` / `orphan` / `cycle` / 图函数）；
  只查 `tag`、`file`、`link` 的查询不会付出建图成本。
- 结果排序稳定：`ORDER BY` 相等时按输入行序号兜底，保证截图和测试可复现。

## 4. 增量模型

v2.1 的增量能力不是完整的 Datalog delta 维护，而是**依赖感知的结果缓存**：

- `vault` 维护 5 条独立的变更序列：`note` / `link` / `tag` / `name` / `file`。
- 每条查询记录自己依赖的关系与图函数。
- 关系映射到变更序列：

| 依赖 | 失效条件 |
| --- | --- |
| `note` | 笔记元数据、链接、标签或文件名变化 |
| `file` | 文件集合/元数据变化 |
| `link` | 链接或文件名变化 |
| `tag` | 标签或文件名变化 |
| `unresolved` / `ambiguous` / `orphan` / `cycle` / `graph` | 链接或文件名变化 |

- 查询执行后保存结果、依赖与变更序列快照；下次执行时逐项比较，全部一致才命中。
- 缓存最多保留 64 条，超出后清空；`noteql_reset_cache` 可手动清空。

这套机制能区分「只改链接」与「只改标签」：

- 只改链接、标签不变 → `tag` 查询命中缓存；
- 只改标签、链接不变 → `link` 查询命中缓存；
- 改文件名 → 所有依赖图的查询失效（因为同名链接的归属可能变了）。

### 差分测试

`core/query/query_test.mbt` 中的缓存测试会把「编辑后缓存结果」与
「用同一最终内容新建 vault 后重算的结果」逐单元格比较。只有两者一致，
测试才通过。这是缓存正确性的底线。

## 5. CLI

```bash
node scripts/noteql.mjs [查询] [选项]
```

| 选项 | 说明 |
| --- | --- |
| `--vault <目录>` | 要索引的笔记目录 |
| `--file, -f <文件>` | 从 `.nql` 文件读取查询 |
| `--queries, -q <目录>` | 批量执行目录下所有 `.nql` |
| `--format table\|json\|csv\|sarif` | 输出格式 |
| `--no-cache` | 关闭结果缓存 |
| `--fail-on-results` | 有结果行时退出码为 2（CI 体检） |
| `--list-relations` | 列出内置关系与列 |
| `--stats` | 在 stderr 输出缓存统计 |

示例：

```bash
# 断链检查，输出 SARIF 给 GitHub code scanning
node scripts/noteql.mjs --vault example-vault \
  --file queries/unresolved.nql --format sarif > noteql.sarif

# 如果仍有断链，CI 失败
node scripts/noteql.mjs --vault example-vault \
  --file queries/unresolved.nql --fail-on-results
```

`--queries queries` 会按文件名排序执行仓库里的 10 条示例查询。

## 6. 性能

本机基准（Node 24 / Windows，JS 后端，1200 篇合成笔记 / 约 48,000 条链接；
`node scripts/noteql-bench.mjs 1200`）：

| 场景 | 结果 |
| --- | --- |
| 端到端建索引（解析 + 索引 + 解析链接） | ~198 ms |
| `tag` 过滤（冷查询） | ~8.3 ms |
| `tag` 过滤（热缓存） | ~0.22 ms |
| `indegree` 图查询（冷） | ~160 ms |
| 递归 `distance`（冷） | ~84 ms |
| 只改链接后 · `tag` 查询 | ~0.22 ms（缓存命中） |
| 改标签后 · `tag` 查询 | ~2.5 ms（重算） |

数字会随机器与语料变化；仓库提供脚本，可自行复现。
Wasm 后端的查询结果与 JS 后端一致，由 `noteql_selftest` 与测试覆盖。

## 7. 与其它工具的关系

| 能力 | Obsidian Dataview | SQL / 递归 CTE | Cypher | NoteQL |
| --- | --- | --- | --- | --- |
| 元数据查询 | 有 | 有 | 有 | 有 |
| 图递归/环/距离 | 基本没有 | 能写但别扭 | 有 | 有 |
| 链接解析语义一等化 | 不暴露 | 需自行 ETL | 需自行建模 | `unresolved` / `ambiguous` |
| 编辑后增量复用 | 基本重跑 | 一般重算 | 一般重算 | 依赖感知缓存 |
| 跨编辑器 / CI | 否 | 取决于实现 | 服务端 | CLI + SARIF |
| 语义/分组一致性检查 | 无 | 部分 | 无 | 有 |

NoteQL 的目标不是成为一个通用 SQL 引擎，而是把**知识库的派生状态**
（解析结果、图结构、健康度）做成可查询、可增量维护的一层。

## 8. 已知限制

- 只支持单关系查询；`JOIN`、子查询、`UNION` 尚未实现。
- `GROUP BY` 只支持列；不支持 `GROUP BY` 任意表达式。
- 不校验标题/块锚点是否存在（`[[note#heading]]` 只解析到笔记）。
- 增量缓存是结果级依赖失效，不是逐元组的 delta 维护；递归视图在依赖变化时整体重算。
- 缓存上限 64 条；大型工作区仍建议对查询加 `LIMIT`。
- 空值比较采用工程语义，不等价于 SQL 三值逻辑。
- 查询面板一次最多渲染 500 行（导出 JSON 不受限制）。
- `distance` / `reachable` 按源节点缓存 BFS；如果每一行都使用不同的源节点，
  最坏情况会退化为多次全图 BFS，建议先用 `LIMIT` 或 `WHERE` 缩小范围。

## 9. 路线图

1. 支持多关系 `JOIN` 与相关子查询；
2. 为递归查询引入按连通分量/脏分量的增量重算；
3. 增加锚点与 Frontmatter 字段的完整关系；
4. 把查询结果直接接到「批量修复链接」的编辑计划器。
