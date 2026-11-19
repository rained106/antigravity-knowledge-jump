import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.page('/katex/katex.min.css', () =>
  new Response(readFileSync(join(KATEX_DIR, 'katex.min.css')), { contentType: 'text/css' })
);
app.page('/katex/katex.min.js', () =>
  new Response(readFileSync(join(KATEX_DIR, 'katex.min.js')), { contentType: 'application/javascript' })
);
app.page('/katex/contrib/auto-render.min.js', () =>
  new Response(readFileSync(join(KATEX_DIR, 'contrib', 'auto-render.min.js')), { contentType: 'application/javascript' })
);

const fontsDir = join(KATEX_DIR, 'fonts');
if (existsSync(fontsDir)) {
  for (const fontFile of readdirSync(fontsDir)) {
    const ext = extname(fontFile).toLowerCase();
    const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : 'font/ttf';
    app.page(`/katex/fonts/${fontFile}`, () =>
      new Response(readFileSync(join(fontsDir, fontFile)), { contentType: mime })
    );
  }
}

app.api('/api/state', async () => ({
  settings: loadSettings(),
  indexStatus: getIndexStatus(),
  latestCards: loadLatestCards(),
}), 'GET');

app.api('/api/cards', async () => loadLatestCards(), 'GET');

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

app.api('/api/document', async (data) => {
  const idx = loadIndex();
  const chunk = idx?.chunks?.find((c) => c.id === data?.chunkId);
  if (!chunk) throw new Error('未找到对应的知识点切片，请尝试重建索引。');
  if (!existsSync(chunk.filePath)) throw new Error(`目标文件不存在：${chunk.relativePath}`);

  if (chunk.type === 'markdown' || chunk.type === 'docx') {
    const lines =
      chunk.type === 'docx'
        ? getDocxLines(chunk.filePath)
        : readFileSync(chunk.filePath, 'utf-8').split(/\r?\n/);
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
