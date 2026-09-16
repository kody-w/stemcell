// @ts-check
/**
 * Shared shape for every body that lives behind a copilot-harness-sdk HarnessClient
 * (the Copilot SDK in-process or headless, a Copilot Studio agent, agentic Direct Line).
 *
 * The RAPP wire in, the SDK's normalized events out, the RAPP wire back:
 *   payload {user_input, session_id, conversation_history, user_guid}
 *   → frames {type: "delta"|"agent"|"done"|"error"} exactly like the grail's /chat/stream
 *   → chat() folds the frames into {response, session_id, agent_logs, model, body}
 */
import { randomUUID } from 'node:crypto';

function foldHistory(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const lines = history
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`);
  return lines.length ? `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n` : '';
}

/**
 * @param {{
 *   kind: string, label: string, capabilities: () => any,
 *   createClient: () => Promise<any>,
 *   beforeTurn?: (payload: any) => void,
 *   health?: () => Promise<any>,
 * }} spec
 */
export function createHarnessBody(spec) {
  let clientPromise = null;
  const sessions = new Map();   // session_id -> { session, turns }

  const client = () => (clientPromise ||= spec.createClient());

  async function sessionFor(sessionId) {
    const c = await client();
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { session: await c.createSession({ sessionId }), turns: 0 };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  return {
    kind: spec.kind,
    label: spec.label,
    capabilities: spec.capabilities,
    async health() {
      if (spec.health) return spec.health();
      const c = await client();
      const pre = c.preflight ? await c.preflight().catch((e) => ({ ok: false, error: e.message })) : { ok: true };
      return { ok: pre?.ok !== false, ...pre };
    },
    async *stream(payload) {
      const sessionId = payload.session_id || randomUUID();
      spec.beforeTurn?.(payload);
      const entry = await sessionFor(sessionId);
      const prefix = entry.turns === 0 ? foldHistory(payload.conversation_history) : '';
      entry.turns += 1;
      let text = '', model = null, failed = null;
      const logs = [];
      const toolNames = new Map();
      const c = await client();
      const caps = c.capabilities?.() || {};
      const debug = process.env.STEMCELL_DEBUG ? (ev) => console.error(`[stemcell:${spec.kind}] ${ev.type}${ev.type === 'raw' ? ':' + (ev.raw?.type || '?') : ''} ${JSON.stringify(ev.type === 'raw' ? (ev.raw?.data ?? ev.raw) : { ...ev, raw: undefined, source: undefined }).slice(0, 300)}`) : null;
      for await (const ev of entry.session.stream(prefix + String(payload.user_input ?? ''))) {
        debug?.(ev);
        if (ev.type === 'tool.start' && ev.id) toolNames.set(ev.id, ev.name);
        if (ev.type === 'tool.end' && !ev.name) ev.name = toolNames.get(ev.id) || ev.id;
        switch (ev.type) {
          case 'text.delta':
            if (ev.delta) { text = ev.snapshot ?? text + ev.delta; yield { type: 'delta', text: ev.delta }; }
            break;
          case 'text.final':
            if (ev.text && ev.text.length > text.length) { const rest = ev.text.slice(text.length); text = ev.text; if (rest) yield { type: 'delta', text: rest }; }
            if (ev.model) model = ev.model;
            break;
          case 'tool.start':
            logs.push(`[${ev.name}] ${ev.args ? JSON.stringify(ev.args).slice(0, 300) : ''}`.trim());
            yield { type: 'agent', logs: logs[logs.length - 1] };
            break;
          case 'tool.end':
            logs.push(`[${ev.name || ev.id}] ${ev.success ? 'ok' : 'failed'}${ev.error ? ': ' + ev.error : ''}`);
            break;
          case 'status':
            if (ev.text) logs.push(`[status] ${ev.text}`);
            break;
          case 'usage':
            if (ev.model) model = ev.model;
            break;
          case 'error':
            failed = ev.error?.message || String(ev.error || 'turn failed') + (ev.hint ? ` (${ev.hint})` : '');
            break;
          case 'idle':
            break;
          default:
            break;
        }
      }
      if (failed && !text) { yield { type: 'error', error: failed }; return; }
      yield {
        type: 'done', response: text, session_id: sessionId, agent_logs: logs.join('\n'),
        model: model || caps.model || null, requested_model: caps.model || null, body: spec.kind, streamed: true,
        ...(failed ? { warning: failed } : {})
      };
    },
    async chat(payload) {
      let done = null, error = null;
      for await (const f of this.stream(payload)) {
        if (f.type === 'done') done = f;
        if (f.type === 'error') error = f.error;
      }
      if (!done) throw new Error(error || 'no answer');
      const { type, ...rest } = done;
      return rest;
    },
    async close() {
      for (const { session } of sessions.values()) await session.close?.().catch(() => {});
      sessions.clear();
      if (clientPromise) await (await clientPromise).close?.().catch(() => {});
      clientPromise = null;
    }
  };
}
