---
name: knowledge-jump
description: 双栏对照搜题与知识点跳转工具（免外部 API）。当用户粘贴题目截图、输入题目或请求打开搜题对照面板时使用。
---

# KnowledgeJump（Antigravity 原生免 API 版）

本插件完全依靠 **Antigravity 内置多模态能力 + 本地知识库索引 + Sidecar 双栏面板** 工作，无需任何外部 API Key。

## 标准工作流（截图/文字识题并推送至双栏面板）

当用户在对话中粘贴题目截图、发送题目文本，或在 KnowledgeJump 面板点击「导入对话中的题目」触发 `[KnowledgeJump 导入指令]` 时：
1. **多模态识题与拆解**：由你（Antigravity）直接识别当前对话中对应题目或截图的文字与公式（行内公式 `$ ... $`，块级公式 `$$ ... $$`），按逻辑拆分为多个语义片段（`已知条件`、`第(1)问`、`第(2)问`、`核心考点`）。
2. **检索本地知识库**：调用 `kj_search` 工具检索最相关的本地知识点切片（若尚未建索引可先调用 `kj_rebuild_index`）。
3. **推送至双栏面板**：调用 `kj_push_cards` 将结构化卡片（含 `text`、`segmentType`、`matchedChunkId`、`knowledgeTag`，可选 `title` 标识本题主题）写入面板：
   - 若指令或用户明确指定了 `mode="append"`（接在后面/追加）或 `mode="replace"`（清空旧题/覆盖），按指定值传参；
   - 否则默认**不传 `mode`**，让面板中用户勾选的「清空旧题 / 接在旧题后」开关自动生效；若只需清空面板旧题，调用 `kj_clear_cards`。
4. **引导打开/查看面板**：向用户输出一键打开链接 `[KnowledgeJump 双栏对照](sidecar://knowledge-jump/knowledge_jump_panel/)`，用户在面板左侧点击任意卡片即可在右侧自动滚动定位并高亮 3.5 秒。
