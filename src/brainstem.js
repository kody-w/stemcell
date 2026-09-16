// @ts-check
/**
 * shapeshift(where) → the brainstem, in whatever body `where` names, speaking the RAPP wire.
 *
 * Body specs (a string, or the object form):
 *   http://host:port                         a running brainstem (grail, lab, Azure Function, LAN twin)
 *   sdk  |  sdk:<genome dir>                 the Copilot SDK in this process, genome from disk
 *   headless:<host:port>[:<genome dir>]      the Copilot SDK against a `copilot --headless --port N` runtime
 *   studio:<environmentId>/<schemaName>      a Copilot Studio harness agent over /3p (delegated Entra token)
 *   directline:<environmentId>/<schemaName>  the same agent over no-auth agentic Direct Line
 */
import { readGenome, defaultGenomeDir } from './genome.js';
import { createHttpBody } from './bodies/http.js';
import { createSdkBody } from './bodies/sdk.js';
import { createStudioBody } from './bodies/studio.js';

export const BODIES = ['http', 'sdk', 'headless', 'studio', 'directline'];

/** @param {string|object} spec */
export function parseSpec(spec) {
  if (spec && typeof spec === 'object') return spec;
  const s = String(spec || '').trim();
  if (!s) throw new Error('empty body spec');
  if (/^https?:\/\//i.test(s)) return { body: 'http', url: s };
  const [head, ...rest] = s.split(':');
  const tail = rest.join(':');
  switch (head) {
    case 'http': return { body: 'http', url: tail };
    case 'sdk': return { body: 'sdk', genome: tail || undefined };
    case 'headless': {
      const m = tail.match(/^([^/]+?:\d+)(?::(.+))?$/);
      if (!m) throw new Error(`headless spec must be headless:<host:port>[:<genome dir>], got ${s}`);
      return { body: 'headless', runtimeUri: m[1], genome: m[2] || undefined };
    }
    case 'studio':
    case 'directline': {
      const m = tail.match(/^([^/]+)\/(.+)$/);
      if (!m) throw new Error(`${head} spec must be ${head}:<environmentId>/<schemaName>, got ${s}`);
      return { body: head, environmentId: m[1], schemaName: m[2] };
    }
    default:
      if (/^[\w.-]+:\d+$/.test(s)) return { body: 'http', url: `http://${s}` };
      throw new Error(`unknown body spec ${s}; expected one of ${BODIES.join(', ')}`);
  }
}

/**
 * @param {string|object} where
 * @param {{ model?: string, execute?: 'off'|'all', secret?: string, turnTimeoutMs?: number, onDeviceCode?: (m: string) => void, genome?: any }} [opts]
 */
export async function shapeshift(where, opts = {}) {
  const spec = parseSpec(where);
  let body;
  switch (spec.body) {
    case 'http':
      body = createHttpBody({ url: spec.url, secret: opts.secret || spec.secret || process.env.BRAINSTEM_SECRET, timeoutMs: opts.turnTimeoutMs });
      break;
    case 'sdk':
    case 'headless': {
      const genome = opts.genome || await readGenome(spec.genome || defaultGenomeDir());
      body = createSdkBody({
        genome, runtimeUri: spec.runtimeUri, model: opts.model || spec.model, execute: opts.execute || spec.execute,
        githubToken: spec.githubToken || process.env.GITHUB_TOKEN || undefined, sessionGithubToken: spec.sessionGithubToken,
        byok: spec.byok, mcpServers: spec.mcpServers, turnTimeoutMs: opts.turnTimeoutMs
      });
      body.genome = genome;
      break;
    }
    case 'studio':
    case 'directline':
      body = createStudioBody({
        environmentId: spec.environmentId, schemaName: spec.schemaName,
        mode: spec.body === 'directline' ? 'agentic-directline' : 'copilot-studio-3p',
        clientId: spec.clientId, tenantId: spec.tenantId, cacheFile: spec.cacheFile, onDeviceCode: opts.onDeviceCode, turnTimeoutMs: opts.turnTimeoutMs
      });
      break;
    default:
      throw new Error(`unknown body ${spec.body}`);
  }
  return Object.assign(body, { spec });
}
