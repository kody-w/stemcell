// @ts-check
/**
 * Parity proof: the same turns against every body, regex asserts on every answer, one JSON record.
 * turns.json: [{"prompt": "...", "expect": ["regex", "regex|alt"], "note": "...", "bodies": ["sdk", ...]?}]
 */
import { shapeshift } from './brainstem.js';

/**
 * @param {string[]} specs
 * @param {any[]} turns
 * @param {{ opts?: any, log?: (line: string) => void, sessionPrefix?: string }} [options]
 */
export async function prove(specs, turns, options = {}) {
  const log = options.log || ((l) => console.log(l));
  const bodies = [];
  for (const spec of specs) {
    const started = Date.now();
    let brainstem, results = [], setupError = null;
    try {
      brainstem = await shapeshift(spec, options.opts || {});
      const sessionId = `${options.sessionPrefix || 'prove'}-${brainstem.kind}-${Date.now()}`;
      log(`\n== ${brainstem.label}`);
      for (const t of turns) {
        if (Array.isArray(t.bodies) && !t.bodies.includes(brainstem.kind)) continue;
        const t0 = Date.now();
        let text = '', error = null, model = null, logs = '';
        try {
          const out = await brainstem.chat({ user_input: t.prompt, session_id: sessionId, ...(t.user_guid ? { user_guid: t.user_guid } : {}) });
          text = out.response || ''; model = out.model || null; logs = out.agent_logs || '';
        } catch (e) { error = e.message; }
        const checks = (t.expect || []).map((re) => ({ re, ok: new RegExp(re, 'i').test(text) }));
        const echoed = text.trim() && text.trim() === t.prompt.trim();
        if (echoed) checks.push({ re: '<not the echoed prompt>', ok: false });
        const ok = !error && !echoed && checks.every((c) => c.ok) && !!text.trim();
        results.push({ prompt: t.prompt, note: t.note, answer: text, error, model, agent_logs: logs, checks, ok, ms: Date.now() - t0 });
        log(`${ok ? 'PASS' : 'FAIL'} (${Date.now() - t0} ms) ${t.prompt}\n  → ${(text || error || '').replace(/\s+/g, ' ').slice(0, 240)}`);
        for (const c of checks) if (!c.ok) log(`  missing: /${c.re}/i`);
      }
    } catch (e) {
      setupError = e.message;
      log(`\n== ${spec}\nSETUP FAILED: ${e.message}`);
    } finally {
      await brainstem?.close?.().catch(() => {});
    }
    const passed = results.filter((r) => r.ok).length;
    bodies.push({ spec, body: brainstem?.kind || null, label: brainstem?.label || spec, setupError, passed, total: results.length, ms: Date.now() - started, turns: results });
  }
  const allOk = bodies.every((b) => !b.setupError && b.passed === b.total && b.total > 0);
  return { provedAt: new Date().toISOString(), ok: allOk, bodies };
}

export function summarize(proof) {
  const rows = proof.bodies.map((b) => `${b.setupError ? 'SETUP' : b.passed === b.total ? 'PASS ' : 'FAIL '} ${String(b.passed).padStart(2)}/${String(b.total).padEnd(2)} ${String(b.ms).padStart(6)} ms  ${b.label}${b.setupError ? '  ' + b.setupError : ''}`);
  return rows.join('\n');
}
