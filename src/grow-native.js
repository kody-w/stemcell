// @ts-check
/**
 * Self-growth, entirely inside Power Platform: the Copilot Studio body writes new capabilities into
 * its OWN bot record and publishes itself. No friend, no function, no pac, no machine outside the tenant.
 *
 * Three agent flows, all on the environment's Dataverse connection:
 *
 *   Grow a new skill   author a SKILL.md → botcomponents row (InlineAgentSkill) → PvaPublish
 *   Grow a new tool    author an agent-flow definition (Request → Http → Response) + a WorkflowTool
 *                      → workflows row (created, activated) → botcomponents row (WorkflowTool)
 *                      → botcomponent_workflow link → PvaPublish
 *                      This is how the body grows a whole agent for an outside source (a news feed,
 *                      a public JSON API) the way the genome's HackerNews agent works: connectionless
 *                      HTTP, no custom connector, no human-made connection.
 *   Fetch a URL        connectionless HTTP GET so the body can read a public JSON API or a RAR
 *                      agent.py before it authors the flow (its sandbox has no network).
 *
 * Verified 16 Sep 2026: a botcomponents row created over the Web API + PvaPublish made a skill the
 * harness loaded on the next 3p turn; the Grow-skill flow did the same from inside the agent.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessSdk } from './sdk.js';

export const GROW_TOOL = 'Grow a new skill';
export const GROW_AGENT_TOOL = 'Grow a new tool';
export const FETCH_TOOL = 'Fetch a URL';
export const GROW_FOLDER = 'RAPPGrowSkill';
export const GROW_AGENT_FOLDER = 'RAPPGrowAgentTool';
export const FETCH_FOLDER = 'RAPPFetchUrl';
export const DATAVERSE_API = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';

const NL = "decodeUriComponent('%0A')";
const METADATA_TAIL = ['type: 1', 'subprocess: false', 'category: 5', 'mode: 0', 'scope: 4', 'onDemand: false', 'triggerOnCreate: false', 'triggerOnDelete: false', 'asyncAutodelete: false', 'syncWorkflowLogOnFailure: false', 'stateCode: 1', 'statusCode: 2', 'runAs: 1', 'isTransacted: true', 'introducedVersion: 1.0',
  'isCustomizable:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: iscustomizableanddeletable', 'businessProcessType: 0',
  'isCustomProcessingStepAllowedForOtherPublishers:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: canbedeleted',
  'modernFlowType: 0', 'primaryEntity: none', 'connectionReferences: []', ''];   // pac's push rejects a list here; the flow's clientdata carries the reference

const dv = (operationId, parameters) => ({
  type: 'OpenApiConnection',
  inputs: { host: { apiId: DATAVERSE_API, connectionName: 'shared_commondataserviceforapps', operationId }, parameters, authentication: "@parameters('$authentication')" }
});
const skillsTrigger = (properties, required) => ({ manual: { type: 'Request', kind: 'Skills', inputs: { schema: { type: 'object', properties, required } } } });
const prop = (name, description) => ({ title: name, type: 'string', description, 'x-ms-dynamically-added': true });
const respond = (runAfter, body, schema) => ({ runAfter, type: 'Response', kind: 'Skills', inputs: { statusCode: 200, body, schema } });

function writeFlow(workspace, folderBase, id, name, description, definition, connectionRef) {
  const folder = `${folderBase}-${id}`;
  const wfDir = join(workspace, 'workflows', folder);
  mkdirSync(wfDir, { recursive: true });
  const connectionReferences = connectionRef ? { shared_commondataserviceforapps: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: connectionRef }, api: { name: 'shared_commondataserviceforapps' } } } : {};
  writeFileSync(join(wfDir, 'workflow.json'), JSON.stringify({ properties: { connectionReferences, definition, templateName: null }, schemaVersion: '1.0.0.0' }, null, 2));
  writeFileSync(join(wfDir, 'metadata.yml'), [`jsonFileName: workflows/${folder}/workflow.json`, `workflowId: ${id}`, `name: ${name}`, `description: ${description}`, ...METADATA_TAIL].join('\n'));
  return folder;
}

function writeTool(workspace, file, componentName, description, id, inputs, outputs) {
  mkdirSync(join(workspace, 'capabilities', 'tools'), { recursive: true });
  writeFileSync(join(workspace, 'capabilities', 'tools', file), [
    'mcs.metadata:', `  componentName: ${JSON.stringify(componentName)}`, `  description: ${JSON.stringify(description)}`,
    'kind: WorkflowTool', `workflowId: ${id}`,
    'toolInputs:', ...inputs.flatMap(([n, d]) => [`  - name: ${n}`, `    displayName: ${n}`, `    description: ${JSON.stringify(d)}`]),
    'toolOutputs:', ...outputs.map((n) => `  - name: ${n}`), ''
  ].join('\n'));
}

/**
 * @param {string} schemaName
 * @param {string} workspace
 * @param {{ connectionReference?: string, generation?: number }} [opts]  generation > 1 gives every growth flow a fresh id: a solution import never re-activates a flow that was left in draft by a failed earlier activation
 */
export async function buildSelfGrowth(schemaName, workspace, opts = {}) {
  const { workflowIdFor: idFor } = await loadHarnessSdk();
  const gen = Number(opts.generation || 1);
  const workflowIdFor = (schema, folder) => idFor(schema, gen > 1 ? `${folder}G${gen}` : folder);
  const flowName = (base) => (gen > 1 ? `${base} G${gen}` : base);
  const ref = opts.connectionReference || `${schemaName}.cr.shared_commondataserviceforapps`;
  mkdirSync(join(workspace, 'infrastructure', 'connections'), { recursive: true });
  writeFileSync(join(workspace, 'infrastructure', 'connections', `${ref}.sync.yaml`), `connectionReferences:\n  - connectionReferenceLogicalName: ${ref}\n    connectorId: ${DATAVERSE_API}\n`);
  const parameters = { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } };
  const $schema = 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';
  const botLookup = {
    List_bots: { runAfter: { Skill_name: ['Succeeded'] }, ...dv('ListRecords', { entityName: 'bots', $select: 'botid,schemaname', $filter: `schemaname eq '${schemaName}'`, $top: 1 }) },
    Bot_id: { runAfter: { List_bots: ['Succeeded'] }, type: 'Compose', inputs: "@first(body('List_bots')?['value'])?['botid']" },
    Base_url: { runAfter: { Bot_id: ['Succeeded'] }, type: 'Compose', inputs: "@first(split(string(body('List_bots')?['@odata.context']), '$metadata'))" }
  };
  const publish = (after) => ({ runAfter: { [after]: ['Succeeded'] }, ...dv('PerformBoundAction', { entityName: 'bots', actionName: 'Microsoft.Dynamics.CRM.PvaPublish', recordId: "@outputs('Bot_id')" }) });
  const outSchema = { type: 'object', properties: { status: { type: 'string' }, skill: { type: 'string' }, component_id: { type: 'string' }, message: { type: 'string' } } };

  // 1. Grow a new skill
  const skillId = workflowIdFor(schemaName, GROW_FOLDER);
  const skillYaml = `@{concat('kind: InlineAgentSkill', ${NL}, 'content: |', ${NL}, '  ---', ${NL}, '  name: ', outputs('Skill_name'), ${NL}, '  description: "', replace(replace(triggerBody()?['description'], '"', ''''), ${NL}, ' '), '"', ${NL}, '  ---', ${NL}, '  # ', outputs('Skill_name'), ${NL}, ${NL}, '  ', replace(triggerBody()?['instructions'], ${NL}, concat(${NL}, '  ')), ${NL})}`;
  const skillDefinition = {
    $schema, contentVersion: '1.0.0.0', parameters,
    triggers: skillsTrigger({
      name: prop('name', 'Short skill name: lowercase letters, digits and hyphens, e.g. roman-numerals.'),
      description: prop('description', 'One sentence: what the skill does and when to use it.'),
      instructions: prop('instructions', 'The skill body in Markdown: numbered steps you can follow yourself, including any script to run in your sandbox and the exact answer format.')
    }, ['name', 'description', 'instructions']),
    actions: {
      Skill_name: { type: 'Compose', inputs: "@toLower(replace(replace(trim(triggerBody()?['name']), ' ', '-'), '_', '-'))" },
      ...botLookup,
      Skill_yaml: { runAfter: { Base_url: ['Succeeded'] }, type: 'Compose', inputs: skillYaml },
      Existing: { runAfter: { Skill_yaml: ['Succeeded'] }, ...dv('ListRecords', { entityName: 'botcomponents', $select: 'botcomponentid,schemaname', $filter: `_parentbotid_value eq '@{outputs('Bot_id')}' and schemaname eq '${schemaName}.skill.@{outputs('Skill_name')}'`, $top: 1 }) },
      If_new: {
        runAfter: { Existing: ['Succeeded'] }, type: 'If',
        expression: { and: [{ equals: ["@length(coalesce(body('Existing')?['value'], createArray()))", 0] }] },
        actions: {
          Create_skill: dv('CreateRecord', {
            entityName: 'botcomponents', 'item/name': "@outputs('Skill_name')", 'item/schemaname': `@concat('${schemaName}.skill.', outputs('Skill_name'))`,
            'item/componenttype': 9, 'item/description': "@triggerBody()?['description']", 'item/data': "@outputs('Skill_yaml')", 'item/parentbotid@odata.bind': "@concat('bots(', outputs('Bot_id'), ')')"
          }),
          Publish: publish('Create_skill')
        },
        else: { actions: {} }
      },
      Respond: respond({ If_new: ['Succeeded'] }, {
        status: 'success', skill: "@outputs('Skill_name')",
        component_id: "@coalesce(first(body('Existing')?['value'])?['botcomponentid'], body('Create_skill')?['botcomponentid'])",
        message: `@if(greater(length(coalesce(body('Existing')?['value'], createArray())), 0), concat('You already have the skill ', outputs('Skill_name'), '; follow it, do not grow it again.'), concat('Skill ', outputs('Skill_name'), ' is now a component of ${schemaName}; the republish takes about a minute to reach new conversations. Follow it now.'))`
      }, outSchema),
      Respond_error: respond({ If_new: ['Failed', 'TimedOut'] }, { status: 'error', skill: "@outputs('Skill_name')", component_id: '', message: 'Growing failed: the skill row or the publish did not go through. Answer from reasoning this time and say the skill could not be saved.' }, outSchema)
    }
  };
  writeFlow(workspace, GROW_FOLDER, skillId, flowName('RAPP Grow Skill Workflow'), `Writes a new InlineAgentSkill into ${schemaName}'s own bot record through Dataverse and republishes it (PvaPublish).`, skillDefinition, ref);
  writeTool(workspace, 'GrowSkill.mcs.yml', GROW_TOOL,
    'Adds a new skill to yourself permanently: writes the SKILL.md you author into your own bot record and republishes you. Use when the user needs a capability none of your skills cover and you can carry it out yourself (reasoning, or a script in your sandbox).',
    skillId, [['name', 'Short skill name: lowercase letters, digits and hyphens.'], ['description', 'One sentence: what the skill does and when to use it.'], ['instructions', 'Markdown body: numbered steps you can follow yourself, any sandbox script, and the exact answer format.']],
    ['status', 'skill', 'component_id', 'message']);

  // 2. Grow a new tool: an agent flow (connectionless HTTP) + a WorkflowTool, linked and published
  const toolId = workflowIdFor(schemaName, GROW_AGENT_FOLDER);
  const toolOutSchema = { type: 'object', properties: { status: { type: 'string' }, tool: { type: 'string' }, workflow_id: { type: 'string' }, component_id: { type: 'string' }, message: { type: 'string' } } };
  const toolDefinition = {
    $schema, contentVersion: '1.0.0.0', parameters,
    triggers: skillsTrigger({
      name: prop('name', 'Short tool name: lowercase letters, digits and hyphens, e.g. lobsters-top-stories.'),
      description: prop('description', 'One sentence: what the tool does and when to use it.'),
      definition: prop('definition', 'The agent flow definition as a JSON object string: {"$schema":"https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#","contentVersion":"1.0.0.0","parameters":{"$authentication":{"defaultValue":{},"type":"SecureObject"}},"triggers":{"manual":{"type":"Request","kind":"Skills","inputs":{"schema":{"type":"object","properties":{"count":{"title":"count","type":"string","description":"...","x-ms-dynamically-added":true}},"required":[]}}}},"actions":{"Fetch":{"type":"Http","inputs":{"method":"GET","uri":"https://...","headers":{"User-Agent":"RAPP/1.0"}}},"Respond":{"runAfter":{"Fetch":["Succeeded"]},"type":"Response","kind":"Skills","inputs":{"statusCode":200,"body":{"status":"success","items":"@take(body(\'Fetch\'), 5)"},"schema":{"type":"object","properties":{"status":{"type":"string"},"items":{"type":"array"}}}}}}}'),
      tool_yaml: prop('tool_yaml', 'The WorkflowTool inputs and outputs in YAML, exactly two top-level keys: toolInputs (list of {name, displayName, description}, matching the trigger schema) and toolOutputs (list of {name}, matching the Response body keys).')
    }, ['name', 'description', 'definition', 'tool_yaml']),
    actions: {
      Skill_name: { type: 'Compose', inputs: "@toLower(replace(replace(trim(triggerBody()?['name']), ' ', '-'), '_', '-'))" },
      ...botLookup,
      Definition: { runAfter: { Base_url: ['Succeeded'] }, type: 'Compose', inputs: "@json(triggerBody()?['definition'])" },
      Respond_badjson: respond({ Definition: ['Failed'] }, { status: 'error', tool: "@outputs('Skill_name')", workflow_id: '', component_id: '', message: 'definition is not valid JSON. Pass the Logic Apps definition as one JSON object string (no markdown fences).' }, toolOutSchema),
      // the two mistakes a model makes most: actions/triggers as arrays, or no manual trigger
      Shape_ok: { runAfter: { Definition: ['Succeeded'] }, type: 'Compose', inputs: "@and(startsWith(string(outputs('Definition')?['actions']), '{'), startsWith(string(outputs('Definition')?['triggers']), '{'), not(equals(outputs('Definition')?['triggers']?['manual'], null)))" },
      If_shape: {
        runAfter: { Shape_ok: ['Succeeded'] }, type: 'If', expression: { and: [{ equals: ["@outputs('Shape_ok')", false] }] },
        actions: { Respond_shape: respond({}, { status: 'error', tool: "@outputs('Skill_name')", workflow_id: '', component_id: '', message: 'definition has the wrong shape: "triggers" and "actions" must be JSON OBJECTS keyed by name (never arrays), and triggers must contain "manual" of type Request, kind Skills. Rewrite it as {"$schema":"...","contentVersion":"1.0.0.0","parameters":{"$authentication":{"defaultValue":{},"type":"SecureObject"}},"triggers":{"manual":{...}},"actions":{"Fetch":{...},"Respond":{...}}} and call again.' }, toolOutSchema), Stop: { runAfter: { Respond_shape: ['Succeeded'] }, type: 'Terminate', inputs: { runStatus: 'Cancelled' } } },
        else: { actions: {} }
      },
      Client_data: { runAfter: { If_shape: ['Succeeded'] }, type: 'Compose', inputs: "@string(json(concat('{\"properties\":{\"connectionReferences\":{},\"definition\":', triggerBody()?['definition'], ',\"templateName\":null},\"schemaVersion\":\"1.0.0.0\"}')))" },
      Existing: { runAfter: { Client_data: ['Succeeded'] }, ...dv('ListRecords', { entityName: 'botcomponents', $select: 'botcomponentid,schemaname', $filter: `_parentbotid_value eq '@{outputs('Bot_id')}' and schemaname eq '${schemaName}.tool.@{outputs('Skill_name')}'`, $top: 1 }) },
      If_new: {
        runAfter: { Existing: ['Succeeded'] }, type: 'If',
        expression: { and: [{ equals: ["@length(coalesce(body('Existing')?['value'], createArray()))", 0] }] },
        actions: {
          Create_flow: dv('CreateRecord', {
            entityName: 'workflows', 'item/name': `@concat('${schemaName} ', outputs('Skill_name'))`, 'item/description': "@triggerBody()?['description']",
            'item/category': 5, 'item/type': 1, 'item/mode': 0, 'item/scope': 4, 'item/primaryentity': 'none', 'item/modernflowtype': 0, 'item/clientdata': "@outputs('Client_data')",
            'item/xaml': '@null'   // the Dataverse connector marks xaml required on workflows; an empty string makes activation look for a classic definition, so send null
          }),
          // a row created through the connector is not provisioned in the flow service yet; activation must carry the definition again
          Activate_flow: { runAfter: { Create_flow: ['Succeeded'] }, ...dv('UpdateRecord', { entityName: 'workflows', recordId: "@body('Create_flow')?['workflowid']", 'item/clientdata': "@outputs('Client_data')", 'item/statecode': 1, 'item/statuscode': 2 }) },
          Tool_yaml: { runAfter: { Activate_flow: ['Succeeded'] }, type: 'Compose', inputs: `@{concat('kind: WorkflowTool', ${NL}, 'workflowId: ', body('Create_flow')?['workflowid'], ${NL}, trim(triggerBody()?['tool_yaml']), ${NL})}` },
          Create_tool: { runAfter: { Tool_yaml: ['Succeeded'] }, ...dv('CreateRecord', {
            entityName: 'botcomponents', 'item/name': "@outputs('Skill_name')", 'item/schemaname': `@concat('${schemaName}.tool.', outputs('Skill_name'))`,
            'item/componenttype': 9, 'item/description': "@triggerBody()?['description']", 'item/data': "@outputs('Tool_yaml')", 'item/parentbotid@odata.bind': "@concat('bots(', outputs('Bot_id'), ')')"
          }) },
          Link_tool: { runAfter: { Create_tool: ['Succeeded'] }, ...dv('AssociateEntities', { entityName: 'botcomponents', recordId: "@body('Create_tool')?['botcomponentid']", associationEntityRelationship: 'botcomponent_workflow', 'item/@odata.id': "@concat(outputs('Base_url'), 'workflows(', body('Create_flow')?['workflowid'], ')')" }) },
          Publish: publish('Link_tool')
        },
        else: { actions: {} }
      },
      Respond: respond({ If_new: ['Succeeded'] }, {
        status: 'success', tool: "@outputs('Skill_name')", workflow_id: "@body('Create_flow')?['workflowid']",
        component_id: "@coalesce(first(body('Existing')?['value'])?['botcomponentid'], body('Create_tool')?['botcomponentid'])",
        message: `@if(greater(length(coalesce(body('Existing')?['value'], createArray())), 0), concat('You already have the tool ', outputs('Skill_name'), '; call it, do not grow it again.'), concat('Tool ', outputs('Skill_name'), ' is now a component of ${schemaName} with its own agent flow; the republish takes about a minute to reach new conversations. Call it now.'))`
      }, toolOutSchema),
      // hand the engine's own error back to the agent so it can fix the definition and call again
      Respond_error: respond({ If_new: ['Failed', 'TimedOut'] }, { status: 'error', tool: "@outputs('Skill_name')", workflow_id: '', component_id: '', message: "@concat('Growing the tool failed. Fix exactly what this says and call again once: ', substring(string(result('If_new')), 0, min(1800, length(string(result('If_new'))))))" }, toolOutSchema)
    }
  };
  writeFlow(workspace, GROW_AGENT_FOLDER, toolId, flowName('RAPP Grow Tool Workflow'), `Creates and activates an agent flow from a definition the agent authored, adds it to ${schemaName} as a WorkflowTool, links them and republishes (PvaPublish).`, toolDefinition, ref);
  writeTool(workspace, 'GrowTool.mcs.yml', GROW_AGENT_TOOL,
    'Adds a new TOOL to yourself permanently: an agent flow you author (connectionless HTTP to a public API, then a Response) plus its tool contract, linked to you and republished. Use to grow a whole agent for an outside source, like a news feed or a public JSON API. Fetch the source first with "Fetch a URL" so the flow parses real fields. definition rules: one JSON object string; "triggers" and "actions" are OBJECTS keyed by name, never arrays; EVERY action except the first MUST carry \"runAfter\": {\"<previous action name>\": [\"Succeeded\"]} (a missing runAfter is rejected at activation); triggers = {"manual":{"type":"Request","kind":"Skills","inputs":{"schema":{...}}}}; every action has "type" and later ones have "runAfter"; the last action is {"type":"Response","kind":"Skills","inputs":{"statusCode":200,"body":{...},"schema":{...}}}; Http actions: {"type":"Http","inputs":{"method":"GET","uri":"https://..."}}.',
    toolId, [['name', 'Short tool name: lowercase letters, digits and hyphens.'], ['description', 'One sentence: what the tool does and when to use it.'], ['definition', 'The complete Logic Apps definition as a JSON object string (Request trigger of kind Skills, Http action(s), Response of kind Skills).'], ['tool_yaml', 'YAML with toolInputs (name, displayName, description) matching the trigger schema and toolOutputs (name) matching the Response body.']],
    ['status', 'tool', 'workflow_id', 'component_id', 'message']);

  // 3. Fetch a URL: outbound read so the body can look at a public API or a RAR agent.py before it authors a flow
  const fetchId = workflowIdFor(schemaName, FETCH_FOLDER);
  const fetchOutSchema = { type: 'object', properties: { status: { type: 'string' }, status_code: { type: 'integer' }, body: { type: 'string' } } };
  const fetchDefinition = {
    $schema, contentVersion: '1.0.0.0', parameters: { $authentication: { defaultValue: {}, type: 'SecureObject' } },
    triggers: skillsTrigger({
      url: prop('url', 'The https URL (a public JSON API, a raw GitHub file such as a RAR agent.py, a feed).'),
      method: prop('method', 'GET (default) or POST.'),
      body: prop('body', 'Optional request body for POST, as a JSON string.')
    }, ['url']),
    actions: {
      Fetch: { type: 'Http', inputs: { method: "@coalesce(triggerBody()?['method'], 'GET')", uri: "@triggerBody()?['url']", headers: { 'User-Agent': 'RAPP-Stemcell-Fetch/1.0', Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' }, body: "@if(empty(triggerBody()?['body']), null, triggerBody()?['body'])" } },
      Body_text: { runAfter: { Fetch: ['Succeeded', 'Failed'] }, type: 'Compose', inputs: "@if(greater(length(string(body('Fetch'))), 12000), concat(substring(string(body('Fetch')), 0, 12000), decodeUriComponent('%0A'), '[truncated at 12000 characters]'), string(body('Fetch')))" },
      Respond: respond({ Body_text: ['Succeeded'] }, { status: "@if(equals(outputs('Fetch')?['statusCode'], 200), 'success', 'error')", status_code: "@outputs('Fetch')?['statusCode']", body: "@outputs('Body_text')" }, fetchOutSchema)
    }
  };
  writeFlow(workspace, FETCH_FOLDER, fetchId, flowName('RAPP Fetch URL Workflow'), 'Connectionless HTTP GET of a public URL, returned as text (capped at 12000 characters).', fetchDefinition, null);
  writeTool(workspace, 'FetchUrl.mcs.yml', FETCH_TOOL,
    'Calls a public URL (a JSON API, a raw GitHub file such as a RAR agent.py, a feed) and returns the body as text. This is how you reach any outside source: skills you grow for a news feed or an API call this tool with the source URL and then format the result.',
    fetchId, [['url', 'The https URL.'], ['method', 'GET (default) or POST.'], ['body', 'Optional JSON request body for POST.']], ['status', 'status_code', 'body']);

  return { id: skillId, folder: `${GROW_FOLDER}-${skillId}`, tool: GROW_TOOL, connectionReference: ref,
    tools: [{ tool: GROW_TOOL, id: skillId }, { tool: GROW_AGENT_TOOL, id: toolId }, { tool: FETCH_TOOL, id: fetchId }] };
}

/** Instruction lines for a body that can grow itself. */
export function selfGrowthInstructions(hasFriend) {
  return [
    `You can grow. When the user asks for something none of your skills or tools cover:`,
    `- If you can do it yourself (reasoning, or a script run in your sandbox): author a skill and call "${GROW_TOOL}" with name (lowercase, hyphens), a one-sentence description, and instructions (numbered steps you can follow yourself, the script if any, the exact answer format). Then carry out the request by following the new skill immediately, and say the skill is now part of you.`,
    `- If it needs live data from a public URL (a news feed, a JSON API, anything like the HackerNews agent but for another source): call "${FETCH_TOOL}" on the source URL to see the real response shape (and, when a RAPP Agent Registry agent.py exists for it, fetch that raw file as the reference implementation). Then grow a SKILL for that source with "${GROW_TOOL}": its instructions name the exact URL(s) to call with "${FETCH_TOOL}", the fields to read from the response, the sorting or filtering the reference does, and the answer format. Answer the user by following it, and say the agent is now part of you. That skill plus "${FETCH_TOOL}" is the agent; it needs no function and no friend.`,
    `- "${GROW_AGENT_TOOL}" (a dedicated agent flow per source) is experimental: the platform may refuse to activate a flow created this way. Prefer the skill route above; use the tool route only when the user explicitly asks for a dedicated flow.`,
    `- Flows you grow are connectionless: use only Http actions to public endpoints, Compose, Select, Filter, If, and expressions. Never reference a connection or a custom connector; those need a person to create a connection.`,
    `- Grown capabilities reach new conversations about a minute after growing; in this conversation use them right away.`,
    hasFriend
      ? 'Phone a friend only for things that need the friend\'s python agents or its memory; grow a skill or a tool for anything you can do yourself or reach over public HTTP.'
      : 'Say so when a request needs a system you cannot reach over public HTTP.',
    'Never grow a skill or tool that duplicates one you already have; reuse it.'
  ];
}
