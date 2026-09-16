// @ts-check
/**
 * Harvest: what a body grew on its own comes home to the genome.
 *
 * A Copilot Studio body that grows skills through "Grow a new skill" writes InlineAgentSkill rows
 * into its bot record. Harvest reads those rows and writes each one the genome does not have yet
 * as <genome>/agents/<name>/SKILL.md, so every other body (sdk, headless, the next Studio deploy)
 * carries the capability too. One genome; the bodies teach it.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { loadHarnessSdk } from './sdk.js';
import { readGenome } from './genome.js';

/** SKILL.md text out of an InlineAgentSkill `data` YAML (kind: InlineAgentSkill / content: | ...). */
export function skillMarkdownFromComponentData(data) {
  const m = String(data || '').match(/^content:\s*\|-?\s*\n([\s\S]*)$/m);
  if (!m) return null;
  const lines = m[1].split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n').replace(/\s+$/, '') + '\n';
}

/**
 * @param {{ environmentUrl: string, schemaName: string, genomeDir?: string, tokenCommand?: string, dryRun?: boolean, log?: (l: string) => void }} cfg
 */
export async function harvest(cfg) {
  const log = cfg.log || ((l) => console.log(l));
  const { dataverse, resolveHarnessBot } = await loadHarnessSdk();
  const environmentUrl = cfg.environmentUrl.replace(/\/+$/, '') + '/';
  const tokenCommand = cfg.tokenCommand || `az account get-access-token --resource ${environmentUrl} --query accessToken -o tsv`;
  const getDataverseToken = async () => execSync(tokenCommand, { encoding: 'utf8' }).trim();
  const opts = { environmentUrl, getDataverseToken, schemaName: cfg.schemaName };
  const bot = await resolveHarnessBot(opts);
  const dv = dataverse(opts);
  const { body } = await dv(`botcomponents?$filter=_parentbotid_value eq ${bot.botid}&$select=schemaname,name,data,description,createdon`);
  const genomeDir = resolve(cfg.genomeDir || (await readGenome(undefined, { contracts: false })).dir);
  const genome = await readGenome(genomeDir, { contracts: false });
  // agent names statically from the files (hacker_news_agent.py → hackernews) so projection cards are never harvested back
  const agentNames = readdirSync(join(genomeDir, 'agents')).filter((f) => f.endsWith('_agent.py')).map((f) => f.replace(/_agent\.py$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase());
  const have = new Set([...genome.skills.map((s) => s.name), ...agentNames]);
  const isProjectionCard = (md) => /Call the "Phone a friend" tool|## Reference implementation \(RAPP agent\.py/.test(md);
  const harvested = [], skipped = [];
  for (const c of body.value || []) {
    if (!/^kind:\s*InlineAgentSkill/m.test(String(c.data || ''))) continue;
    const short = c.schemaname.startsWith(`${bot.schemaname}.`) ? c.schemaname.slice(bot.schemaname.length + 1) : c.schemaname;
    const name = short.replace(/^skill\./, '');
    const md = skillMarkdownFromComponentData(c.data);
    if (!md) { skipped.push({ name, why: 'no content' }); continue; }
    const fmName = (md.match(/^name:\s*"?([^"\n]+)"?/m) || [])[1]?.trim() || name;
    const dir = join(genomeDir, 'agents', fmName);
    if (isProjectionCard(md)) { skipped.push({ name: fmName, why: 'projection of a genome agent, not grown' }); continue; }
    if (have.has(fmName) || have.has(fmName.replace(/-/g, '')) || existsSync(join(dir, 'SKILL.md'))) { skipped.push({ name: fmName, why: 'already in the genome' }); continue; }
    if (!cfg.dryRun) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), md); }
    harvested.push({ name: fmName, dir, createdon: c.createdon });
    log(`[harvest] ${cfg.dryRun ? 'would write' : 'wrote'} ${join('agents', fmName, 'SKILL.md')} (grown on ${bot.schemaname} at ${c.createdon})`);
  }
  if (!harvested.length) log('[harvest] nothing new on the body');
  return { bot: bot.schemaname, genomeDir, harvested, skipped };
}
