// @ts-check
/**
 * Body "sdk": the brainstem inside this process (or next to it, on a `copilot --headless` runtime)
 * through @github/copilot-sdk, via copilot-harness-sdk mode "copilot-sdk".
 *
 *   soul.md            → session instructions
 *   agents/*_agent.py  → custom tools (the agent's own JSON schema; perform() runs in python)
 *   SKILL.md dirs      → skillDirectories (the harness loads them natively)
 *
 * No server, no port, no token exchange: the Copilot CLI sign-in (or GITHUB_TOKEN) is the auth.
 */
import { createHarnessBody } from './harness.js';
import { describeGenome, runPython } from '../genome.js';
import { loadHarnessSdk, loadCopilotSdk } from '../sdk.js';

const MEMORY_AGENTS = new Set(['ManageMemory', 'ContextMemory']);

/**
 * @param {{
 *   genome: any, runtimeUri?: string, model?: string, execute?: 'off'|'all',
 *   githubToken?: string, sessionGithubToken?: string, byok?: any, mcpServers?: any, turnTimeoutMs?: number
 * }} cfg
 */
export function createSdkBody(cfg) {
  const genome = cfg.genome;
  const ctx = { user_guid: null };
  const model = cfg.model || process.env.GITHUB_MODEL || 'auto';

  async function buildTools() {
    const { defineTool } = await loadCopilotSdk();
    return genome.agents.map((a) => defineTool(a.name, {
      description: a.description || a.name,
      parameters: a.parameters && a.parameters.type ? a.parameters : { type: 'object', properties: {} },
      skipPermission: true,
      handler: async (args) => {
        const kwargs = { ...(args || {}) };
        // The grail strips user_guid for the memory agents and keys memory by the caller's guid.
        if (MEMORY_AGENTS.has(a.name)) delete kwargs.user_guid;
        const r = await runPython(genome.python, ['perform', a.file, JSON.stringify(kwargs)], {
          cwd: genome.dir, env: ctx.user_guid ? { BRAINSTEM_USER_GUID: String(ctx.user_guid) } : {}
        });
        if (r.error) return `Agent ${a.name} failed: ${r.error}`;
        return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      }
    }));
  }

  const label = cfg.runtimeUri ? `sdk@${cfg.runtimeUri}` : `sdk:${genome.dir}`;
  return createHarnessBody({
    kind: cfg.runtimeUri ? 'headless' : 'sdk',
    label,
    capabilities: () => ({
      body: cfg.runtimeUri ? 'headless' : 'sdk', genome: genome.dir, model,
      agents: genome.agents.map((a) => a.name), skills: genome.skills.map((s) => s.name),
      execute: cfg.execute || 'off', streaming: 'delta', userGuid: true,
      notes: [
        'Agents run as custom tools in python with the grail\'s import shims; memory lands in the genome\'s own .brainstem_data.',
        cfg.runtimeUri ? `Sessions live on the shared runtime at ${cfg.runtimeUri} (mode "empty": skills unavailable there).` : 'The Copilot CLI runtime is spawned by this process.',
        ...(genome.python ? [] : ['No python on PATH: agents cannot execute; contracts were read statically.'])
      ]
    }),
    beforeTurn: (payload) => { ctx.user_guid = payload.user_guid || null; },
    createClient: async () => {
      const { HarnessClient } = await loadHarnessSdk();
      const tools = genome.python ? await buildTools() : [];
      // The soul IS the system message. Runtime mode "empty" keeps the user's own Copilot CLI
      // config (MCP servers, hooks, the coding-agent prompt) out of the brainstem's body.
      const systemMessage = [genome.soul, describeGenome(genome),
        'You are a RAPP brainstem. Answer the user directly and concisely. When an agent tool fits the request, call it and then answer in prose using its result; never end a turn with only a tool call.'
      ].filter(Boolean).join('\n\n');
      const all = cfg.execute === 'all';
      /** @type {any} */
      const copilotSdk = {
        model, tools,
        permissions: all ? 'approve-all' : 'deny',
        session: {
          systemMessage: { mode: 'replace', content: systemMessage },
          ...(all ? {} : { availableTools: ['custom:*', ...(genome.skillDirectories.length ? ['skill'] : [])] })
        },
        ...(genome.skillDirectories.length && !cfg.runtimeUri ? { skillDirectories: genome.skillDirectories } : {}),
        ...(cfg.githubToken ? { githubToken: cfg.githubToken } : {}),
        ...(cfg.sessionGithubToken ? { sessionGithubToken: cfg.sessionGithubToken } : {}),
        ...(cfg.byok ? { byok: cfg.byok } : {}),
        ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
        runtime: { mode: 'empty', ...(cfg.runtimeUri ? { uri: cfg.runtimeUri } : {}) }
      };
      return HarnessClient.create({ mode: 'copilot-sdk', turnTimeoutMs: cfg.turnTimeoutMs || 180000, copilotSdk });
    }
  });
}
