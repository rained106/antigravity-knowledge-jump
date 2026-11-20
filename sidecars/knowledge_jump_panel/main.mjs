import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  getDocxLines,
  getIndexStatus,
  loadIndex,
  loadLatestCards,
  loadSettings,
  pushCards,
  rebuildIndex,
  saveSettings,
  searchChunks,
  shutdownEmbedder,
} from '../../kb_engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATEX_DIR = join(__dirname, 'katex');

async function localAnalyzeText(rawText) {
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

  pushCards(segments, 'local');
  return segments;
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

// Pre-warm core UI assets into RAM once at startup (~300 KB total)
const indexHtmlPath = join(__dirname, 'index.html');
const indexHtmlBody = readFileSync(indexHtmlPath, 'utf-8');
app.page('/', () => new Response(indexHtmlBody, { contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-cache' } }));

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

app.api('/api/analyze', async (data) => ({
  segments: await localAnalyzeText(data?.text || ''),
}));

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
