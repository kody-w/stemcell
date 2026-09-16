// @ts-check
/**
 * Serve the RAPP wire over any body, with the grail's own chat page in front of it.
 *
 *   POST /chat          {user_input, session_id?, conversation_history?, user_guid?} → {response, session_id, ...}
 *   POST /chat/stream   same body; SSE frames {"type":"delta"|"agent"|"done"|"error"}
 *   GET  /health        {status:"ok", body, agents, ...}
 *   GET  /              ui/index.html (the grail's page, verbatim) plus the compat routes it calls
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

function send(res, status, json, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Brainstem-Secret', ...extra });
  res.end(JSON.stringify(json));
}

/**
 * @param {any} brainstem   the body from shapeshift()
 * @param {{ port?: number, host?: string, log?: (line: string) => void }} [opts]
 */
export function serve(brainstem, opts = {}) {
  const log = opts.log || ((l) => console.error(l));
  // A host must never identify its child by port: this token in /health says "that is MY server".
  const instance = opts.instance || randomUUID();
  const caps = () => brainstem.capabilities();
  const agentNames = () => { const c = caps(); return Array.isArray(c.agents) ? c.agents : []; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {});
      if (path === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(UI)); }
      if (path === '/health') {
        const remote = brainstem.kind === 'http' ? await brainstem.health().catch((e) => ({ ok: false, error: e.message })) : null;
        return send(res, 200, {
          status: remote && !remote.ok ? 'unreachable' : 'ok', version: VERSION, instance, body: brainstem.kind, label: brainstem.label,
          model: caps().model || remote?.model || 'auto', soul: brainstem.genome?.soulPath || remote?.soul || 'on the body',
          agents: remote?.agents || agentNames(), skills: caps().skills || [], quarantined: [], copilot: '✓', voice_mode: false,
          brainstem_dir: brainstem.genome?.dir || brainstem.label, capabilities: caps(), ...(remote?.error ? { error: remote.error } : {})
        });
      }
      if (path === '/chat' && req.method === 'POST') {
        const payload = await readJson(req);
        const t = Date.now();
        const out = await brainstem.chat(payload);
        log(`[stemcell] ${brainstem.kind} /chat ${Date.now() - t} ms session=${out.session_id}`);
        return send(res, 200, { voice_mode: false, ...out });
      }
      if (path === '/chat/stream' && req.method === 'POST') {
        const payload = await readJson(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        const t = Date.now();
        try {
          for await (const frame of brainstem.stream(payload)) res.write(`data: ${JSON.stringify(frame.type === 'done' ? { voice_mode: false, ...frame } : frame)}\n\n`);
        } catch (e) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
        }
        log(`[stemcell] ${brainstem.kind} /chat/stream ${Date.now() - t} ms`);
        return res.end();
      }
      // compat routes the grail page calls on load; none of them mean anything on a shifted body
      if (path === '/version') return send(res, 200, { version: VERSION, body: brainstem.kind });
      if (path === '/models' && req.method === 'GET') return send(res, 200, { models: [], current: caps().model || 'auto' });
      if (path === '/models/set') return send(res, 200, { status: 'ok', model: caps().model || 'auto', note: 'pick the model where the body is configured' });
      if (path === '/login/status') return send(res, 200, { pending: false, body: brainstem.kind });
      if (path.startsWith('/login')) return send(res, 200, { status: 'ok', note: `auth belongs to the ${brainstem.kind} body` });
      if (path === '/voice') return send(res, 200, { voice_mode: false });
      if (path.startsWith('/voice')) return send(res, 200, {});
      if (path === '/agents' && req.method === 'GET') {
        const g = brainstem.genome;
        const list = g ? g.agents.map((a) => ({ filename: a.file.split('/').pop(), agents: [a.name] })) : agentNames().map((n) => ({ filename: `${n} (on the ${brainstem.kind} body)`, agents: [n] }));
        return send(res, 200, list);
      }
      if (path === '/diagnostics/book.json') return send(res, 200, {});
      return send(res, 404, { error: `no route ${req.method} ${path} on a shifted brainstem` });
    } catch (e) {
      log(`[stemcell] ${req.method} ${path} failed: ${e.message}`);
      if (!res.headersSent) return send(res, e.statusCode || 500, { error: e.message });
      res.end();
    }
  });

  const host = opts.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7099, host, () => {
      const addr = /** @type {any} */ (server.address());
      resolve({ server, url: `http://${host}:${addr.port}`, port: addr.port, instance, close: () => new Promise((r) => server.close(() => r(undefined))) });
    });
  });
}
