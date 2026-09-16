// @ts-check
/**
 * The genome: what makes a brainstem *this* brainstem, independent of the body it runs in.
 *
 *   <genome>/soul.md                 the persona (system prompt)
 *   <genome>/agents/*_agent.py       RAPP agents (BasicAgent subclasses with an OpenAI function schema)
 *   <genome>/agents/<any depth>/SKILL.md   Agent Skills (agentskills.io), experimental/ skipped
 *   <genome>/.claude/skills/<name>/SKILL.md
 *
 * The grail installs its genome at ~/.brainstem/src/rapp_brainstem; that is the default.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENT_RUNNER = join(HERE, '..', 'python', 'agent_runner.py');

/** Where a genome lives when nobody says: env, the grail install, or the working directory. */
export function defaultGenomeDir() {
  const fromEnv = process.env.BRAINSTEM_GENOME;
  if (fromEnv) return resolve(fromEnv);
  const grail = join(homedir(), '.brainstem', 'src', 'rapp_brainstem');
  if (existsSync(join(grail, 'soul.md'))) return grail;
  return process.cwd();
}

/** First python on PATH that runs, or null. */
export function findPython() {
  const fromEnv = process.env.BRAINSTEM_PYTHON;
  const candidates = fromEnv ? [[fromEnv, []]] : [['python3', []], ['python', []], ['py', ['-3']]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return { cmd, pre };
  }
  return null;
}

/**
 * Run the agent runner once and parse its single JSON line.
 * @param {{cmd:string, pre:string[]}} python
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number}} [opts]
 */
export function runPython(python, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(python.cmd, [...python.pre, AGENT_RUNNER, ...args], {
      cwd: opts.cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += `\n[agent_runner] killed after ${opts.timeoutMs || 120000} ms`; }, opts.timeoutMs || 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      let parsed;
      try { parsed = JSON.parse(line); } catch { parsed = { error: `agent runner produced no JSON: ${(err || out).trim().slice(-400)}` }; }
      resolvePromise({ ...parsed, stderr: err.trim() });
    });
  });
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}

function walkSkills(root, out, depth = 0) {
  if (!existsSync(root) || depth > 6) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'experimental' || entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const dir = join(root, entry.name);
    const file = join(dir, 'SKILL.md');
    if (existsSync(file)) {
      const fm = parseFrontmatter(readFileSync(file, 'utf8'));
      out.push({ name: fm.name || entry.name, description: fm.description || '', dir, file, parent: root });
    } else {
      walkSkills(dir, out, depth + 1);
    }
  }
}

/**
 * Read a genome. Agent contracts come from python (the agent's own metadata); without python
 * they are read statically (name + description only) and `problems` says so.
 * @param {string} [dir]
 * @param {{python?: {cmd:string, pre:string[]}|null, contracts?: boolean}} [opts]
 */
export async function readGenome(dir = defaultGenomeDir(), opts = {}) {
  const genome = resolve(dir);
  const problems = [];
  const soulPath = process.env.SOUL_PATH ? resolve(genome, process.env.SOUL_PATH) : join(genome, 'soul.md');
  const soul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';
  if (!soul) problems.push(`no soul.md in ${genome}`);

  const agentsDir = process.env.AGENTS_PATH ? resolve(genome, process.env.AGENTS_PATH) : join(genome, 'agents');
  const agentFiles = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith('_agent.py') && f !== 'basic_agent.py' && !f.startsWith('__')).sort().map((f) => join(agentsDir, f))
    : [];
  if (!existsSync(agentsDir)) problems.push(`no agents/ in ${genome}`);

  const python = opts.python === undefined ? findPython() : opts.python;
  const agents = [];
  if (opts.contracts !== false) {
    await Promise.all(agentFiles.map(async (file) => {
      let c;
      if (python) {
        c = await runPython(python, ['contract', file], { cwd: genome, timeoutMs: 60000 });
        if (c.error) { problems.push(`${basename(file)}: ${c.error}`); return; }
      } else {
        const src = readFileSync(file, 'utf8');
        c = {
          name: (src.match(/self\.name\s*=\s*["']([^"']+)/) || [])[1] || basename(file, '.py'),
          description: (src.match(/["']description["']\s*:\s*\(?\s*["']([^"']+)/) || [])[1] || '',
          parameters: { type: 'object', properties: {} },
          note: 'no python on PATH: parameters unknown'
        };
      }
      agents.push({ name: c.name, description: c.description, parameters: c.parameters, class: c.class, file });
    }));
    agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @type {any[]} */
  const skills = [];
  walkSkills(agentsDir, skills);
  walkSkills(join(genome, '.claude', 'skills'), skills);
  for (const extra of (process.env.SKILLS_PATH || '').split(':').filter(Boolean)) walkSkills(resolve(genome, extra), skills);
  const seen = new Set();
  const uniqueSkills = skills.filter((s) => (seen.has(s.name) ? false : seen.add(s.name)));
  const skillDirectories = [...new Set(uniqueSkills.map((s) => s.parent))];

  return { dir: genome, soulPath, soul, agentsDir, agents, skills: uniqueSkills, skillDirectories, python, problems };
}

/** One paragraph the body can hand the model so it knows what this brainstem can do. */
export function describeGenome(genome) {
  const lines = [];
  if (genome.agents.length) lines.push('Agents (call them as tools): ' + genome.agents.map((a) => `${a.name}: ${a.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('; '));
  if (genome.skills.length) lines.push('Skills (follow them exactly when they apply): ' + genome.skills.map((s) => `${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('; '));
  return lines.join('\n');
}

export function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
