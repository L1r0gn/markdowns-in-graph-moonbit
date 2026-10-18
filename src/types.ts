/**
 * 图谱数据结构（扩展侧 -> Webview 的传输格式）。
 */

export type NodeKind = 'note' | 'attachment' | 'unresolved';

export interface GraphNode {
  /** 工作区相对路径，作为唯一 ID；未解析节点使用 "u:" 前缀 */
  id: string;
  /** 显示名（不含扩展名 / 原始双链文本） */
  label: string;
  /** 工作区相对路径 */
  path: string;
  kind: NodeKind;
  /** 小写扩展名，如 ".md"、".png" */
  ext: string;
  /** 所在文件夹（'' 表示根目录） */
  folder: string;
  tags: string[];
  size: number;
  mtime: number;
  /** 连接数（在完整图中计算） */
  degree: number;
}

export type LinkKind = 'wiki' | 'md' | 'embed';

export interface GraphLink {
  source: string;
  target: string;
  kind: LinkKind;
}

export interface GraphStats {
  notes: number;
  attachments: number;
  unresolved: number;
  links: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: GraphStats;
  generatedAt: number;
  rootName: string;
}
