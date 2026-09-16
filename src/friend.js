// @ts-check
/**
 * Phone a friend: an agent flow (WorkflowTool) that lets a Copilot Studio body call a brainstem
 * that CAN execute python and learn (the grail, the lab, a Tier 2 Azure Function, anything that
 * speaks the RAPP wire on a public URL). Copilot Studio cannot run agent.py or write new agents;
 * the friend can, so every agent routes there and new capabilities are learned there.
 *
 * The flow is connectionless (a plain HTTP action, the same shape copilot-harness-sdk proves with
 * its Open-Meteo weather flow), so no custom connector and no maker-portal connection is needed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessSdk } from './sdk.js';

export const FRIEND_TOOL = 'Phone a friend';
export const FRIEND_FOLDER = 'RAPPPhoneAFriend';

/**
 * @param {{ url: string, name?: string }} friend  public RAPP-wire URL (POST <url>/chat)
 * @param {string} schemaName
 * @param {string} workspace  workspace root
 */
export async function buildFriend(friend, schemaName, workspace) {
  const { workflowIdFor } = await loadHarnessSdk();
  const id = workflowIdFor(schemaName, FRIEND_FOLDER);
  const base = friend.url.replace(/\/+$/, '');
  const folder = `${FRIEND_FOLDER}-${id}`;
  const wfDir = join(workspace, 'workflows', folder);
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(join(workspace, 'capabilities', 'tools'), { recursive: true });

  const outputSchema = { type: 'object', properties: { status: { type: 'string' }, response: { type: 'string' }, agent_logs: { type: 'string' }, session_id: { type: 'string' }, model: { type: 'string' } } };
  const definition = {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    parameters: { $authentication: { defaultValue: {}, type: 'SecureObject' } },
    triggers: {
      manual: {
        type: 'Request', kind: 'Skills',
        inputs: { schema: { type: 'object', properties: {
          user_input: { title: 'user_input', type: 'string', description: 'The request to send to the friend brainstem, in the user\'s own words.', 'x-ms-dynamically-added': true },
          session_id: { title: 'session_id', type: 'string', description: 'Conversation id to keep the friend\'s memory of this chat. Reuse it across turns.', 'x-ms-dynamically-added': true }
        }, required: ['user_input'] } }
      }
    },
    actions: {
      Phone_friend: {
        type: 'Http',
        inputs: {
          method: 'POST', uri: `${base}/chat`,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'RAPP-Stemcell-PhoneAFriend/1.0' },
          body: { user_input: "@triggerBody()?['user_input']", session_id: "@coalesce(triggerBody()?['session_id'], 'copilot-studio')", user_guid: 'copilot-studio' }
        }
      },
      Respond: {
        runAfter: { Phone_friend: ['Succeeded'] },
        type: 'Response', kind: 'Skills',
        inputs: { statusCode: 200, body: {
          status: 'success', response: "@body('Phone_friend')?['response']", agent_logs: "@body('Phone_friend')?['agent_logs']",
          session_id: "@body('Phone_friend')?['session_id']", model: "@body('Phone_friend')?['model']"
        }, schema: outputSchema }
      },
      Respond_error: {
        runAfter: { Phone_friend: ['Failed', 'TimedOut'] },
        type: 'Response', kind: 'Skills',
        inputs: { statusCode: 200, body: { status: 'error', response: `The friend brainstem at ${base} did not answer.`, agent_logs: '', session_id: "@triggerBody()?['session_id']", model: '' }, schema: outputSchema }
      }
    }
  };
  writeFileSync(join(wfDir, 'workflow.json'), JSON.stringify({ properties: { connectionReferences: {}, definition, templateName: null }, schemaVersion: '1.0.0.0' }, null, 2));
  writeFileSync(join(wfDir, 'metadata.yml'), [
    `jsonFileName: workflows/${folder}/workflow.json`, `workflowId: ${id}`, `name: ${friend.name || 'RAPP Phone a Friend Workflow'}`, 'type: 1',
    `description: Sends a request to the friend brainstem at ${base} (RAPP wire) and returns its answer.`, 'subprocess: false', 'category: 5', 'mode: 0', 'scope: 4',
    'onDemand: false', 'triggerOnCreate: false', 'triggerOnDelete: false', 'asyncAutodelete: false', 'syncWorkflowLogOnFailure: false', 'stateCode: 1', 'statusCode: 2', 'runAs: 1', 'isTransacted: true', 'introducedVersion: 1.0',
    'isCustomizable:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: iscustomizableanddeletable', 'businessProcessType: 0',
    'isCustomProcessingStepAllowedForOtherPublishers:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: canbedeleted',
    'modernFlowType: 0', 'primaryEntity: none', 'connectionReferences: []', ''
  ].join('\n'));
  writeFileSync(join(workspace, 'capabilities', 'tools', 'PhoneAFriend.mcs.yml'), [
    'mcs.metadata:', `  componentName: ${JSON.stringify(FRIEND_TOOL)}`,
    `  description: ${JSON.stringify('Sends a request to the friend brainstem, which runs every RAPP agent for real (Hacker News, memory, and any agent learned later) and can LEARN a new agent from a description. Use it for anything that needs a live tool, live data, memory, or a capability you do not have yet.')}`,
    'kind: WorkflowTool', `workflowId: ${id}`,
    'toolInputs:', '  - name: user_input', '    displayName: user_input', `    description: ${JSON.stringify("The request for the friend, in the user's own words (or 'Use LearnNew to create a new agent that ...').")}`,
    '  - name: session_id', '    displayName: session_id', `    description: ${JSON.stringify('Conversation id; reuse the same value across turns.')}`,
    'toolOutputs:', '  - name: status', '  - name: response', '  - name: agent_logs', '  - name: session_id', '  - name: model', ''
  ].join('\n'));
  return { id, folder, tool: FRIEND_TOOL, url: base };
}

/** Instruction lines for a body that has a friend. */
export function friendInstructions(friend, agents) {
  const base = friend.url.replace(/\/+$/, '');
  return [
    `You have a friend: a full RAPP brainstem at ${base} reachable through the "${FRIEND_TOOL}" tool. It runs python agents for real and can learn new ones. You cannot run python or create agents yourself, so:`,
    ...agents.map((a) => `- ${a.description.replace(/\s+/g, ' ').slice(0, 220)}: phone a friend with the user's exact request; it runs the ${a.name} agent for real. Relay its response faithfully.`),
    `- If the user asks for something none of your skills or agents can do, phone a friend with: "Use LearnNew to create a new agent that <what is needed>", then phone a friend again with the user's original request so the new agent answers it. Tell the user the brainstem learned a new capability; it becomes a first-class skill of yours on the next growth cycle.`,
    `- Reuse one session_id for the whole conversation so the friend keeps its memory.`,
    `- Never say a friend call did something it did not; if status is "error", say the friend was unreachable.`
  ];
}
