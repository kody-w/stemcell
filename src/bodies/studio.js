// @ts-check
/**
 * Body "studio": the brainstem deployed as a Copilot Studio GitHub Copilot harness agent,
 * reached over the Agentic Runtime /3p route with a delegated Entra user token
 * (copilot-harness-sdk mode "copilot-studio-3p"), or over the no-auth agentic Direct Line
 * endpoint (mode "agentic-directline", final-only answers).
 *
 * The delegated token comes from a public-client Entra app holding CopilotStudio.Copilots.Invoke
 * (ENTRA_CLIENT_ID / ENTRA_TENANT_ID). The MSAL cache file keeps the refresh token so only the
 * first run asks for a device-code sign-in; the default is the lab's file, outside any repo.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHarnessBody } from './harness.js';
import { loadHarnessSdk } from '../sdk.js';

export const DEFAULT_MSAL_CACHE = join(homedir(), '.config', 'rapp-brainstem', 'msal-cache.json');

/**
 * @param {{
 *   environmentId: string, schemaName: string, mode?: 'copilot-studio-3p'|'agentic-directline',
 *   clientId?: string, tenantId?: string, cacheFile?: string, onDeviceCode?: (msg: string) => void,
 *   turnTimeoutMs?: number
 * }} cfg
 */
export function createStudioBody(cfg) {
  const mode = cfg.mode || 'copilot-studio-3p';
  const clientId = cfg.clientId || process.env.ENTRA_CLIENT_ID;
  const tenantId = cfg.tenantId || process.env.ENTRA_TENANT_ID;
  const cacheFile = cfg.cacheFile || process.env.MSAL_CACHE_FILE || DEFAULT_MSAL_CACHE;
  const kind = mode === 'agentic-directline' ? 'directline' : 'studio';

  return createHarnessBody({
    kind,
    label: `${kind}:${cfg.environmentId}/${cfg.schemaName}`,
    capabilities: () => ({
      body: kind, mode, environmentId: cfg.environmentId, schemaName: cfg.schemaName,
      streaming: mode === 'agentic-directline' ? 'final-only' : 'typing', userGuid: false,
      agents: 'whatever the deployed agent carries (skills verbatim; agents via profiles or the bridge)',
      notes: [
        mode === 'copilot-studio-3p'
          ? 'Delegated Entra token (CopilotStudio.Copilots.Invoke); the agent must be published, Authenticate with Microsoft, and shared with the user.'
          : 'No-auth agentic Direct Line: the agent must be published with No Authentication; answers are final-only.',
        'user_guid is not part of this body: memory is whatever the Studio agent was given (Dataverse rows in the pilot).'
      ]
    }),
    createClient: async () => {
      const { HarnessClient, createDeviceCodeTokenProvider } = await loadHarnessSdk();
      /** @type {any} */
      const copilotStudio = { environmentId: cfg.environmentId, schemaName: cfg.schemaName };
      if (mode === 'copilot-studio-3p') {
        if (!clientId || !tenantId) throw new Error('studio body needs ENTRA_CLIENT_ID and ENTRA_TENANT_ID (a public-client app with delegated CopilotStudio.Copilots.Invoke)');
        copilotStudio.getAccessToken = createDeviceCodeTokenProvider({
          clientId, tenantId, cacheFile,
          onDeviceCode: (message) => (cfg.onDeviceCode || ((m) => console.error(`\n${m}\n`)))(String(message))
        });
      }
      return HarnessClient.create({ mode, turnTimeoutMs: cfg.turnTimeoutMs || 180000, copilotStudio });
    }
  });
}
