// @ts-check
/**
 * Project a genome onto Copilot Studio: build a pac harness workspace and deploy it through
 * copilot-harness-sdk's deploy-harness-agent.mjs (harness only, never classic).
 *
 *   soul.md         → settings.mcs.yml agentSettings.instructions (plus a capability list)
 *   SKILL.md        → behaviors/<name>.mcs.yml InlineAgentSkill, the file verbatim
 *   agent.py        → without a bridge: a reasoning skill carrying the contract and the code;
 *                     with --bridge <public MCP url>: ONE McpTool on the live brainstem, so every agent
 *                     runs for real where the genome lives and nothing is ported (the "Brainstem Bridge").
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { buildFriend, friendInstructions } from './friend.js';
import { buildSelfGrowth, selfGrowthInstructions, FETCH_TOOL } from './grow-native.js';

const yamlStr = (s) => JSON.stringify(String(s));
const indent = (text, n) => String(text).split('\n').map((l) => (l ? ' '.repeat(n) + l : '')).join('\n');
const kebab = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'capability');

/**
 * A Copilot Studio body has no machine: no files, no shell, no python, no local server,
 * no install tiers to sell. A genome soul written for the local brainstem asserts all of it,
 * and the agent then answers with paths that do not exist here. Drop those claims at the seam.
 */
const LOCAL_CLAIM = [
  [/hippocampus|nervous system|spinal cord|\btiers?\b|core reflexes/i, 'install tiers'],
  [/\bAzure\b|CommunityRAPP|one-?liner|curl -fsSL|\birm https?:|install\.(sh|ps1|cmd)\b|onboard(ing)? guide|after install/i, 'install instructions'],
  [/own machine|their hardware|running locally|runs locally|local-first|your machine|local machine|someone else's cloud|on their own/i, 'a local machine'],
  [/~\/|\/Users\/|\/home\/|[A-Z]:\\/, 'local file paths'],
  [/localhost|127\.0\.0\.1|\/health\b|restart(ing)?\b|start\.sh|\bvenv\b|index\.html/i, 'a local server'],
  [/drag(ging)?\b|VS Code|Brain Surgeon|export the (Brainstem )?transcript|chat window|toolbar/i, 'a desktop app'],
  [/GitHub (account|token|Copilot)|device-?code|API keys?/i, 'local sign-in'],
  [/agent\.py|hot-?load|quarantin|experimental directory|agent registry|file\/class\/method/i, 'the local agent loader'],
  [/\bpython3?\b|\bbash\b|\bshell\b|\bnpm\b|\bpip install|\bgit \b|scripts?\/|\.\/[a-z]/i, 'a shell']
];

/** @param {string} text @returns {string|null} the reason this text claims a host, or null */
export function localClaim(text) {
  for (const [re, reason] of LOCAL_CLAIM) if (re.test(text)) return reason;
  return null;
}

/** A bullet or paragraph with the indented lines that belong to it: half a thought is never kept. */
function blocks(lines) {
  const out = [];
  for (const line of lines) {
    const continuation = /^(\s+\S|\s*\d+[.)]\s|```)/.test(line) || (out.length && /^\s*$/.test(line) === false && /^(?![-*#\s])/.test(line) && out.at(-1).open);
    if (out.length && (continuation || /^\s*$/.test(line))) out.at(-1).lines.push(line);
    else out.push({ lines: [line], open: /:\s*$/.test(line) });
    if (out.length && !/^\s*$/.test(line)) out.at(-1).open = /:\s*$/.test(line) || out.at(-1).open;
  }
  return out;
}

/**
 * Keep the soul's voice; drop every block and section that asserts a machine this body does not have.
 * Whole blocks, so a lead-in never survives its own bullets.
 * @param {string} soul
 */
export function sanitizeSoulForStudio(soul) {
  const dropped = new Set();
  const lines = String(soul).split('\n').filter((l) => !/^#(?!#)/.test(l));   // the file's own header comments
  /** @type {{heading: string|null, body: string[]}[]} */
  const sections = [{ heading: null, body: [] }];
  for (const line of lines) {
    if (/^##\s/.test(line)) sections.push({ heading: line, body: [] });
    else sections.at(-1).body.push(line);
  }
  const kept = [];
  for (const section of sections) {
    const why = section.heading && localClaim(section.heading);
    if (why) { dropped.add(why); continue; }
    const body = [];
    for (const b of blocks(section.body)) {
      const text = b.lines.join('\n');
      const w = localClaim(text);
      if (w) { dropped.add(w); continue; }
      body.push(text);
    }
    const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) { if (section.heading) dropped.add('an empty section'); continue; }
    kept.push([section.heading, text].filter(Boolean).join('\n\n'));
  }
  return { text: kept.join('\n\n').trim(), dropped: [...dropped] };
}

/** Can this capability run in Copilot Studio at all? @param {string} md */
export function portableToStudio(md) {
  const why = localClaim(md);
  return why ? { ok: false, why } : { ok: true };
}

/** What the body actually is, stated plainly, so it never offers what it does not have. */
function environmentBlock(cfg, growBuilt, friendBuilt) {
  const lines = [
    'Where you are:',
    `- You are a Copilot Studio agent. You have no computer of your own: no files, no folders, no shell, no python, no local server, and no way to read anything on the user's machine. Never name a local path, never offer to install anything, and never describe yourself as running locally.`,
    `- Your reach outside this conversation is exactly the tools listed below${growBuilt ? `, and the only way to see live data is the "${FETCH_TOOL}" tool` : ''}.`
  ];
  if (growBuilt) lines.push(`- You are a seed, not a finished assistant: when a request needs a capability you do not have, grow it and use it in the same turn. That is the point of you.`);
  if (friendBuilt) lines.push(`- Work that truly needs a machine belongs to your friend brainstem; anything else you do here yourself.`);
  else lines.push(`- If a request genuinely needs someone's machine, say plainly that you cannot reach one, and offer what you can do here instead.`);
  return lines;
}


/**
 * @param {any} genome
 * @param {{ name: string, schemaName: string, model?: string, bridgeUrl?: string, bridgeRef?: string, bridgeName?: string, friend?: { url: string, name?: string }, selfGrow?: boolean, growConnectionReference?: string, flowGeneration?: number, workDir: string, purpose?: string }} cfg
 */
export async function buildStudioWorkspace(genome, cfg) {
  const ws = join(cfg.workDir, 'workspace');
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ws, 'behaviors'), { recursive: true });
  const routing = [];
  const skipped = [];
  // A capability that needs a host is worse than a missing one: the agent tries it and answers with a path.
  const skills = genome.skills.filter((sk) => {
    const fit = portableToStudio(readFileSync(sk.file, 'utf8'));
    if (!fit.ok) skipped.push({ name: sk.name, kind: 'skill', why: fit.why });
    return fit.ok;
  });
  for (const sk of skills) routing.push(`- ${sk.description.replace(/\s+/g, ' ').slice(0, 300) || sk.name}: use the ${kebab(sk.name)} skill and follow it exactly.`);
  let friendBuilt = null;
  let growBuilt = null;
  if (cfg.selfGrow) {
    growBuilt = await buildSelfGrowth(cfg.schemaName, ws, { connectionReference: cfg.growConnectionReference, generation: cfg.flowGeneration });
    routing.push(...selfGrowthInstructions(!!cfg.friend));
  }
  if (cfg.friend) {
    friendBuilt = await buildFriend(cfg.friend, cfg.schemaName, ws);
    routing.push(...friendInstructions(cfg.friend, genome.agents));
  } else if (cfg.bridgeUrl) {
    for (const a of genome.agents) routing.push(`- ${a.description.replace(/\s+/g, ' ').slice(0, 300)}: call the brainstem tool \`chat\` on the ${cfg.bridgeName || 'RAPP Brainstem'} MCP server with the user's request; it runs the ${a.name} agent for real and answers.`);
  } else {
    // Nothing here runs python, so an agent card would only teach this body to describe code it cannot execute.
    for (const a of genome.agents) skipped.push({ name: a.name, kind: 'agent', why: 'python, with no friend or bridge to run it' });
  }
  const soul = sanitizeSoulForStudio(genome.soul);
  const instructions = [
    `You are ${cfg.name}.`,
    '',
    cfg.purpose || `You are a RAPP brainstem in Copilot Studio: the persona of the brainstem this was shaped from, with the capabilities that work here.`,
    '',
    soul.text,
    '',
    ...environmentBlock(cfg, growBuilt, friendBuilt),
    '',
    'Capabilities and routing:',
    ...routing,
    '',
    'Rules:',
    '- Follow a skill exactly once you decide to use it; say which skill you used.',
    '- Never claim an action you did not take or invent data a tool did not return.',
    '- Ask for a missing required input before doing anything else.',
    '- Be concise: answer in under 150 words unless the user asks for a full report.'
  ].join('\n');
  const greeting = `Hi, I am ${cfg.name}. ${(cfg.purpose || 'A RAPP brainstem, shaped for Copilot Studio.').slice(0, 160)}`;

  writeFileSync(join(ws, 'settings.mcs.yml'), [
    `displayName: ${yamlStr(cfg.name)}`,
    `schemaName: ${yamlStr(cfg.schemaName)}`,
    'accessControlPolicy: GroupMembership',
    'authenticationMode: Integrated',
    'authenticationTrigger: Always',
    'configuration:',
    '  authoringModel: CliCopilot',
    '  recognizer:',
    '    kind: CLICopilotRecognizer',
    '  agentSettings:',
    '    model:',
    `      series: ${cfg.model || 'Sonnet46'}`,
    '    instructions:',
    '      segments:',
    '        - kind: StaticSegment',
    '          value: |-',
    indent(instructions, 12),
    `    greetingText: ${yamlStr(greeting)}`,
    'template: cliagent-1.0.0',
    'language: 1033',
    ''
  ].join('\n'));
  writeFileSync(join(ws, 'agent.sync.yaml'), '# Workspace layout marker (Sync overlay; generic YAML, never MCS-parsed).\nlayoutVersion: 1\n');

  const components = [];
  const behavior = (name, description, body) => {
    const file = join(ws, 'behaviors', `${name}.mcs.yml`);
    writeFileSync(file, `mcs.metadata:\n  componentName: ${yamlStr(name)}\n  description: ${yamlStr(description.slice(0, 300))}\nkind: InlineAgentSkill\ncontent: |\n${indent(body, 2)}\n`);
    components.push({ name, kind: 'InlineAgentSkill', file });
  };
  for (const sk of skills) behavior(kebab(sk.name), sk.description || sk.name, readFileSync(sk.file, 'utf8'));
  if (growBuilt) for (const t of growBuilt.tools) components.push({ name: t.tool, kind: 'WorkflowTool', workflowId: t.id, connectionReference: growBuilt.connectionReference });
  if (friendBuilt) {
    components.push({ name: friendBuilt.tool, kind: 'WorkflowTool', workflowId: friendBuilt.id, friend: friendBuilt.url });
    // One capability card per agent so growth is visible in the component list; execution is the friend's.
    for (const a of genome.agents) {
      behavior(kebab(a.name), a.description || a.name, [
        '---', `name: ${kebab(a.name)}`, `description: ${JSON.stringify((a.description || '').replace(/\s+/g, ' ').slice(0, 300))}`, '---',
        `# ${a.name}`, '', '## When to use this skill', a.description || '', '',
        '## How to run it', `Call the "${friendBuilt.tool}" tool with the user's exact request as user_input (reuse the conversation's session_id). The friend brainstem runs the ${a.name} agent for real; relay its response.`, '',
        '## Input contract (what the agent accepts)', '```json', JSON.stringify(a.parameters || { type: 'object', properties: {} }), '```'
      ].join('\n'));
    }
  } else if (cfg.bridgeUrl) {
    // The Brainstem Bridge: one McpTool on a custom connector that wraps the live brainstem's MCP endpoint
    // (the same McpTool + connection-reference shape copilot-harness-sdk proves in its use cases).
    mkdirSync(join(ws, 'capabilities', 'tools'), { recursive: true });
    mkdirSync(join(ws, 'infrastructure', 'connections'), { recursive: true });
    const name = (cfg.bridgeName || 'RAPPBrainstem').replace(/[^A-Za-z0-9]/g, '');
    const ref = cfg.bridgeRef || `${cfg.schemaName}.cr.brainstem`;
    writeFileSync(join(ws, 'capabilities', 'tools', `${name}.mcs.yml`), [
      'mcs.metadata:', `  componentName: ${yamlStr(name)}`,
      `  description: ${yamlStr('The live RAPP brainstem over MCP: chat(user_input, session_id?, user_guid?) runs its agents and skills for real and answers; capabilities() lists them.')}`,
      'kind: McpTool', 'authMode: Maker', `connectionReference: ${ref}`, `connectorId: ${cfg.bridgeUrl}`, 'operationId: InvokeMCP', ''
    ].join('\n'));
    writeFileSync(join(ws, 'infrastructure', 'connections', `${ref}.sync.yaml`), `connectionReferences:\n  - connectionReferenceLogicalName: ${ref}\n    connectorId: ${cfg.bridgeUrl}\n`);
    components.push({ name, kind: 'McpTool', connectorId: cfg.bridgeUrl, connectionReference: ref });
  }
  writeFileSync(join(cfg.workDir, 'BUILD.json'), JSON.stringify({
    name: cfg.name, schema: cfg.schemaName, builtAt: new Date().toISOString(), genome: genome.dir, model: cfg.model || 'Sonnet46',
    bridge: cfg.bridgeUrl || null, friend: friendBuilt ? friendBuilt.url : null, selfGrow: !!growBuilt, skills: skills.map((sk) => sk.name),
    agents: friendBuilt || cfg.bridgeUrl ? genome.agents.map((a) => a.name) : [], skipped, soulDropped: soul.dropped, components
  }, null, 2));
  return { workspace: ws, components, instructions, skipped, soulDropped: soul.dropped };
}

/** Where copilot-harness-sdk's deploy script is (checkout or npx). */
export function deployCommand() {
  const sdk = process.env.COPILOT_HARNESS_SDK || [join(homedir(), 'Documents', 'GitHub', 'copilot-harness-sdk'), join(homedir(), 'Documents', 'GitHub', 'scratch', 'copilot-harness-sdk')].find((d) => existsSync(join(d, 'scripts', 'deploy-harness-agent.mjs')));
  if (sdk && existsSync(join(sdk, 'scripts', 'deploy-harness-agent.mjs'))) return { cmd: 'node', args: [join(sdk, 'scripts', 'deploy-harness-agent.mjs')] };
  return { cmd: 'npx', args: ['-y', '-p', 'copilot-harness-sdk', 'copilot-harness-deploy'] };
}

/**
 * @param {{ name: string, schemaName: string, publisherPrefix: string, environment: string, workspace: string, workDir: string, model?: string, tokenCommand?: string, log?: (l: string) => void }} cfg
 */
export function deployStudio(cfg) {
  const { cmd, args } = deployCommand();
  const full = [...args, '--name', cfg.name, '--publisher-prefix', cfg.publisherPrefix, '--schema-name', cfg.schemaName,
    '--workspace-dir', cfg.workspace, '--environment', cfg.environment, '--work-dir', join(cfg.workDir, 'deploy'),
    '--keep-extra-components',   // never delete what the body grew on its own
    ...(cfg.model ? ['--model', cfg.model] : []), ...(cfg.tokenCommand ? ['--token-command', cfg.tokenCommand] : [])];
  const log = cfg.log || ((l) => process.stderr.write(l));
  return new Promise((resolve) => {
    const child = spawn(cmd, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; log(String(d)); });
    child.stderr.on('data', (d) => { out += d; log(String(d)); });
    child.on('close', (code) => {
      const botId = (out.match(/bot(?:Id|\s+id)[^0-9a-f]*([0-9a-f-]{36})/i) || [])[1] || null;
      const preview = (out.match(/https:\/\/copilotstudio\.microsoft\.com\S+/) || [])[0] || null;
      writeFileSync(join(cfg.workDir, 'deploy.log'), out);
      resolve({ ok: code === 0, code, botId, preview, log: join(cfg.workDir, 'deploy.log') });
    });
  });
}

export const workspaceName = (name) => basename(name);
