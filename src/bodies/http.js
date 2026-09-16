// @ts-check
/**
 * Body "http": a brainstem that is already running somewhere and speaks the RAPP wire
 * (the grail on :7071, the lab on :7081, a Tier 2 Azure Function, a LAN twin).
 * Nothing is translated; the request and the frames pass through.
 */

/** Parse an SSE byte stream into JSON frames. */
async function* sseFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      try { yield JSON.parse(data); } catch { yield { type: 'raw', text: data }; }
    }
  }
}

/**
 * @param {{ url: string, secret?: string, timeoutMs?: number }} cfg
 */
export function createHttpBody(cfg) {
  const base = cfg.url.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.secret) headers['X-Brainstem-Secret'] = cfg.secret;
  const timeoutMs = cfg.timeoutMs || 180000;

  async function post(path, payload, accept = 'application/json') {
    const r = await fetch(base + path, { method: 'POST', headers: { ...headers, Accept: accept }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    return r;
  }

  return {
    kind: 'http',
    label: base,
    capabilities() {
      return { body: 'http', reaches: base, streaming: 'passthrough', agents: 'whatever the remote brainstem loaded', userGuid: true, notes: ['Every field of the RAPP /chat contract passes through untouched.'] };
    },
    async health() {
      const r = await fetch(base + '/health', { headers, signal: AbortSignal.timeout(10000) });
      const json = await r.json().catch(() => ({}));
      return { ok: r.ok && json.status === 'ok', status: r.status, ...json };
    },
    /** The agent files the remote brainstem has on disk: [{filename, agents: [names]}]. */
    async listAgents() {
      const r = await fetch(base + '/agents', { headers, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${base}/agents → ${r.status}`);
      const json = await r.json();
      const files = Array.isArray(json) ? json : json.files || [];
      return files.filter((f) => f && typeof f.filename === 'string');
    },
    /** One agent file's source, or null when the remote brainstem has no such file. */
    async exportAgent(filename) {
      const r = await fetch(`${base}/agents/export/${encodeURIComponent(filename)}`, { headers: { ...headers, Accept: '*/*' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      return r.text();
    },
    async chat(payload) {
      const r = await post('/chat', payload);
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(json.error || `${base}/chat → ${r.status}`), { statusCode: r.status });
      return json;
    },
    async *stream(payload) {
      const r = await post('/chat/stream', payload, 'text/event-stream');
      if (r.status === 404 || r.status === 405) {
        // an older brainstem without /chat/stream: one delta, then done
        const json = await this.chat(payload);
        yield { type: 'delta', text: json.response || '' };
        yield { type: 'done', ...json };
        return;
      }
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => '');
        yield { type: 'error', error: `${base}/chat/stream → ${r.status} ${text.slice(0, 200)}` };
        return;
      }
      for await (const frame of sseFrames(r.body)) yield frame;
    },
    async close() {}
  };
}
