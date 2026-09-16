// @ts-check
/**
 * Solution projection: turn a harness workspace into an importable Power Platform solution zip,
 * using only pac (pack, import, copilot publish). No Dataverse Web API, no az, no custom connector.
 *
 * Why a second deploy path: copilot-harness-sdk's deploy script provisions through the Web API and
 * needs a Dataverse bearer token from az; this path needs only a pac auth profile, and the zip it
 * writes is the same artifact you hand to anyone ("load it into any environment").
 *
 * The file shapes are the ones `pac solution unpack` produces for an exported harness agent
 * (16 Sep 2026 export of rapp_Stemcell): bots/<schema>/{bot.xml,configuration.json},
 * botcomponents/<schema>.<kind>.<name>/{botcomponent.xml,data}, Workflows/<Name>-<ID>.json(+.data.xml),
 * Assets/botcomponent_workflowset.xml, Other/{Solution.xml,Customizations.xml}.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const yamlValue = (text, key) => (String(text).match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^"(.*)"$/, '$1');

/** The `value: |-` literal block of settings.mcs.yml instructions, and the other settings we need. */
export function readSettings(workspace) {
  const text = readFileSync(join(workspace, 'settings.mcs.yml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*value:\s*\|-?\s*$/.test(l));
  const indent = start >= 0 ? (lines[start + 1].match(/^ */) || [''])[0].length : 0;
  const body = [];
  for (let i = start + 1; i < lines.length && start >= 0; i++) {
    const l = lines[i];
    if (l.trim() && (l.match(/^ */) || [''])[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return {
    displayName: yamlValue(text, 'displayName'), schemaName: yamlValue(text, 'schemaName'),
    model: (text.match(/series:\s*(\S+)/) || [])[1] || 'Sonnet46', greeting: yamlValue(text, 'greetingText') || '',
    instructions: body.join('\n').replace(/\s+$/, '')
  };
}

/** mcs.metadata + kind + payload of a behavior or tool YAML: { componentName, description, data } where data is everything after the metadata block. */
export function readComponentYaml(file) {
  const text = readFileSync(file, 'utf8');
  const componentName = (text.match(/^\s*componentName:\s*(.+)$/m) || [])[1]?.trim().replace(/^"(.*)"$/, '$1') || '';
  const description = (text.match(/^\s*description:\s*(.+)$/m) || [])[1]?.trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"') || '';
  const kindIdx = text.search(/^kind:/m);
  return { componentName, description, kind: yamlValue(text, 'kind'), data: text.slice(kindIdx).replace(/\s+$/, '') + '\n' };
}

/**
 * @param {string} workspace  a harness workspace (settings.mcs.yml, behaviors/, capabilities/tools/, workflows/, infrastructure/connections/)
 * @param {{ outDir: string, publisherPrefix?: string, solutionName?: string, version?: string, optionValuePrefix?: number }} cfg
 */
export function buildSolutionFolder(workspace, cfg) {
  const s = readSettings(workspace);
  const schema = s.schemaName;
  const prefix = cfg.publisherPrefix || schema.split('_')[0];
  const solutionName = cfg.solutionName || `${schema.replace(/[^A-Za-z0-9]/g, '')}Harness`;
  const out = resolve(cfg.outDir);
  rmSync(out, { recursive: true, force: true });
  for (const d of ['Other', 'Assets', `bots/${schema}`, 'botcomponents', 'Workflows']) mkdirSync(join(out, d), { recursive: true });

  // bot
  writeFileSync(join(out, 'bots', schema, 'bot.xml'), `<bot schemaname="${xml(schema)}">\n  <authenticationmode>2</authenticationmode>\n  <authenticationtrigger>1</authenticationtrigger>\n  <iscustomizable>0</iscustomizable>\n  <language>1033</language>\n  <name>${xml(s.displayName)}</name>\n  <runtimeprovider>0</runtimeprovider>\n  <template>cliagent-1.0.0</template>\n  <timezoneruleversionnumber>4</timezoneruleversionnumber>\n</bot>`);
  writeFileSync(join(out, 'bots', schema, 'configuration.json'), JSON.stringify({
    $kind: 'BotConfiguration', recognizer: { $kind: 'CLICopilotRecognizer' },
    agentSettings: { $kind: 'AgentSettings', model: { $kind: 'ModelConfig', series: s.model }, instructions: { $kind: 'Instructions', segments: [{ $kind: 'StaticSegment', value: s.instructions }] }, greetingText: s.greeting },
    authoringModel: 'CliCopilot'
  }, null, 2));

  const component = (schemaSuffix, name, description, data) => {
    const dir = join(out, 'botcomponents', `${schema}.${schemaSuffix}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'botcomponent.xml'), `<botcomponent schemaname="${xml(`${schema}.${schemaSuffix}`)}">\n  <componenttype>9</componenttype>\n  <description>${xml(description)}</description>\n  <iscustomizable>1</iscustomizable>\n  <name>${xml(name)}</name>\n  <parentbotid>\n    <schemaname>${xml(schema)}</schemaname>\n  </parentbotid>\n  <statecode>0</statecode>\n  <statuscode>1</statuscode>\n</botcomponent>`);
    writeFileSync(join(dir, 'data'), data);
  };
  const components = [];
  const bDir = join(workspace, 'behaviors');
  if (existsSync(bDir)) for (const f of readdirSync(bDir).filter((f) => f.endsWith('.mcs.yml')).sort()) {
    const c = readComponentYaml(join(bDir, f));
    const name = f.replace(/\.mcs\.yml$/, '');
    component(`skill.${name}`, c.componentName || name, c.description, c.data);
    components.push({ kind: c.kind, schemaName: `${schema}.skill.${name}` });
  }
  const links = [];
  const tDir = join(workspace, 'capabilities', 'tools');
  if (existsSync(tDir)) for (const f of readdirSync(tDir).filter((f) => f.endsWith('.mcs.yml')).sort()) {
    const c = readComponentYaml(join(tDir, f));
    const name = f.replace(/\.mcs\.yml$/, '');
    component(`tool.${name}`, c.componentName || name, c.description, c.data);
    components.push({ kind: c.kind, schemaName: `${schema}.tool.${name}` });
    const wf = yamlValue(c.data, 'workflowId');
    if (c.kind === 'WorkflowTool' && wf) links.push({ schemaName: `${schema}.tool.${name}`, workflowId: wf });
  }

  // flows
  const workflows = [];
  const wDir = join(workspace, 'workflows');
  if (existsSync(wDir)) for (const folder of readdirSync(wDir).sort()) {
    const jsonFile = join(wDir, folder, 'workflow.json');
    if (!existsSync(jsonFile)) continue;
    const meta = existsSync(join(wDir, folder, 'metadata.yml')) ? readFileSync(join(wDir, folder, 'metadata.yml'), 'utf8') : '';
    const id = (yamlValue(meta, 'workflowId') || (folder.match(/[0-9a-f-]{36}$/i) || [])[0] || '').toLowerCase();
    const name = yamlValue(meta, 'name') || folder.replace(/-[0-9a-f-]{36}$/i, '');
    const description = yamlValue(meta, 'description') || '';
    const base = `${name.replace(/[^A-Za-z0-9]/g, '')}-${id.toUpperCase()}`;
    writeFileSync(join(out, 'Workflows', `${base}.json`), readFileSync(jsonFile, 'utf8'));
    writeFileSync(join(out, 'Workflows', `${base}.json.data.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<Workflow WorkflowId="{${id}}" Name="${xml(name)}" Description="${xml(description)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <JsonFileName>/Workflows/${base}.json</JsonFileName>\n  <Type>1</Type>\n  <Subprocess>0</Subprocess>\n  <Category>5</Category>\n  <Mode>0</Mode>\n  <Scope>4</Scope>\n  <OnDemand>0</OnDemand>\n  <TriggerOnCreate>0</TriggerOnCreate>\n  <TriggerOnDelete>0</TriggerOnDelete>\n  <AsyncAutodelete>0</AsyncAutodelete>\n  <SyncWorkflowLogOnFailure>0</SyncWorkflowLogOnFailure>\n  <StateCode>1</StateCode>\n  <StatusCode>2</StatusCode>\n  <RunAs>1</RunAs>\n  <IsTransacted>1</IsTransacted>\n  <IntroducedVersion>1.0</IntroducedVersion>\n  <IsCustomizable>1</IsCustomizable>\n  <BusinessProcessType>0</BusinessProcessType>\n  <IsCustomProcessingStepAllowedForOtherPublishers>1</IsCustomProcessingStepAllowedForOtherPublishers>\n  <ModernFlowType>0</ModernFlowType>\n  <PrimaryEntity>none</PrimaryEntity>\n  <LocalizedNames>\n    <LocalizedName languagecode="1033" description="${xml(name)}" />\n  </LocalizedNames>\n  <Descriptions>\n    <Description languagecode="1033" description="${xml(description)}" />\n  </Descriptions>\n</Workflow>\n`);
    workflows.push({ id, name });
  }
  writeFileSync(join(out, 'Assets', 'botcomponent_workflowset.xml'), `<botcomponent_workflowset>\n${links.map((l) => `  <botcomponent_workflow botcomponentid.schemaname="${xml(l.schemaName)}" workflowid.workflowid="${l.workflowId}">\n    <iscustomizable>1</iscustomizable>\n  </botcomponent_workflow>`).join('\n')}\n</botcomponent_workflowset>`);

  // connection references
  const refs = [];
  const cDir = join(workspace, 'infrastructure', 'connections');
  if (existsSync(cDir)) for (const f of readdirSync(cDir).filter((f) => f.endsWith('.sync.yaml'))) {
    const t = readFileSync(join(cDir, f), 'utf8');
    const logical = yamlValue(t, '\\s*- connectionReferenceLogicalName') || (t.match(/connectionReferenceLogicalName:\s*(\S+)/) || [])[1];
    const connector = (t.match(/connectorId:\s*(\S+)/) || [])[1];
    if (logical && connector) refs.push({ logical, connector });
  }
  writeFileSync(join(out, 'Other', 'Customizations.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <Entities />\n  <Roles />\n  <Workflows />\n  <FieldSecurityProfiles />\n  <Templates />\n  <EntityMaps />\n  <EntityRelationships />\n  <OrganizationSettings />\n  <optionsets />\n  <CustomControls />\n  <EntityDataProviders />\n  <connectionreferences>\n${refs.map((r) => `    <connectionreference connectionreferencelogicalname="${xml(r.logical)}">\n      <connectionreferencedisplayname>${xml(r.logical)}</connectionreferencedisplayname>\n      <connectorid>${xml(r.connector)}</connectorid>\n      <iscustomizable>0</iscustomizable>\n      <promptingbehavior>0</promptingbehavior>\n      <statecode>0</statecode>\n      <statuscode>1</statuscode>\n    </connectionreference>`).join('\n')}\n  </connectionreferences>\n  <Languages>\n    <Language>1033</Language>\n  </Languages>\n</ImportExportXml>\n`);
  const nil = (tag) => `      <${tag} xsi:nil="true"></${tag}>`;
  const address = (n) => `        <Address>\n          <AddressNumber>${n}</AddressNumber>\n          <AddressTypeCode>1</AddressTypeCode>\n${['City', 'County', 'Country', 'Fax', 'FreightTermsCode', 'ImportSequenceNumber', 'Latitude', 'Line1', 'Line2', 'Line3', 'Longitude', 'Name', 'PostalCode', 'PostOfficeBox', 'PrimaryContactName'].map((t) => `          <${t} xsi:nil="true"></${t}>`).join('\n')}\n          <ShippingMethodCode>1</ShippingMethodCode>\n${['StateOrProvince', 'Telephone1', 'Telephone2', 'Telephone3', 'TimeZoneRuleVersionNumber', 'UPSZone', 'UTCOffset', 'UTCConversionTimeZoneCode'].map((t) => `          <${t} xsi:nil="true"></${t}>`).join('\n')}\n        </Address>`;
  writeFileSync(join(out, 'Other', 'Solution.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<ImportExportXml version="9.2.26082.162" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <SolutionManifest>\n    <UniqueName>${xml(solutionName)}</UniqueName>\n    <LocalizedNames>\n      <LocalizedName description="${xml(solutionName)}" languagecode="1033" />\n    </LocalizedNames>\n    <Descriptions />\n    <Version>${cfg.version || '1.0'}</Version>\n    <Managed>0</Managed>\n    <Publisher>\n      <UniqueName>${xml(prefix)}</UniqueName>\n      <LocalizedNames>\n        <LocalizedName description="${xml(prefix)}" languagecode="1033" />\n      </LocalizedNames>\n      <Descriptions>\n        <Description description="${xml(prefix)}" languagecode="1033" />\n      </Descriptions>\n${nil('EMailAddress')}\n${nil('SupportingWebsiteUrl')}\n      <CustomizationPrefix>${xml(prefix)}</CustomizationPrefix>\n      <CustomizationOptionValuePrefix>${cfg.optionValuePrefix || 85533}</CustomizationOptionValuePrefix>\n      <Addresses>\n${address(1)}\n${address(2)}\n      </Addresses>\n    </Publisher>\n    <RootComponents>\n${workflows.map((w) => `      <RootComponent type="29" id="{${w.id}}" behavior="0" />`).join('\n')}\n    </RootComponents>\n    <MissingDependencies />\n  </SolutionManifest>\n</ImportExportXml>\n`);
  return { folder: out, schemaName: schema, solutionName, components, workflows, links, connectionReferences: refs };
}

function pac(args, opts = {}) {
  const r = spawnSync('pac', args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

export function packSolution(folder, zipPath) {
  mkdirSync(resolve(zipPath, '..'), { recursive: true });
  return pac(['solution', 'pack', '--zipfile', zipPath, '--folder', folder, '--packagetype', 'Unmanaged']);
}

/**
 * Delete bot components by schema name through the Dataverse Web API.
 * A solution import updates and adds, never removes, so a capability the projection has DROPPED
 * (a python agent card, a skill that needs a host) lives on and the agent keeps offering it.
 * Only names the caller passes are touched, so anything the body grew on its own is safe.
 */
export async function pruneComponents(environment, botId, schemaNames, tokenCommand) {
  if (!schemaNames?.length) return { pruned: [], failed: [] };
  const base = environment.replace(/\/+$/, '') + '/api/data/v9.2/';
  const token = execSync(tokenCommand || `az account get-access-token --resource ${environment} --query accessToken -o tsv`, { encoding: 'utf8' }).trim();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-Version': '4.0' };
  const filter = `_parentbotid_value eq ${botId}`;
  const r = await fetch(`${base}botcomponents?$select=botcomponentid,schemaname&$filter=${encodeURIComponent(filter)}`, { headers });
  if (!r.ok) return { pruned: [], failed: [{ why: `list → ${r.status}` }] };
  const live = (await r.json()).value || [];
  const wanted = new Set(schemaNames);
  const pruned = [], failed = [];
  for (const c of live.filter((c) => wanted.has(c.schemaname))) {
    const d = await fetch(`${base}botcomponents(${c.botcomponentid})`, { method: 'DELETE', headers });
    (d.ok ? pruned : failed).push(d.ok ? c.schemaname : { name: c.schemaname, why: `delete → ${d.status}` });
  }
  return { pruned, failed };
}

/** Import (create or update) with pac; then publish the bot with pac copilot publish (its id read with pac env fetch). */
export async function importSolution(zipPath, environment, schemaName, opts = {}) {
  /** @type {string[]} */ const draftFlows = [];
  const imp = pac(['solution', 'import', '--environment', environment, '--path', zipPath, '--force-overwrite', '--publish-changes', ...(opts.settingsFile ? ['--settings-file', opts.settingsFile] : [])]);
  if (!imp.ok) return { ok: false, step: 'import', out: imp.out };
  const fetch = pac(['env', 'fetch', '--environment', environment, '--xml', `<fetch><entity name='bot'><attribute name='botid'/><attribute name='publishedon'/><filter><condition attribute='schemaname' operator='eq' value='${schemaName}'/></filter></entity></fetch>`]);
  const botId = (fetch.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
  let pruned = null;
  if (botId && opts.prune?.length) {
    try { pruned = await pruneComponents(environment, botId, opts.prune, opts.tokenCommand); }
    catch (e) { pruned = { pruned: [], failed: [{ why: e.message.split('\n')[0] }] }; }
  }
  let publish = null;
  if (botId && opts.publish !== false) {
    // pac 2.10 sometimes dies after the publish request was accepted; the request still goes through
    for (let i = 1; i <= 3; i++) {
      publish = pac(['copilot', 'publish', '--bot', botId, '--environment', environment]);
      if (/Published successfully/i.test(publish.out)) break;
      const again = pac(['env', 'fetch', '--environment', environment, '--xml', `<fetch><entity name='bot'><attribute name='publishedon'/><filter><condition attribute='botid' operator='eq' value='${botId}'/></filter></entity></fetch>`]);
      publish.publishedon = (again.out.match(/\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M/) || [])[0];
      if (publish.publishedon) break;
    }
  }
  // a solution import creates and activates new flows, but never re-activates one an earlier failed activation left in draft
  for (const id of opts.workflowIds || []) {
    const st = pac(['env', 'fetch', '--environment', environment, '--xml', `<fetch><entity name='workflow'><attribute name='statecode'/><attribute name='name'/><filter><condition attribute='workflowid' operator='eq' value='${id}'/></filter></entity></fetch>`]);
    if (/\bDraft\b/.test(st.out)) draftFlows.push(id);
  }
  return { ok: true, step: 'done', botId, importOut: imp.out.trim().split('\n').slice(-2).join(' '), published: publish ? (/Published successfully/i.test(publish.out) || !!publish.publishedon) : null,
    ...(pruned ? { pruned: pruned.pruned, pruneFailed: pruned.failed } : {}),
    draftFlows, ...(draftFlows.length ? { hint: 'a flow stayed in draft: rebuild with a higher --flow-generation so it gets a fresh id, then deploy again' } : {}) };
}
