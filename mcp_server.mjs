import { createInterface } from 'node:readline';
import { pushCards, rebuildIndex, searchChunks, shutdownEmbedder } from './kb_engine.mjs';

const TOOLS = [
  {
    name: 'kj_search',
    description:
      'Hybrid RAG search (BGE semantic vectors + BM25 RRF) on KnowledgeJump local knowledge base, filtering deprecated/superseded docs by default.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Problem keywords or OCR text to search.' },
        top_k: { type: 'number', description: 'Maximum candidate chunks to return (default 15).' },
        include_inactive: {
          type: 'boolean',
          description: 'Include docs marked deprecated/superseded in frontmatter (default false).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'kj_rebuild_index',
    description: 'Rebuild the KnowledgeJump local Hybrid RAG index from .md, .docx, and .pdf files.',
    inputSchema: {
      type: 'object',
      properties: {
        knowledge_dir: { type: 'string', description: 'Optional new knowledge_base directory path.' },
      },
    },
  },
  {
    name: 'kj_push_cards',
    description: 'Push Antigravity-analyzed problem segments (with LaTeX and matchedChunkId) into the KnowledgeJump Sidecar UI.',
    inputSchema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              segmentType: { type: 'string' },
              matchedChunkId: { type: ['string', 'null'] },
              knowledgeTag: { type: 'string' },
            },
            required: ['text', 'segmentType'],
          },
        },
      },
      required: ['segments'],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => shutdownEmbedder());

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined) return;

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'knowledge-jump-kb', version: '2.0.0' },
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      let out;
      if (name === 'kj_search') {
        out = await searchChunks(args.query, args.top_k || 15, Boolean(args.include_inactive));
      } else if (name === 'kj_rebuild_index') {
        out = await rebuildIndex(args.knowledge_dir);
      } else if (name === 'kj_push_cards') {
        out = pushCards(args.segments, 'antigravity');
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] },
      });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      },
    });
  }
});
