// @ts-check
/**
 * Resolve copilot-harness-sdk: the installed package, or a checkout named by COPILOT_HARNESS_SDK
 * (the same variable the lab brainstem uses), or the usual sibling checkouts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

let cached;
export async function loadHarnessSdk() {
  if (cached) return cached;
  const candidates = [
    process.env.COPILOT_HARNESS_SDK,
    join(homedir(), 'Documents', 'GitHub', 'copilot-harness-sdk'),
    join(homedir(), 'Documents', 'GitHub', 'scratch', 'copilot-harness-sdk')
  ].filter(Boolean);
  try {
    cached = await import('copilot-harness-sdk');
    return cached;
  } catch (e) {
    for (const dir of candidates) {
      const entry = join(String(dir), 'index.js');
      if (existsSync(entry)) { cached = await import(pathToFileURL(entry).href); return cached; }
    }
    throw new Error(`copilot-harness-sdk not installed (npm install) and no checkout at COPILOT_HARNESS_SDK: ${e.message}`);
  }
}

export async function loadCopilotSdk() {
  try { return await import('@github/copilot-sdk'); }
  catch {
    const sdk = process.env.COPILOT_HARNESS_SDK || join(homedir(), 'Documents', 'GitHub', 'copilot-harness-sdk');
    const nested = join(sdk, 'node_modules', '@github', 'copilot-sdk', 'dist', 'index.js');
    if (existsSync(nested)) return import(pathToFileURL(nested).href);
    throw new Error('@github/copilot-sdk not installed (npm install)');
  }
}
