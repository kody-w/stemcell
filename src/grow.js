// @ts-check
/**
 * The growing brainstem: a Copilot Studio body that learns.
 *
 *   Studio body ──"Phone a friend"──▶ friend brainstem (LearnNew writes a new agent.py)
 *        ▲                                      │
 *        └──── stemcell grow: pull the new agent into the genome, re-project, redeploy ◀──┘
 *
 * `growOnce` runs one cycle (optionally asking the friend to learn something first);
 * `growWatch` polls the friend and redeploys whenever a new agent appears there,
 * so a capability the Studio body asked its friend to learn becomes a first-class
 * skill of the Studio body without anyone touching the portal.
 */
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttpBody } from './bodies/http.js';
import { readGenome } from './genome.js';
import { buildStudioWorkspace, deployStudio } from './studio-workspace.js';

export const LEARN_PROMPT = (what) => `Use the LearnNew agent with action "create" to create a new agent that ${what}. Reply with the new agent's name and file name.`;

const isAgentFile = (f) => f.endsWith('_agent.py') && f !== 'basic_agent.py' && !f.startsWith('__');
const agentFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter(isAgentFile) : []);
const TRANSIENT = /should be retried later|HTTP 5\d\d|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i;

/** Dataverse answers 500 "Database is currently unavailable" now and then; a growth cycle must survive that. */
async function deployWithRetry(cfg, log, attempts = 3) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await deployStudio(cfg);
    if (last.ok) return last;
    const tail = existsSync(last.log) ? readFileSync(last.log, 'utf8').slice(-2000) : '';
    if (!TRANSIENT.test(tail) || i === attempts) return last;
    log(`[grow] deploy attempt ${i} hit a transient Dataverse failure; retrying in 30 s`);
    await new Promise((r) => setTimeout(r, 30000));
  }
  return last;
}

/**
 * @param {{
 *   friendUrl: string, friendPublicUrl?: string, genomeDir: string, learn?: string,
 *   studio: { name: string, schema: string, environment: string, publisherPrefix?: string, model?: string, tokenCommand?: string, purpose?: string },
 *   workDir?: string, deploy?: boolean, force?: boolean, log?: (line: string) => void, snapshot?: string[]
 * }} cfg
 */
export async function growOnce(cfg) {
  const log = cfg.log || ((l) => console.log(l));
  const friend = createHttpBody({ url: cfg.friendUrl });
  const genomeDir = resolve(cfg.genomeDir);
  const before = cfg.snapshot || (await friend.listAgents()).map((f) => f.filename).filter(isAgentFile);
  const learned = [];
  if (cfg.learn) {
    log(`[grow] asking the friend at ${friend.label} to learn: ${cfg.learn}`);
    const out = await friend.chat({ user_input: LEARN_PROMPT(cfg.learn), session_id: `grow-${Date.now()}` });
    log(`[grow] friend: ${(out.response || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const after = (await friend.listAgents()).map((f) => f.filename).filter(isAgentFile);
  const fresh = after.filter((f) => !before.includes(f));
  const missing = after.filter((f) => !agentFiles(join(genomeDir, 'agents')).includes(f));
  const toPull = [...new Set([...fresh, ...missing])];
  const pulled = [];
  for (const filename of toPull) {
    const code = await friend.exportAgent(filename);
    if (!code) { log(`[grow] could not export ${filename} from the friend`); continue; }
    mkdirSync(join(genomeDir, 'agents'), { recursive: true });
    writeFileSync(join(genomeDir, 'agents', filename), code);
    pulled.push(filename);
    log(`[grow] pulled ${filename} into ${genomeDir}/agents`);
  }
  learned.push(...fresh);
  let deployed = null;
  if (cfg.deploy !== false && (pulled.length || fresh.length || cfg.force)) {
    const genome = await readGenome(genomeDir);
    const workDir = cfg.workDir || join(process.cwd(), '.stemcell', cfg.studio.schema);
    mkdirSync(workDir, { recursive: true });
    const built = await buildStudioWorkspace(genome, { name: cfg.studio.name, schemaName: cfg.studio.schema, model: cfg.studio.model, workDir, purpose: cfg.studio.purpose, friend: { url: cfg.friendPublicUrl || cfg.friendUrl } });
    log(`[grow] re-projected ${genome.agents.length} agents + ${genome.skills.length} skills → ${built.components.length} components; deploying ${cfg.studio.schema}`);
    deployed = await deployWithRetry({ name: cfg.studio.name, schemaName: cfg.studio.schema, publisherPrefix: cfg.studio.publisherPrefix || 'rapp', environment: cfg.studio.environment, workspace: built.workspace, workDir, model: cfg.studio.model, tokenCommand: cfg.studio.tokenCommand, log: (l) => process.stderr.write(l) }, log);
    log(`[grow] deploy ${deployed.ok ? 'ok' : 'FAILED'}${deployed.botId ? ' bot ' + deployed.botId : ''}${deployed.preview ? ' ' + deployed.preview : ''}`);
  } else if (cfg.deploy !== false) {
    log('[grow] nothing new on the friend; nothing to deploy');
  }
  return { before, after, learned, pulled, deployed, snapshot: after };
}

/**
 * Poll the friend; whenever a new agent appears there, pull it and redeploy the Studio body.
 * @param {Parameters<typeof growOnce>[0] & { everyMs?: number, maxCycles?: number, onCycle?: (r: any) => void }} cfg
 */
export async function growWatch(cfg) {
  const log = cfg.log || ((l) => console.log(l));
  const friend = createHttpBody({ url: cfg.friendUrl });
  let snapshot = (await friend.listAgents()).map((f) => f.filename).filter(isAgentFile);
  log(`[grow] watching ${friend.label} every ${Math.round((cfg.everyMs || 30000) / 1000)}s; ${snapshot.length} agents there now`);
  let cycles = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, cfg.everyMs || 30000));
    const now = (await friend.listAgents().catch(() => null));
    if (!now) { log('[grow] friend unreachable; will retry'); continue; }
    const names = now.map((f) => f.filename).filter(isAgentFile);
    if (names.some((f) => !snapshot.includes(f))) {
      const r = await growOnce({ ...cfg, learn: undefined, snapshot });
      cfg.onCycle?.(r);
      snapshot = r.snapshot;
    }
    if (cfg.maxCycles && ++cycles >= cfg.maxCycles) return;
  }
}
