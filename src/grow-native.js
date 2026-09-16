// @ts-check
/**
 * Self-growth, entirely inside Power Platform: the Copilot Studio body writes a new skill into its
 * OWN bot record and publishes itself. No friend, no function, no pac, no Mac.
 *
 *   agent decides it lacks a capability
 *     → authors a SKILL.md (name, description, instructions it can follow itself, sandbox scripts included)
 *     → calls the "Grow a new skill" tool (an agent flow)
 *         → Dataverse: List bots (its own schema name) → Create botcomponents row (InlineAgentSkill, componenttype 9)
 *         → Dataverse: PvaPublish bound action on the bot (the same action pac copilot publish uses)
 *     → follows the new skill right away; it is a component of the bot from now on
 *
 * Verified 16 Sep 2026: a botcomponents row created over the Web API + PvaPublish made a skill the
 * harness loaded on the next 3p turn ("Loading skill: nativetest…").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessSdk } from './sdk.js';

export const GROW_TOOL = 'Grow a new skill';
export const GROW_FOLDER = 'RAPPGrowSkill';
export const DATAVERSE_API = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';

const NL = "decodeUriComponent('%0A')";

/**
 * @param {string} schemaName
 * @param {string} workspace
 * @param {{ connectionReference?: string }} [opts]
 */
export async function buildSelfGrowth(schemaName, workspace, opts = {}) {
  const { workflowIdFor } = await loadHarnessSdk();
  const id = workflowIdFor(schemaName, GROW_FOLDER);
  const folder = `${GROW_FOLDER}-${id}`;
  const ref = opts.connectionReference || `${schemaName}.cr.shared_commondataserviceforapps`;
  const wfDir = join(workspace, 'workflows', folder);
  mkdirSync(wfDir, { recursive: true });
  mkdirSync(join(workspace, 'capabilities', 'tools'), { recursive: true });
  mkdirSync(join(workspace, 'infrastructure', 'connections'), { recursive: true });

  const dv = (operationId, parameters) => ({
    type: 'OpenApiConnection',
    inputs: { host: { apiId: DATAVERSE_API, connectionName: 'shared_commondataserviceforapps', operationId }, parameters, authentication: "@parameters('$authentication')" }
  });
  // kind: InlineAgentSkill / content: | <SKILL.md indented by two spaces>
  const skillYaml = `@{concat('kind: InlineAgentSkill', ${NL}, 'content: |', ${NL}, '  ---', ${NL}, '  name: ', outputs('Skill_name'), ${NL}, '  description: "', replace(replace(triggerBody()?['description'], '"', ''''), ${NL}, ' '), '"', ${NL}, '  ---', ${NL}, '  # ', outputs('Skill_name'), ${NL}, ${NL}, '  ', replace(triggerBody()?['instructions'], ${NL}, concat(${NL}, '  ')), ${NL})}`;
  const outputSchema = { type: 'object', properties: { status: { type: 'string' }, skill: { type: 'string' }, component_id: { type: 'string' }, message: { type: 'string' } } };
  const definition = {
    $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
    contentVersion: '1.0.0.0',
    parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } },
    triggers: {
      manual: {
        type: 'Request', kind: 'Skills',
        inputs: { schema: { type: 'object', properties: {
          name: { title: 'name', type: 'string', description: 'Short skill name: lowercase letters, digits and hyphens, e.g. roman-numerals.', 'x-ms-dynamically-added': true },
          description: { title: 'description', type: 'string', description: 'One sentence: what the skill does and when to use it.', 'x-ms-dynamically-added': true },
          instructions: { title: 'instructions', type: 'string', description: 'The skill body in Markdown: numbered steps you can follow yourself, including any script to run in your sandbox and the exact answer format.', 'x-ms-dynamically-added': true }
        }, required: ['name', 'description', 'instructions'] } }
      }
    },
    actions: {
      Skill_name: { type: 'Compose', inputs: "@toLower(replace(replace(trim(triggerBody()?['name']), ' ', '-'), '_', '-'))" },
      List_bots: { runAfter: { Skill_name: ['Succeeded'] }, ...dv('ListRecords', { entityName: 'bots', $select: 'botid,schemaname', $filter: `schemaname eq '${schemaName}'`, $top: 1 }) },
      Bot_id: { runAfter: { List_bots: ['Succeeded'] }, type: 'Compose', inputs: "@first(body('List_bots')?['value'])?['botid']" },
      Skill_yaml: { runAfter: { Bot_id: ['Succeeded'] }, type: 'Compose', inputs: skillYaml },
      Existing: { runAfter: { Skill_yaml: ['Succeeded'] }, ...dv('ListRecords', { entityName: 'botcomponents', $select: 'botcomponentid,schemaname', $filter: `_parentbotid_value eq '@{outputs('Bot_id')}' and schemaname eq '${schemaName}.skill.@{outputs('Skill_name')}'`, $top: 1 }) },
      If_new: {
        runAfter: { Existing: ['Succeeded'] }, type: 'If',
        expression: { and: [{ equals: ["@length(coalesce(body('Existing')?['value'], createArray()))", 0] }] },
        actions: {
          Create_skill: dv('CreateRecord', {
            entityName: 'botcomponents', 'item/name': "@outputs('Skill_name')", 'item/schemaname': `@concat('${schemaName}.skill.', outputs('Skill_name'))`,
            'item/componenttype': 9, 'item/description': "@triggerBody()?['description']", 'item/data': "@outputs('Skill_yaml')", 'item/parentbotid@odata.bind': "@concat('bots(', outputs('Bot_id'), ')')"
          }),
          Publish: { runAfter: { Create_skill: ['Succeeded'] }, ...dv('PerformBoundAction', { entityName: 'bots', actionName: 'Microsoft.Dynamics.CRM.PvaPublish', recordId: "@outputs('Bot_id')" }) }
        },
        else: { actions: {} }
      },
      Respond: {
        runAfter: { If_new: ['Succeeded'] }, type: 'Response', kind: 'Skills',
        inputs: { statusCode: 200, body: {
          status: 'success', skill: "@outputs('Skill_name')",
          component_id: "@coalesce(first(body('Existing')?['value'])?['botcomponentid'], body('Create_skill')?['botcomponentid'])",
          message: "@if(greater(length(coalesce(body('Existing')?['value'], createArray())), 0), concat('You already have the skill ', outputs('Skill_name'), '; follow it, do not grow it again.'), concat('Skill ', outputs('Skill_name'), ' is now a component of ${schemaName}; the republish takes about a minute to reach new conversations. Follow it now.'))"
        }, schema: outputSchema }
      },
      Respond_error: {
        runAfter: { If_new: ['Failed', 'TimedOut'] }, type: 'Response', kind: 'Skills',
        inputs: { statusCode: 200, body: { status: 'error', skill: "@outputs('Skill_name')", component_id: '', message: 'Growing failed: the skill row or the publish did not go through. Answer from reasoning this time and say the skill could not be saved.' }, schema: outputSchema }
      }
    }
  };
  const connectionReferences = { shared_commondataserviceforapps: { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: ref }, api: { name: 'shared_commondataserviceforapps' } } };
  writeFileSync(join(wfDir, 'workflow.json'), JSON.stringify({ properties: { connectionReferences, definition, templateName: null }, schemaVersion: '1.0.0.0' }, null, 2));
  writeFileSync(join(wfDir, 'metadata.yml'), [
    `jsonFileName: workflows/${folder}/workflow.json`, `workflowId: ${id}`, 'name: RAPP Grow Skill Workflow', 'type: 1',
    `description: Writes a new InlineAgentSkill into ${schemaName}'s own bot record through Dataverse and republishes it (PvaPublish).`, 'subprocess: false', 'category: 5', 'mode: 0', 'scope: 4',
    'onDemand: false', 'triggerOnCreate: false', 'triggerOnDelete: false', 'asyncAutodelete: false', 'syncWorkflowLogOnFailure: false', 'stateCode: 1', 'statusCode: 2', 'runAs: 1', 'isTransacted: true', 'introducedVersion: 1.0',
    'isCustomizable:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: iscustomizableanddeletable', 'businessProcessType: 0',
    'isCustomProcessingStepAllowedForOtherPublishers:', '  value: true', '  canBeChanged: true', '  managedPropertyLogicalName: canbedeleted',
    'modernFlowType: 0', 'primaryEntity: none', 'connectionReferences: []', ''   // pac's push rejects a list here; the flow's clientdata carries the reference
  ].join('\n'));
  writeFileSync(join(workspace, 'infrastructure', 'connections', `${ref}.sync.yaml`), `connectionReferences:\n  - connectionReferenceLogicalName: ${ref}\n    connectorId: ${DATAVERSE_API}\n`);
  writeFileSync(join(workspace, 'capabilities', 'tools', 'GrowSkill.mcs.yml'), [
    'mcs.metadata:', `  componentName: ${JSON.stringify(GROW_TOOL)}`,
    `  description: ${JSON.stringify('Adds a new skill to yourself permanently: writes the SKILL.md you author into your own bot record and republishes you. Use when the user needs a capability none of your skills cover and you can carry it out yourself (reasoning, or a script in your sandbox).')}`,
    'kind: WorkflowTool', `workflowId: ${id}`,
    'toolInputs:', '  - name: name', '    displayName: name', `    description: ${JSON.stringify('Short skill name: lowercase letters, digits and hyphens.')}`,
    '  - name: description', '    displayName: description', `    description: ${JSON.stringify('One sentence: what the skill does and when to use it.')}`,
    '  - name: instructions', '    displayName: instructions', `    description: ${JSON.stringify('Markdown body: numbered steps you can follow yourself, any sandbox script, and the exact answer format.')}`,
    'toolOutputs:', '  - name: status', '  - name: skill', '  - name: component_id', '  - name: message', ''
  ].join('\n'));
  return { id, folder, tool: GROW_TOOL, connectionReference: ref };
}

/** Instruction lines for a body that can grow itself. */
export function selfGrowthInstructions(hasFriend) {
  return [
    `You can grow. When the user asks for something none of your skills cover and you can do it yourself (by reasoning, or with a script run in your sandbox), do not refuse and do not improvise once: author a skill and call the "${GROW_TOOL}" tool with name (lowercase, hyphens), a one-sentence description, and instructions (numbered steps you can follow yourself, the script if any, the exact answer format). Then carry out the user's request by following the new skill immediately, and say the skill is now part of you.`,
    hasFriend
      ? 'If the capability needs live outside data or systems that your sandbox cannot reach, phone a friend instead of growing a skill; grow a skill only for what you can do yourself.'
      : 'Grow a skill only for what you can do yourself; say so when a request needs live outside systems.',
    'Never grow a skill that duplicates one you already have; reuse it.'
  ];
}
