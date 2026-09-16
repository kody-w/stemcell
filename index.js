// @ts-check
/**
 * stemcell — the RAPP brainstem, wherever you need it.
 *
 *   import { shapeshift } from 'stemcell';
 *   const b = await shapeshift('sdk');                       // or 'http://localhost:7071', 'studio:<env>/<schema>', ...
 *   const { response } = await b.chat({ user_input: 'hi' });  // the RAPP wire, whatever the body
 */
export { shapeshift, parseSpec, BODIES } from './src/brainstem.js';
export { serve } from './src/serve.js';
export { prove, summarize } from './src/prove.js';
export { readGenome, defaultGenomeDir, describeGenome, findPython, runPython } from './src/genome.js';
export { buildStudioWorkspace, deployStudio, sanitizeSoulForStudio, portableToStudio, localClaim } from './src/studio-workspace.js';
export { buildFriend, friendInstructions } from './src/friend.js';
export { buildSelfGrowth, selfGrowthInstructions } from './src/grow-native.js';
export { harvest, skillMarkdownFromComponentData } from './src/harvest.js';
export { buildSolutionFolder, packSolution, importSolution, readSettings, readComponentYaml } from './src/solution.js';
export { growOnce, growWatch } from './src/grow.js';
export { createHttpBody } from './src/bodies/http.js';
export { createSdkBody } from './src/bodies/sdk.js';
export { createStudioBody } from './src/bodies/studio.js';
