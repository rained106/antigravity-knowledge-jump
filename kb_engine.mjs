import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = __dirname;
export const SETTINGS_PATH = join(PLUGIN_DIR, 'settings.json');
export const INDEX_PATH = join(PLUGIN_DIR, 'knowledge-index.json');
export const CARDS_PATH = join(PLUGIN_DIR, 'latest_cards.json');

const LOCAL_BGE_PYTHON = process.env.KB_BGE_PYTHON || 'D:/QQAgent/.venv/Scripts/python.exe';
const LOCAL_BGE_WORKER = process.env.KB_BGE_WORKER || 'D:/AntigravityMemory/tools/bge_embed_worker.py';
const LOCAL_BGE_MODEL = process.env.KB_BGE_MODEL || 'D:/AntigravityMemory/models/bge-small-zh-v1.5/onnx/model_quantized.onnx';
const SHARED_BGE_HTTP = (process.env.BGE_EMBED_URL || 'http://127.0.0.1:18765/v1').replace(/\/+$/, '');
const BGE_MODEL_TAG = 'local:bge-small-zh-v1.5';
const RRF_K = 60;

const require = createRequire(import.meta.url);
const PDF_PARSE_CANDIDATES = [
  join(PLUGIN_DIR, 'node_modules', 'pdf-parse', 'index.js'),
  'D:/knowledge-jump-ext/node_modules/pdf-parse/index.js',
];
let pdfParseLoaded = false;
let pdfParse = null;

function hasPdfParser() {
  return pdfParseLoaded ? Boolean(pdfParse) : PDF_PARSE_CANDIDATES.some((p) => existsSync(p));
}

function getPdfParser() {
  if (pdfParseLoaded) return pdfParse;
  pdfParseLoaded = true;
  for (const candidate of PDF_PARSE_CANDIDATES) {
    if (existsSync(candidate)) {
      try {
        pdfParse = require(candidate);
        break;
      } catch {
        // Ignore load failure
      }
    }
  }
  return pdfParse;
}

let indexCache = { mtimeMs: -1, size: -1, data: null };
let cardsCache = { mtimeMs: -1, size: -1, data: null };
const docxLinesCache = new Map(); // filePath -> { mtimeMs, size, lines }

export const DEFAULT_SETTINGS = {
  knowledgeDir: existsSync('D:/knowledge_base') ? 'D:/knowledge_base' : join(homedir(), 'knowledge_base'),
  importMode: 'replace',
  splitRatio: 0.5,
  splitRatioV: 0.46,
};

function normalizeImportMode(mode, fallback = 'replace') {
  return mode === 'append' || mode === 'replace' ? mode : fallback;
}

function normalizeSplitRatio(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.92, Math.max(0.08, Math.round(n * 1000) / 1000));
}

export function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const p = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      knowledgeDir: p.knowledgeDir || DEFAULT_SETTINGS.knowledgeDir,
      importMode: normalizeImportMode(p.importMode, DEFAULT_SETTINGS.importMode),
      splitRatio: normalizeSplitRatio(p.splitRatio, DEFAULT_SETTINGS.splitRatio),
      splitRatioV: normalizeSplitRatio(p.splitRatioV, DEFAULT_SETTINGS.splitRatioV),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next) {
  const cur = loadSettings();
  const merged = {
    ...cur,
    knowledgeDir:
      typeof next?.knowledgeDir === 'string' && next.knowledgeDir.trim()
        ? next.knowledgeDir.trim()
        : cur.knowledgeDir,
    importMode: normalizeImportMode(next?.importMode, cur.importMode),
    splitRatio: normalizeSplitRatio(next?.splitRatio, cur.splitRatio),
    splitRatioV: normalizeSplitRatio(next?.splitRatioV, cur.splitRatioV),
  };
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

export function loadIndex() {
  try {
    const st = statSync(INDEX_PATH);
    if (indexCache.data && indexCache.mtimeMs === st.mtimeMs && indexCache.size === st.size) {
      return indexCache.data;
    }
    const p = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
    const valid = Array.isArray(p?.chunks) ? p : null;
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, data: valid };
    return valid;
  } catch {
    indexCache = { mtimeMs: -1, size: -1, data: null };
    return null;
  }
}

export function getIndexStatus() {
  const settings = loadSettings();
  const kbDir = settings.knowledgeDir;
  const idx = loadIndex();
  return {
    knowledgeDirExists: Boolean(kbDir && existsSync(kbDir)),
    knowledgeDirPath: kbDir,
    indexExists: Boolean(idx),
    chunkCount: idx ? idx.chunks.length : 0,
    fileCount: idx ? new Set(idx.chunks.map((c) => c.filePath)).size : 0,
    generatedAt: idx?.generatedAt ?? null,
    pdfSupported: hasPdfParser(),
    embedding: idx?.embedding ?? { enabled: false, model: '', dims: 0 },
  };
}

// ---------------- Local BGE ONNX Persistent Worker ----------------
let bgeProc = null;
let bgeReqId = 1;
const bgePending = new Map();

export function hasLocalBge() {
  return existsSync(LOCAL_BGE_PYTHON) && existsSync(LOCAL_BGE_WORKER) && existsSync(LOCAL_BGE_MODEL);
}

function hasBgeBackend() {
  return Boolean(SHARED_BGE_HTTP && process.env.BGE_EMBED_DISABLE_HTTP !== '1') || hasLocalBge();
}

export function shutdownEmbedder() {
  if (bgeProc) {
    try {
      bgeProc.kill();
    } catch {
      // Ignore
    }
    bgeProc = null;
  }
  for (const [, p] of bgePending) {
    clearTimeout(p.timer);
    p.reject(new Error('local bge worker closed'));
  }
  bgePending.clear();
}

function ensureBgeWorker() {
  if (bgeProc && !bgeProc.killed) return bgeProc;
  const child = spawn(LOCAL_BGE_PYTHON, [LOCAL_BGE_WORKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = bgePending.get(msg.id);
      if (!p) continue;
      bgePending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.embeddings);
    }
  });
  child.on('exit', () => {
    if (bgeProc === child) bgeProc = null;
    for (const [id, p] of bgePending) {
      clearTimeout(p.timer);
      p.reject(new Error('local bge worker exited'));
      bgePending.delete(id);
    }
  });
  bgeProc = child;
  return child;
}

async function embedSharedHttpBge(texts, isQuery = false) {
  if (!SHARED_BGE_HTTP || process.env.BGE_EMBED_DISABLE_HTTP === '1') return null;
  try {
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32);
      const res = await fetch(`${SHARED_BGE_HTTP}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'bge-small-zh-v1.5', input: batch, is_query: Boolean(isQuery) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const j = await res.json();
      if (!Array.isArray(j.data) || j.data.length !== batch.length) return null;
      j.data.sort((a, b) => a.index - b.index);
      out.push(...j.data.map((d) => d.embedding));
    }
    return out;
  } catch {
    return null;
  }
}

async function embedTexts(texts, isQuery = false) {
  if (!texts.length) return null;
  const shared = await embedSharedHttpBge(texts, isQuery);
  if (shared) return shared;
  if (!hasLocalBge()) return null;
  const child = ensureBgeWorker();
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const id = bgeReqId++;
    const vecs = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bgePending.delete(id);
        reject(new Error('local bge worker timeout'));
      }, 60000);
      bgePending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, texts: batch, is_query: isQuery }) + '\n');
    });
    out.push(...vecs);
  }
  return out;
}

function vecToB64(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer).toString('base64');
}

function b64ToVec(s) {
  const b = Buffer.from(s, 'base64');
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

function cosine(a, b) {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// ---------------- Document Parsing & Lifecycle ----------------
function makeId(key) {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function summarize(text, maxLen = 160) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}

function parseDocFrontmatter(rawText) {
  const meta = { status: 'active', supersededBy: '', reviewAfterMs: null, reviewAfterStr: '' };
  const m = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (k === 'status' && ['active', 'deprecated', 'superseded', 'expired'].includes(v.toLowerCase())) {
      meta.status = v.toLowerCase();
    } else if (k === 'superseded_by') {
      meta.supersededBy = v;
    } else if (k === 'review_after') {
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) {
        meta.reviewAfterMs = ts;
        meta.reviewAfterStr = v;
      }
    }
  }
  return meta;
}

function collectFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFiles(full));
    else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.md' || ext === '.pdf' || ext === '.docx') results.push(full);
    }
  }
  return results;
}

export function getDocxLines(filePath) {
  let st = null;
  try {
    st = statSync(filePath);
    const cached = docxLinesCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.lines;
    }
  } catch {
    // Let parser throw standard file error if unreadable
  }
  const candidates = [
    process.env.KB_PYTHON,
    process.env.KB_BGE_PYTHON,
    'python',
    'python3',
    'py',
  ].filter(Boolean);
  let lastErr = null;
  for (const py of candidates) {
    try {
      const out = execFileSync(py, [join(PLUGIN_DIR, 'parse_docx.py'), filePath], {
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
      });
      const lines = JSON.parse(out);
      if (st) {
        if (docxLinesCache.size > 16) docxLinesCache.delete(docxLinesCache.keys().next().value);
        docxLinesCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, lines });
      }
      return lines;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  throw lastErr || new Error('未找到可用的 Python 解释器来解析 .docx 文件');
}

function sliceLines(lines, filePath, relativePath, docType, docMeta) {
  const chunks = [];
  const sections = [];
  let current = { heading: relativePath, startLine: 0, endLine: 0, lines: [] };
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) inCode = !inCode;
    const m = !inCode ? line.match(/^(#{1,4})\s+(.+)$/) : null;
    if (m) {
      if (current.lines.some((l) => l.trim().length > 0)) {
        current.endLine = Math.max(current.startLine, i - 1);
        sections.push(current);
      }
      current = { heading: m[2].trim(), startLine: i, endLine: i, lines: [line] };
    } else {
      if (current.lines.length === 0) current.startLine = i;
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim().length > 0)) {
    current.endLine = Math.max(current.startLine, lines.length - 1);
    sections.push(current);
  }

  for (const sec of sections) {
    const fullText = sec.lines.join('\n').trim();
    if (!fullText) continue;
    if (fullText.length <= 1000) {
      chunks.push({
        id: makeId(`${relativePath}:${sec.startLine}:${sec.heading}`),
        filePath,
        relativePath,
        type: docType,
        headingTitle: sec.heading,
        startLine: sec.startLine,
        endLine: sec.endLine,
        text: fullText,
        summary: summarize(fullText),
        ...docMeta,
      });
    } else {
      let subStart = sec.startLine;
      let buf = [];
      let bufLen = 0;
      const flush = (endIdx) => {
        const text = buf.join('\n').trim();
        if (!text) return;
        chunks.push({
          id: makeId(`${relativePath}:${subStart}:${endIdx}:${sec.heading}`),
          filePath,
          relativePath,
          type: docType,
          headingTitle: sec.heading,
          startLine: subStart,
          endLine: endIdx,
          text,
          summary: summarize(text),
          ...docMeta,
        });
      };
      for (let off = 0; off < sec.lines.length; off++) {
        const ln = sec.lines[off];
        const abs = sec.startLine + off;
        if (buf.length === 0) subStart = abs;
        buf.push(ln);
        bufLen += ln.length + 1;
        if ((ln.trim() === '' && bufLen >= 450) || bufLen >= 900) {
          flush(abs);
          buf = [];
          bufLen = 0;
        }
      }
      if (buf.length > 0) flush(sec.endLine);
    }
  }
  return chunks;
}

function parseMarkdown(filePath, relativePath) {
  const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const docMeta = parseDocFrontmatter(raw);
  const lines = raw.split(/\r?\n/);
  return sliceLines(lines, filePath, relativePath, 'markdown', docMeta);
}

function parseDocx(filePath, relativePath) {
  try {
    const lines = getDocxLines(filePath);
    const meta = { status: 'active', supersededBy: '', reviewAfterMs: null, reviewAfterStr: '' };
    return sliceLines(lines, filePath, relativePath, 'docx', meta);
  } catch {
    return [];
  }
}

async function parsePdf(filePath, relativePath) {
  const parser = getPdfParser();
  if (!parser) return [];
  const chunks = [];
  const meta = { status: 'active', supersededBy: '', reviewAfterMs: null, reviewAfterStr: '' };
  try {
    const pages = [];
    await parser(readFileSync(filePath), {
      pagerender: async (pageData) => {
        const content = await pageData.getTextContent({ normalizeWhitespace: true });
        const pageText = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
        pages.push(pageText);
        return pageText;
      },
    });
    pages.forEach((pageText, i) => {
      if (!pageText) return;
      const pageNumber = i + 1;
      chunks.push({
        id: makeId(`${relativePath}:page:${pageNumber}`),
        filePath,
        relativePath,
        type: 'pdf',
        headingTitle: `${relativePath} (第 ${pageNumber} 页)`,
        pageNumber,
        text: pageText,
        summary: summarize(pageText),
        ...meta,
      });
    });
  } catch {
    // Ignore unreadable PDF
  }
  return chunks;
}

export async function rebuildIndex(customDir) {
  if (customDir && customDir.trim()) {
    saveSettings({ knowledgeDir: customDir.trim() });
  }
  const kbDir = loadSettings().knowledgeDir;
  const chunks = [];

  if (kbDir && existsSync(kbDir)) {
    for (const filePath of collectFiles(kbDir)) {
      const rel = relative(kbDir, filePath).replace(/\\/g, '/');
      const ext = extname(filePath).toLowerCase();
      if (ext === '.md') chunks.push(...parseMarkdown(filePath, rel));
      else if (ext === '.pdf') chunks.push(...(await parsePdf(filePath, rel)));
      else if (ext === '.docx') chunks.push(...parseDocx(filePath, rel));
    }
  }

  let embeddingMeta = { enabled: false, model: '', dims: 0 };
  if (chunks.length > 0 && hasBgeBackend()) {
    try {
      const vecs = await embedTexts(
        chunks.map((c) => `${c.relativePath}\n${c.headingTitle}\n${c.text}`.slice(0, 1500)),
        false
      );
      if (vecs && vecs.length === chunks.length) {
        const dims = vecs[0].length;
        chunks.forEach((c, i) => {
          c.vec = vecToB64(vecs[i]);
        });
        embeddingMeta = { enabled: true, model: BGE_MODEL_TAG, dims };
      }
    } catch {
      // Fall back to BM25-only if BGE fails
    }
  }

  const index = {
    version: 2,
    generatedAt: new Date().toISOString(),
    knowledgeDir: kbDir,
    embedding: embeddingMeta,
    chunks,
  };
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
  return getIndexStatus();
}

// ---------------- Hybrid RAG Search (BGE + BM25 + RRF + Lifecycle) ----------------
function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  const words = lower.match(/[a-z0-9_.\u00a7-]+/g);
  if (words) tokens.push(...words);
  const cjk = lower.match(/[\u4e00-\u9fff]+/g);
  if (cjk) {
    for (const run of cjk) {
      if (run.length === 1) {
        tokens.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          tokens.push(run.slice(i, i + 2));
        }
      }
    }
  }
  return tokens;
}

export async function searchChunks(query, topK = 15, includeInactive = false) {
  let idx = loadIndex();
  if (!idx) {
    await rebuildIndex();
    idx = loadIndex();
  } else if (!idx.embedding?.enabled && hasLocalBge() && idx.chunks?.length > 0) {
    // Auto-upgrade legacy vectorless index
    await rebuildIndex();
    idx = loadIndex();
  }

  const allChunks = idx?.chunks ?? [];
  const chunks = includeInactive
    ? allChunks
    : allChunks.filter((c) => !c.status || c.status === 'active');

  const q = String(query || '').trim();
  if (!chunks.length || !q) return [];

  const qTokens = Array.from(new Set(tokenize(q)));
  const df = new Map();
  const docs = chunks.map((chunk) => {
    const titleSet = new Set(tokenize(chunk.headingTitle));
    const body = tokenize(chunk.text);
    const counts = new Map();
    for (const t of body) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of new Set([...titleSet, ...counts.keys()])) {
      if (qTokens.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    return { chunk, titleSet, counts, len: Math.max(1, body.length) };
  });

  const N = chunks.length;
  const bm25Scores = docs.map(({ titleSet, counts, len }) => {
    let score = 0;
    for (const qt of qTokens) {
      const freq = counts.get(qt) ?? 0;
      const inTitle = titleSet.has(qt);
      if (freq === 0 && !inTitle) continue;
      const idf = Math.log(1 + (N + 1) / ((df.get(qt) ?? 0) + 1));
      const tf = (freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * (len / 200)));
      score += (tf + (inTitle ? 1.8 : 0)) * idf;
    }
    return score;
  });

  let qv = null;
  if (idx?.embedding?.enabled && hasBgeBackend()) {
    try {
      const res = await embedTexts([q], true);
      qv = res?.[0] || null;
    } catch {
      qv = null;
    }
  }

  const nowMs = Date.now();
  const vSims = chunks.map((ch) => (qv && ch.vec ? cosine(qv, b64ToVec(ch.vec)) : 0));

  // Dual noise floor
  const eligibleIdx = [];
  for (let i = 0; i < chunks.length; i++) {
    if (qv) {
      if (vSims[i] >= 0.42 || (bm25Scores[i] >= 1.8 && vSims[i] >= 0.30)) {
        eligibleIdx.push(i);
      }
    } else if (bm25Scores[i] > 0) {
      eligibleIdx.push(i);
    }
  }

  if (!eligibleIdx.length) return [];

  const bm25Pos = eligibleIdx.filter((i) => bm25Scores[i] > 0).sort((a, b) => bm25Scores[b] - bm25Scores[a]);
  const bm25Rank = new Map(bm25Pos.map((ci, r) => [ci, r + 1]));

  const vecRanked = qv
    ? [...eligibleIdx].sort((a, b) => vSims[b] - vSims[a])
    : [];
  const vecRank = new Map(vecRanked.map((ci, r) => [ci, r + 1]));

  const scored = eligibleIdx.map((ci) => {
    const ch = chunks[ci];
    let rrf = 0;
    if (bm25Rank.has(ci)) rrf += 1 / (RRF_K + bm25Rank.get(ci));
    if (vecRank.has(ci)) rrf += 1 / (RRF_K + vecRank.get(ci));
    if (qv) rrf += 0.05 * Math.max(0, vSims[ci]);

    const isOverdue = Boolean(ch.reviewAfterMs && nowMs > ch.reviewAfterMs);
    if (ch.status && ch.status !== 'active') rrf *= 0.35;
    else if (isOverdue) rrf *= 0.60;

    return {
      chunkId: ch.id,
      relativePath: ch.relativePath,
      headingTitle: ch.headingTitle,
      type: ch.type,
      startLine: ch.startLine,
      endLine: ch.endLine,
      pageNumber: ch.pageNumber,
      summary: ch.summary,
      status: ch.status || 'active',
      supersededBy: ch.supersededBy || '',
      reviewAfterStr: ch.reviewAfterStr || '',
      isOverdue,
      vecSim: Number(vSims[ci].toFixed(3)),
      bm25: Number(bm25Scores[ci].toFixed(2)),
      score: rrf,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function pushCards(segments, source = 'antigravity', options = {}) {
  const settings = loadSettings();
  const mode = normalizeImportMode(options?.mode, settings.importMode);
  const groupTitle = typeof options?.title === 'string' ? options.title.trim() : '';
  const now = Date.now();
  const groupId = makeId(`${now}:${Math.random()}:${source}`);

  const idx = loadIndex();
  const chunkMap = new Map((idx?.chunks ?? []).map((c) => [c.id, c]));
  const normalized = (segments || []).map((seg) => {
    const cid =
      typeof seg.matchedChunkId === 'string' && chunkMap.has(seg.matchedChunkId)
        ? seg.matchedChunkId
        : null;
    const chunk = cid ? chunkMap.get(cid) : null;
    return {
      text: String(seg.text ?? ''),
      segmentType: String(seg.segmentType ?? '题目片段'),
      matchedChunkId: cid,
      knowledgeTag: String(seg.knowledgeTag ?? ''),
      groupId,
      groupTitle,
      pushedAt: now,
      matchedChunk: chunk
        ? {
            id: chunk.id,
            relativePath: chunk.relativePath,
            headingTitle: chunk.headingTitle,
            type: chunk.type,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            pageNumber: chunk.pageNumber,
            status: chunk.status || 'active',
            reviewAfterStr: chunk.reviewAfterStr || '',
            isOverdue: Boolean(chunk.reviewAfterMs && now > chunk.reviewAfterMs),
          }
        : null,
    };
  });

  const existing = loadLatestCards();
  const existingSegments =
    mode === 'append' && Array.isArray(existing?.segments)
      ? existing.segments.map((s) => (s.groupId ? s : { ...s, groupId: 'legacy' }))
      : [];
  const finalSegments = mode === 'append' ? [...existingSegments, ...normalized] : normalized;
  const updatedAt = Math.max(now, Number(existing?.updatedAt || 0) + 1);

  mkdirSync(PLUGIN_DIR, { recursive: true });
  const payload = {
    updatedAt,
    source,
    mode,
    lastAddedGroupId: normalized.length > 0 ? groupId : '',
    segments: finalSegments,
  };
  writeFileSync(CARDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  cardsCache = { mtimeMs: -1, size: -1, data: null };
  return {
    pushed: normalized.length,
    total: finalSegments.length,
    mode,
    groupId,
    updatedAt,
    segments: finalSegments,
  };
}

export function clearCards(source = 'user') {
  const existing = loadLatestCards();
  const updatedAt = Math.max(Date.now(), Number(existing?.updatedAt || 0) + 1);
  const payload = {
    updatedAt,
    source,
    mode: 'replace',
    lastAddedGroupId: '',
    segments: [],
  };
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(CARDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  cardsCache = { mtimeMs: -1, size: -1, data: null };
  return { cleared: true, updatedAt, segments: [] };
}

export function removeCardGroup(groupId, source = 'user') {
  const target = String(groupId || '').trim();
  const existing = loadLatestCards();
  const prev = Array.isArray(existing?.segments) ? existing.segments : [];
  const remaining = prev.filter((s) => (s.groupId || 'legacy') !== target);
  const updatedAt = Math.max(Date.now(), Number(existing?.updatedAt || 0) + 1);
  const payload = {
    updatedAt,
    source,
    mode: existing?.mode || loadSettings().importMode,
    lastAddedGroupId: '',
    segments: remaining,
  };
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(CARDS_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  cardsCache = { mtimeMs: -1, size: -1, data: null };
  return {
    removed: prev.length - remaining.length,
    total: remaining.length,
    updatedAt,
    segments: remaining,
  };
}

export function loadLatestCards() {
  try {
    const st = statSync(CARDS_PATH);
    if (cardsCache.data && cardsCache.mtimeMs === st.mtimeMs && cardsCache.size === st.size) {
      return cardsCache.data;
    }
    const parsed = JSON.parse(readFileSync(CARDS_PATH, 'utf-8'));
    cardsCache = { mtimeMs: st.mtimeMs, size: st.size, data: parsed };
    return parsed;
  } catch {
    cardsCache = { mtimeMs: -1, size: -1, data: null };
    return { updatedAt: 0, source: '', segments: [] };
  }
}
