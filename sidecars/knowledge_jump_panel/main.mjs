import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  clearCards,
  clearHistory,
  getDocxLines,
  getIndexStatus,
  loadFavorites,
  loadHistory,
  loadIndex,
  loadLatestCards,
  loadSettings,
  pushCards,
  rebuildIndex,
  removeCardGroup,
  removeFavoriteItem,
  removeHistoryItem,
  restoreProblemGroup,
  saveSettings,
  searchChunks,
  shutdownEmbedder,
  toggleFavoriteGroup,
} from '../../kb_engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATEX_DIR = join(__dirname, 'katex');

async function localAnalyzeText(rawText, mode) {
  const text = (rawText || '').trim();
  if (!text) throw new Error('请输入题干文字，或直接在 Antigravity 对话框粘贴题目截图。');

  const parts = text
    .split(/(?=(?:^|\n)\s*(?:[（(]\s*\d+\s*[)）]|\d+[.、]|第\s*[（(]?\d+[)）]?\s*问))/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const finalParts = parts.length > 0 ? parts : [text];
  const segments = [];

  for (let i = 0; i < finalParts.length; i++) {
    const part = finalParts[i];
    let segmentType = '核心考点';
    const subMatch = part.match(/^(?:[（(]\s*(\d+)\s*[)）]|(\d+)[.、]|第\s*[（(]?(\d+)[)）]?\s*问)/);
    if (subMatch) {
      const num = subMatch[1] || subMatch[2] || subMatch[3];
      segmentType = `第(${num})问`;
    } else if (i === 0 && finalParts.length > 1) {
      segmentType = '已知条件';
    }

    const hits = await searchChunks(part, 1);
    const matched = hits[0] || null;
    segments.push({
      text: part,
      segmentType,
      matchedChunkId: matched ? matched.chunkId : null,
      knowledgeTag: matched ? matched.headingTitle : '本地检索',
      matchedChunk: matched
        ? {
            id: matched.chunkId,
            relativePath: matched.relativePath,
            headingTitle: matched.headingTitle,
            type: matched.type,
            startLine: matched.startLine,
            endLine: matched.endLine,
            pageNumber: matched.pageNumber,
            status: matched.status,
            reviewAfterStr: matched.reviewAfterStr,
            isOverdue: matched.isOverdue,
          }
        : null,
    });
  }

  return pushCards(segments, 'local', { mode });
}

const app = new SidecarApp();

const IMMUTABLE_HEADERS = { 'Cache-Control': 'public, max-age=31536000, immutable' };
const staticCache = new Map();
function serveStaticCached(filePath, contentType, headers = IMMUTABLE_HEADERS) {
  return () => {
    let body = staticCache.get(filePath);
    if (body === undefined) {
      body = readFileSync(filePath);
      staticCache.set(filePath, body);
    }
    return new Response(body, { contentType, headers });
  };
}

// Pre-warm core UI assets into RAM (~300 KB total) with mtime-aware HTML reload
const indexHtmlPath = join(__dirname, 'index.html');
let indexHtmlCache = { mtimeMs: -1, body: '' };
function getIndexHtml() {
  const st = statSync(indexHtmlPath);
  if (indexHtmlCache.mtimeMs !== st.mtimeMs) {
    indexHtmlCache = { mtimeMs: st.mtimeMs, body: readFileSync(indexHtmlPath, 'utf-8') };
  }
  return indexHtmlCache.body;
}
getIndexHtml();
app.page('/', () => new Response(getIndexHtml(), { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-cache' } }));

const katexSwapCss = join(KATEX_DIR, 'katex-swap.min.css');
const katexCssPath = existsSync(katexSwapCss) ? katexSwapCss : join(KATEX_DIR, 'katex.min.css');
staticCache.set(katexCssPath, readFileSync(katexCssPath));
app.page('/katex/katex.min.css', serveStaticCached(katexCssPath, 'text/css; charset=utf-8'));
app.page('/katex/katex-swap.min.css', serveStaticCached(katexCssPath, 'text/css; charset=utf-8'));

const katexJsPath = join(KATEX_DIR, 'katex.min.js');
const autoRenderJsPath = join(KATEX_DIR, 'contrib', 'auto-render.min.js');
staticCache.set(katexJsPath, readFileSync(katexJsPath));
staticCache.set(autoRenderJsPath, readFileSync(autoRenderJsPath));
app.page('/katex/katex.min.js', serveStaticCached(katexJsPath, 'application/javascript; charset=utf-8'));
app.page('/katex/contrib/auto-render.min.js', serveStaticCached(autoRenderJsPath, 'application/javascript; charset=utf-8'));

const fontsDir = join(KATEX_DIR, 'fonts');
if (existsSync(fontsDir)) {
  for (const fontFile of readdirSync(fontsDir)) {
    const ext = extname(fontFile).toLowerCase();
    const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
    app.page(`/katex/fonts/${fontFile}`, serveStaticCached(join(fontsDir, fontFile), mime));
  }
}

app.api('/api/state', async () => ({
  settings: loadSettings(),
  indexStatus: getIndexStatus(),
  latestCards: loadLatestCards(),
  history: loadHistory(),
  favorites: loadFavorites(),
}), 'GET');

app.api('/api/cards', async (data) => {
  const latest = loadLatestCards();
  const since = Number(data?.since || 0);
  if (since > 0 && latest && latest.updatedAt <= since) {
    return { unchanged: true, updatedAt: latest.updatedAt };
  }
  return latest;
}, 'GET');

app.api('/api/settings', async (data) => ({
  settings: saveSettings(data),
  indexStatus: getIndexStatus(),
}));

app.api('/api/rebuild', async () => ({
  indexStatus: await rebuildIndex(),
}));

app.api('/api/analyze', async (data) => {
  const res = await localAnalyzeText(data?.text || '', data?.mode);
  return {
    segments: res.segments,
    addedCount: res.pushed,
    totalCount: res.total,
    mode: res.mode,
    lastAddedGroupId: res.groupId,
    updatedAt: res.updatedAt,
  };
});

app.api('/api/cards/clear', async () => {
  const res = clearCards('user');
  return {
    cleared: res.cleared,
    updatedAt: res.updatedAt,
    segments: res.segments,
  };
});

app.api('/api/cards/remove-group', async (data) => {
  const res = removeCardGroup(data?.groupId || '', 'user');
  return {
    removed: res.removed,
    totalCount: res.total,
    updatedAt: res.updatedAt,
    segments: res.segments,
  };
});

app.api('/api/history', async () => loadHistory(), 'GET');

app.api('/api/history/remove', async (data) => removeHistoryItem(data?.id || ''));

app.api('/api/history/clear', async () => clearHistory());

app.api('/api/favorites', async () => loadFavorites(), 'GET');

app.api('/api/favorites/toggle', async (data) => toggleFavoriteGroup({
  groupId: data?.groupId || '',
  title: data?.title || '',
  source: data?.source || 'user',
  segments: Array.isArray(data?.segments) ? data.segments : [],
}));

app.api('/api/favorites/remove', async (data) => removeFavoriteItem(data?.id || ''));

app.api('/api/library/restore', async (data) => {
  const res = restoreProblemGroup(
    data?.kind === 'favorite' ? 'favorite' : 'history',
    data?.id || '',
    data?.mode
  );
  return {
    segments: res.segments,
    addedCount: res.pushed,
    totalCount: res.total,
    mode: res.mode,
    lastAddedGroupId: res.groupId,
    updatedAt: res.updatedAt,
  };
});

const CONV_ID_RE = /^[a-zA-Z0-9_-]{6,80}$/;

function extractCleanMessageText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const base = m ? m[1] : raw;
  return base
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<\/?USER_REQUEST>/gi, '')
    .trim();
}

async function queryConversationMeta(explicitId) {
  const dbPath = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
  if (!existsSync(dbPath)) return { id: explicitId || '', title: '' };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    try {
      if (explicitId) {
        const row = db
          .prepare('SELECT conversation_id, title FROM conversation_summaries WHERE conversation_id = ?')
          .get(explicitId);
        return { id: explicitId, title: String(row?.title || '').trim() };
      }
      const row = db
        .prepare(
          "SELECT conversation_id, title FROM conversation_summaries WHERE app_data_dir = 'antigravity' AND parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 1"
        )
        .get();
      return {
        id: String(row?.conversation_id || '').trim(),
        title: String(row?.title || '').trim(),
      };
    } finally {
      db.close();
    }
  } catch {
    return { id: explicitId || '', title: '' };
  }
}

function readConversationMessages(conversationId, limit = 16) {
  if (!conversationId || !CONV_ID_RE.test(conversationId)) return [];
  const transcriptPath = join(
    homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  if (!existsSync(transcriptPath)) return [];

  let fd;
  try {
    const st = statSync(transcriptPath);
    const readLen = Math.min(st.size, 512 * 1024);
    const offset = Math.max(0, st.size - readLen);
    const buf = Buffer.allocUnsafe(readLen);
    fd = openSync(transcriptPath, 'r');
    const bytesRead = readSync(fd, buf, 0, readLen, offset);
    const text = buf.subarray(0, bytesRead).toString('utf-8');
    const lines = text.split(/\r?\n/);
    if (offset > 0 && lines.length > 0) lines.shift(); // Drop potentially truncated first line

    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const isUser = obj.type === 'USER_INPUT' && obj.source === 'USER_EXPLICIT';
      const isAssistant = obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string' && obj.content.trim();
      if (!isUser && !isAssistant) continue;

      const cleaned = extractCleanMessageText(obj.content || '');
      const mediaCount = Array.isArray(obj.media) ? obj.media.length : 0;
      if (!cleaned && mediaCount === 0) continue;
      // Skip auto-generated import trigger messages so the picker stays clean
      if (isUser && cleaned.startsWith('[KnowledgeJump 导入指令]')) continue;

      const compact = cleaned.replace(/\s+/g, ' ').trim();
      const preview = compact.length > 140 ? `${compact.slice(0, 140)}…` : compact;
      items.push({
        stepIndex: Number(obj.step_index ?? 0),
        role: isUser ? 'user' : 'assistant',
        roleLabel: isUser ? '我' : 'Antigravity',
        preview: preview || (mediaCount > 0 ? '（仅包含图片/截图）' : ''),
        fullText: cleaned,
        mediaCount,
        createdAt: String(obj.created_at || ''),
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

app.api('/api/conversation-messages', async (data) => {
  const rawCid = String(data?.conversationId || app.config.conversationId || '').trim();
  const validCid = CONV_ID_RE.test(rawCid) ? rawCid : '';
  const meta = await queryConversationMeta(validCid);
  const messages = readConversationMessages(meta.id, 16);
  return {
    conversationId: meta.id,
    title: meta.title,
    messages,
  };
}, 'GET');

const mdLinesCache = new Map();
function getMarkdownLines(filePath) {
  const st = statSync(filePath);
  const cached = mdLinesCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.lines;
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  if (mdLinesCache.size > 32) mdLinesCache.delete(mdLinesCache.keys().next().value);
  mdLinesCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, lines });
  return lines;
}

app.api('/api/document', async (data) => {
  const idx = loadIndex();
  const chunk = idx?.chunks?.find((c) => c.id === data?.chunkId);
  if (!chunk) throw new Error('未找到对应的知识点切片，请尝试重建索引。');
  if (!existsSync(chunk.filePath)) throw new Error(`目标文件不存在：${chunk.relativePath}`);

  if (chunk.type === 'markdown' || chunk.type === 'docx') {
    const lines =
      chunk.type === 'docx'
        ? getDocxLines(chunk.filePath)
        : getMarkdownLines(chunk.filePath);
    return {
      type: 'markdown',
      relativePath: chunk.relativePath,
      headingTitle: chunk.headingTitle,
      startLine: chunk.startLine ?? 0,
      endLine: chunk.endLine ?? chunk.startLine ?? 0,
      lines,
    };
  }

  const pdfPages = idx.chunks
    .filter((c) => c.filePath === chunk.filePath)
    .sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
    .map((c) => ({ pageNumber: c.pageNumber, text: c.text }));

  return {
    type: 'pdf',
    relativePath: chunk.relativePath,
    headingTitle: chunk.headingTitle,
    targetPage: chunk.pageNumber ?? 1,
    pages: pdfPages,
  };
});

function startHostWatchdog(onDead) {
  const raw = process.env.ANTIGRAVITY_LS_ADDRESS || '';
  const m = raw.match(/(?:https?:\/\/)?([^:/]+):(\d+)/);
  if (!m) return;
  const host = m[1];
  const port = Number(m[2]);
  if (!Number.isFinite(port) || port <= 0) return;

  let missed = 0;
  const timer = setInterval(() => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (alive) {
        missed = 0;
      } else if (++missed >= 2) {
        clearInterval(timer);
        onDead();
      }
    };
    sock.setTimeout(2000, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  }, 15000);
  timer.unref();
}

process.on('SIGINT', () => { shutdownEmbedder(); process.exit(0); });
process.on('SIGTERM', () => { shutdownEmbedder(); process.exit(0); });

startHostWatchdog(() => {
  shutdownEmbedder();
  app.close().finally(() => process.exit(0));
});

app.run();
