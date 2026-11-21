# Antigravity KnowledgeJump（双栏搜题与知识点对照插件）

直接利用 Antigravity 原生多模态识题能力 + 本地混合检索（BM25 / 可选 BGE 向量）+ Sidecar 双栏面板，实现「拍照/文字拆题 → 匹配知识点卡片 → 点击跳转并高亮定位 3.5 秒」。

- GitHub 仓库：https://github.com/rained106/antigravity-knowledge-jump

## 支持文档格式

- **Markdown（`.md`）**：标题切片、表格、代码块、LaTeX 公式（`$...$` / `$$...$$` / 多行矩阵）
- **Word（`.docx`）**：纯 Python 标准库解析（无需安装 `python-docx`），支持标题层级、表格以及 OMML 公式 / 矩阵 / 分段函数 / 行列式 / 上下标注还原为 LaTeX
- **PDF（`.pdf`）**：内置轻量 `pdf-parse`，按页检索与跳转

---

## 安装方法（接收方）

### 方式一：解压放入 Antigravity 插件目录（推荐）

将压缩包解压到本机 Antigravity 全局插件目录，保证 `plugin.json` 直接位于 `knowledge-jump` 目录下：

- **Windows**：`C:\Users\<你的用户名>\.gemini\config\plugins\knowledge-jump\`
- **macOS / Linux**：`~/.gemini/config/plugins/knowledge-jump/`

确认目录结构为：

```text
knowledge-jump/
├── plugin.json
├── mcp_config.json
├── mcp_server.mjs
├── kb_engine.mjs
├── parse_docx.py
├── node_modules/pdf-parse/...
├── assets/logo.svg
├── skills/knowledge-jump/SKILL.md
└── sidecars/knowledge_jump_panel/
```

完成后重启 Antigravity（或新开会话），即可在侧边自定义/插件列表看到 **KnowledgeJump**。

### 方式二：Git 克隆安装

```bash
git clone https://github.com/rained106/antigravity-knowledge-jump.git ~/.gemini/config/plugins/knowledge-jump
```

### 方式三：CLI 校验

可在终端执行校验确认包结构完整：

```bash
agy plugin validate ~/.gemini/config/plugins/knowledge-jump --strict
```

---

## 首次使用设置

1. 打开侧边栏面板（在对话中输入 `打开 KnowledgeJump 双栏对照面板`，或点击链接 `[KnowledgeJump 双栏对照](sidecar://knowledge-jump/knowledge_jump_panel/)`）。
2. 点击面板右上角 **「设置目录」**，填入你本机存放复习笔记/题库的绝对路径（例如 `D:\knowledge_base` 或 `/Users/you/Notes`），点击 **「保存并重建索引」**。
3. 之后直接在 Antigravity 对话框粘贴题目截图，或在面板左侧输入题干文字点击 **「本地拆解与搜题」** 即可对照跳转。

---

## 环境要求

- **Node.js**（Antigravity MCP 与 Sidecar 运行所需，一般随宿主或本机环境提供）
- **Python 3**（仅在知识库包含 `.docx` 文件时需要，无需额外 `pip install` 任何第三方包）
- **可选 BGE 语义向量增强**：默认自带中文分词 BM25 检索即可开箱使用；如需启用本地 ONNX BGE 向量，可配置环境变量 `KB_BGE_PYTHON`、`KB_BGE_WORKER`、`KB_BGE_MODEL`。

---

## 说明与开源协议

- **开发方式**：本项目代码基于 Antigravity（AI 辅助编程）生成与验证；所有文档解析、索引与匹配均在本地离线运行，不会向任何外部第三方接口上传笔记或截图。
- **开源协议**：基于 [MIT License](LICENSE) 开源。
