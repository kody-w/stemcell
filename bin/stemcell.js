#!/usr/bin/env node
// @ts-check
/**
 * stemcell — the RAPP brainstem, wherever you need it.
 *
 *   stemcell chat  <body> "prompt" [--session id] [--guid g]     one turn, RAPP wire in and out
 *   stemcell serve <body> [--port 7099] [--host 127.0.0.1]        the RAPP wire + the grail's chat page over that body
 *   stemcell caps  <body>                                          what this body can do
 *   stemcell health <body>
 *   stemcell genome [dir]                                          what the genome on disk contains
 *   stemcell prove <body> [<body> ...] --turns proofs/turns.json [--out proofs/<file>.json]
 *   stemcell studio build  --name "..." --schema rapp_X [--genome dir] [--self-grow] [--friend https://public.friend/] [--work-dir .stemcell/rapp_X]
 *   stemcell studio deploy --name "..." --schema rapp_X --environment https://org.crm.dynamics.com/ [--publisher-prefix rapp] [--self-grow] [--friend url] [--token-command "..."]
 *   stemcell harvest --schema rapp_X --environment <url> [--genome dir] [--dry-run]     skills the Studio body grew on its own → <genome>/agents/<name>/SKILL.md
 *   stemcell grow --friend http://localhost:7071 [--friend-public https://...] --name "..." --schema rapp_X --environment <url> [--learn "what the new agent should do"] [--watch --every 30] [--genome dir]
 *
 * Bodies: http://host:port | sdk | sdk:<genome> | headless:<host:port>[:<genome>] | studio:<envId>/<schema> | directline:<envId>/<schema>
 * Options: --model auto|<id>  --execute off|all  --timeout-ms N  --genome <dir> (sdk/headless)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeshift, parseSpec, BODIES } from '../src/brainstem.js';
import { serve } from '../src/serve.js';
import { prove, summarize } from '../src/prove.js';
import { readGenome, defaultGenomeDir } from '../src/genome.js';
import { buildStudioWorkspace, deployStudio } from '../src/studio-workspace.js';
import { growOnce, growWatch } from '../src/grow.js';
import { harvest } from '../src/harvest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    const boolean = ['json', 'stream', 'watch', 'once', 'dry-run', 'force', 'self-grow'].includes(a.slice(2));
    if (!boolean && next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = 'true';
  } else positional.push(a);
}
const [command, ...rest] = positional;
const usage = () => { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n')); process.exit(2); };
const opts = { model: flags.model, execute: flags.execute, turnTimeoutMs: flags['timeout-ms'] ? Number(flags['timeout-ms']) : undefined };
const withGenome = (spec) => { const p = parseSpec(spec); if ((p.body === 'sdk' || p.body === 'headless') && flags.genome && !p.genome) p.genome = flags.genome; return p; };

try {
  switch (command) {
    case 'chat': {
      const [body, ...words] = rest;
      if (!body || !words.length) usage();
      const b = await shapeshift(withGenome(body), opts);
      const payload = { user_input: words.join(' '), session_id: flags.session || `cli-${Date.now()}`, ...(flags.guid ? { user_guid: flags.guid } : {}) };
      if (flags.stream === 'true') {
        for await (const f of b.stream(payload)) {
          if (f.type === 'delta') process.stdout.write(f.text);
          else if (f.type === 'agent') process.stderr.write(`\n${f.logs}\n`);
          else if (f.type === 'error') { process.stderr.write(`\nerror: ${f.error}\n`); process.exitCode = 1; }
          else if (f.type === 'done') process.stdout.write(`\n`);
        }
      } else {
        const out = await b.chat(payload);
        console.log(flags.json === 'true' ? JSON.stringify(out, null, 2) : out.response);
        if (out.agent_logs && flags.json !== 'true') console.error(out.agent_logs);
      }
      await b.close();
      break;
    }
    case 'serve': {
      const [body] = rest;
      if (!body) usage();
      const b = await shapeshift(withGenome(body), opts);
      const s = await serve(b, { port: flags.port ? Number(flags.port) : 7099, host: flags.host });
      console.log(`stemcell: ${b.label} is serving the RAPP wire at ${s.url}  (POST /chat, POST /chat/stream, GET /health, GET / for the chat page)`);
      const stop = async () => { await s.close(); await b.close(); process.exit(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      break;
    }
    case 'caps':
    case 'health': {
      const [body] = rest;
      if (!body) usage();
      const b = await shapeshift(withGenome(body), opts);
      console.log(JSON.stringify(command === 'caps' ? b.capabilities() : await b.health(), null, 2));
      await b.close();
      break;
    }
    case 'genome': {
      const g = await readGenome(rest[0] || flags.genome || defaultGenomeDir());
      console.log(JSON.stringify({ dir: g.dir, soul: g.soul ? `${g.soul.length} chars` : 'missing', python: g.python ? g.python.cmd : null,
        agents: g.agents.map((a) => ({ name: a.name, file: a.file.split('/').pop(), params: Object.keys(a.parameters?.properties || {}) })),
        skills: g.skills.map((s) => ({ name: s.name, dir: s.dir })), skillDirectories: g.skillDirectories, problems: g.problems }, null, 2));
      break;
    }
    case 'prove': {
      if (!rest.length) usage();
      const turns = JSON.parse(readFileSync(flags.turns || join(HERE, '..', 'proofs', 'turns.json'), 'utf8'));
      const proof = await prove(rest.map(withGenome), turns, { opts });
      console.log('\n' + summarize(proof));
      if (flags.out) { mkdirSync(dirname(flags.out), { recursive: true }); writeFileSync(flags.out, JSON.stringify(proof, null, 2)); console.log(`→ ${flags.out}`); }
      process.exitCode = proof.ok ? 0 : 1;
      break;
    }
    case 'studio': {
      const [action] = rest;
      if (!['build', 'deploy'].includes(action) || !flags.name || !flags.schema) usage();
      const genome = await readGenome(flags.genome || defaultGenomeDir());
      const workDir = flags['work-dir'] || join(process.cwd(), '.stemcell', flags.schema);
      mkdirSync(workDir, { recursive: true });
      const built = await buildStudioWorkspace(genome, { name: flags.name, schemaName: flags.schema, model: flags.model, bridgeUrl: flags.bridge, bridgeRef: flags['bridge-ref'], bridgeName: flags['bridge-name'], friend: flags.friend ? { url: flags.friend } : undefined, selfGrow: flags['self-grow'] === 'true', workDir, purpose: flags.purpose });
      console.log(`built ${built.workspace}: ${built.components.length} components (${built.components.map((c) => c.kind + ':' + c.name).join(', ')})`);
      if (action === 'deploy') {
        if (!flags.environment) usage();
        const r = await deployStudio({ name: flags.name, schemaName: flags.schema, publisherPrefix: flags['publisher-prefix'] || 'rapp', environment: flags.environment, workspace: built.workspace, workDir, model: flags.model, tokenCommand: flags['token-command'] });
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.ok ? 0 : 1;
      }
      break;
    }
    case 'grow': {
      if (!flags.friend || !flags.name || !flags.schema || !flags.environment) usage();
      const studio = { name: flags.name, schema: flags.schema, environment: flags.environment, publisherPrefix: flags['publisher-prefix'], model: flags.model, tokenCommand: flags['token-command'], purpose: flags.purpose, selfGrow: flags['self-grow'] === 'true' };
      const common = { friendUrl: flags.friend, friendPublicUrl: flags['friend-public'], genomeDir: flags.genome || defaultGenomeDir(), studio, workDir: flags['work-dir'], deploy: flags['dry-run'] !== 'true' };
      if (flags.watch === 'true') {
        await growWatch({ ...common, everyMs: Number(flags.every || 30) * 1000, onCycle: (r) => console.log(JSON.stringify({ learned: r.learned, pulled: r.pulled, deployed: r.deployed && { ok: r.deployed.ok, botId: r.deployed.botId } })) });
      } else {
        const r = await growOnce({ ...common, learn: flags.learn, force: flags.force === 'true' });
        console.log(JSON.stringify({ learned: r.learned, pulled: r.pulled, deployed: r.deployed && { ok: r.deployed.ok, botId: r.deployed.botId, preview: r.deployed.preview, log: r.deployed.log } }, null, 2));
        process.exitCode = r.deployed && !r.deployed.ok ? 1 : 0;
      }
      break;
    }
    case 'harvest': {
      if (!flags.schema || !flags.environment) usage();
      const r = await harvest({ environmentUrl: flags.environment, schemaName: flags.schema, genomeDir: flags.genome, tokenCommand: flags['token-command'], dryRun: flags['dry-run'] === 'true' });
      console.log(JSON.stringify({ bot: r.bot, genome: r.genomeDir, harvested: r.harvested.map((h) => h.name), skipped: r.skipped }, null, 2));
      break;
    }
    case 'bodies':
      console.log(BODIES.join('\n'));
      break;
    default:
      usage();
  }
} catch (e) {
  console.error(`stemcell: ${e.message}`);
  process.exit(1);
}
