// Offline suite: no Copilot, no network beyond loopback, no credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSpec, shapeshift } from '../src/brainstem.js';
import { readGenome, findPython, runPython } from '../src/genome.js';
import { serve } from '../src/serve.js';
import { prove } from '../src/prove.js';
import { buildStudioWorkspace } from '../src/studio-workspace.js';
import { createHarnessBody } from '../src/bodies/harness.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'genome');

test('body specs parse into the five bodies', () => {
  assert.deepEqual(parseSpec('http://localhost:7071'), { body: 'http', url: 'http://localhost:7071' });
  assert.deepEqual(parseSpec('localhost:7081'), { body: 'http', url: 'http://localhost:7081' });
  assert.deepEqual(parseSpec('sdk'), { body: 'sdk', genome: undefined });
  assert.deepEqual(parseSpec('sdk:/tmp/g'), { body: 'sdk', genome: '/tmp/g' });
  assert.deepEqual(parseSpec('headless:localhost:4321'), { body: 'headless', runtimeUri: 'localhost:4321', genome: undefined });
  assert.deepEqual(parseSpec('headless:localhost:4321:/tmp/g'), { body: 'headless', runtimeUri: 'localhost:4321', genome: '/tmp/g' });
  assert.deepEqual(parseSpec('studio:env-1/rapp_X'), { body: 'studio', environmentId: 'env-1', schemaName: 'rapp_X' });
  assert.deepEqual(parseSpec('directline:env-1/rapp_X'), { body: 'directline', environmentId: 'env-1', schemaName: 'rapp_X' });
  assert.throws(() => parseSpec('nope'), /unknown body spec/);
  assert.throws(() => parseSpec('studio:justenv'), /studio spec must be/);
});

test('the genome reads soul, agent contracts (through python) and skills', async () => {
  const g = await readGenome(FIXTURE);
  assert.match(g.soul, /You are Fixture/);
  assert.equal(g.problems.length, 0, g.problems.join('; '));
  assert.deepEqual(g.agents.map((a) => a.name), ['Echo']);
  assert.equal(g.agents[0].parameters.required[0], 'text');
  assert.deepEqual(g.skills.map((s) => s.name), ['hello-skill']);
  assert.deepEqual(g.skillDirectories, [join(FIXTURE, 'agents')]);
});

test('an agent performs in python with the grail shims, stdout noise kept off the JSON line, user_guid in the environment', async () => {
  const python = findPython();
  assert.ok(python, 'python3 is required for this test');
  const file = join(FIXTURE, 'agents', 'echo_agent.py');
  const r = await runPython(python, ['perform', file, JSON.stringify({ text: 'hi there', extra: 'ignored' })], { cwd: FIXTURE, env: { BRAINSTEM_USER_GUID: 'twin-1' } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.result, 'ECHO: HI THERE (for twin-1)');
  assert.match(r.stderr, /stdout noise/);
  const bad = await runPython(python, ['perform', join(FIXTURE, 'soul.md'), '{}'], { cwd: FIXTURE });
  assert.match(bad.error, /not a python module|no BasicAgent/);
});

/** A fake brainstem speaking the RAPP wire, to stand in for the grail. */
function fakeBrainstem() {
  const seen = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', agents: ['Fake'], model: 'fake-1', version: '9.9.9' })); }
      const body = data ? JSON.parse(data) : {};
      seen.push({ url: req.url, body });
      if (req.url === '/chat') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ response: `fake says: ${body.user_input}`, session_id: body.session_id || 's', agent_logs: '', model: 'fake-1', requested_model: 'auto' })); }
      if (req.url === '/chat/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'delta', text: 'fake ' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'agent', logs: '[Fake] ran' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'delta', text: 'streams' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', response: 'fake streams', session_id: body.session_id || 's', model: 'fake-1' })}\n\n`);
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) })));
}

test('http body passes the RAPP wire through, both ways, chat and stream', async () => {
  const fake = await fakeBrainstem();
  try {
    const b = await shapeshift(fake.url);
    assert.equal(b.kind, 'http');
    const out = await b.chat({ user_input: 'ping', session_id: 'abc', user_guid: 'twin-1' });
    assert.equal(out.response, 'fake says: ping');
    assert.equal(fake.seen[0].body.user_guid, 'twin-1');
    const frames = [];
    for await (const f of b.stream({ user_input: 'ping', session_id: 'abc' })) frames.push(f);
    assert.deepEqual(frames.map((f) => f.type), ['delta', 'agent', 'delta', 'done']);
    assert.equal(frames[3].response, 'fake streams');
    assert.equal((await b.health()).ok, true);
  } finally { await fake.close(); }
});

test('serve() puts the RAPP wire and the grail page in front of any body', async () => {
  const fake = await fakeBrainstem();
  const b = await shapeshift(fake.url);
  const s = await serve(b, { port: 0, log: () => {} });
  try {
    const health = await (await fetch(`${s.url}/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.body, 'http');
    assert.deepEqual(health.agents, ['Fake']);
    const chat = await (await fetch(`${s.url}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_input: 'hello', session_id: 'x' }) })).json();
    assert.equal(chat.response, 'fake says: hello');
    assert.equal(chat.session_id, 'x');
    const sse = await (await fetch(`${s.url}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_input: 'hello' }) })).text();
    assert.match(sse, /"type":"delta"/);
    assert.match(sse, /"type":"done"/);
    const page = await (await fetch(`${s.url}/`)).text();
    assert.match(page, /<html/i);
    for (const path of ['/login/status', '/models', '/voice', '/agents', '/version', '/diagnostics/book.json']) assert.equal((await fetch(s.url + path)).status, 200, path);
    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
  } finally { await s.close(); await fake.close(); }
});

test('prove() runs the same turns on every body and records parity', async () => {
  const fake = await fakeBrainstem();
  try {
    const proof = await prove([fake.url, 'nope:spec'], [{ prompt: 'ping', expect: ['fake says: ping'] }, { prompt: 'x', expect: ['never'] }], { log: () => {} });
    assert.equal(proof.ok, false);
    assert.equal(proof.bodies[0].passed, 1);
    assert.equal(proof.bodies[0].total, 2);
    assert.equal(proof.bodies[0].turns[1].checks[0].ok, false);
    assert.match(proof.bodies[1].setupError, /unknown body spec/);
  } finally { await fake.close(); }
});

test('harness bodies map the SDK event stream onto the grail frames, fold history into the first turn, serialize per session', async () => {
  const sent = [];
  const fakeClient = {
    capabilities: () => ({ model: 'fake-model' }),
    async createSession({ sessionId }) {
      return {
        async *stream(prompt) {
          sent.push({ sessionId, prompt });
          yield { type: 'status', text: 'thinking' };
          yield { type: 'tool.start', id: 't1', name: 'Echo', args: { text: 'hi' } };
          yield { type: 'tool.end', id: 't1', name: 'Echo', success: true };
          yield { type: 'text.delta', delta: 'Hel', snapshot: 'Hel' };
          yield { type: 'text.delta', delta: 'lo', snapshot: 'Hello' };
          yield { type: 'text.final', text: 'Hello!' };
          yield { type: 'idle', text: 'Hello!' };
        },
        async close() {}
      };
    },
    async close() {}
  };
  const body = createHarnessBody({ kind: 'fake', label: 'fake', capabilities: () => ({}), createClient: async () => fakeClient });
  const frames = [];
  for await (const f of body.stream({ user_input: 'hi', session_id: 's1', conversation_history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'yes' }] })) frames.push(f);
  assert.deepEqual(frames.map((f) => f.type), ['agent', 'delta', 'delta', 'delta', 'done']);
  assert.equal(frames.at(-1).response, 'Hello!');
  assert.equal(frames.at(-1).model, 'fake-model');
  assert.match(frames.at(-1).agent_logs, /\[Echo\] \{"text":"hi"\}/);
  assert.match(sent[0].prompt, /^<conversation_history>\nUser: earlier\nAssistant: yes\n<\/conversation_history>\n\nhi$/);
  const again = await body.chat({ user_input: 'again', session_id: 's1' });
  assert.equal(sent[1].prompt, 'again', 'history folds into the first turn only');
  assert.equal(again.session_id, 's1');
  await body.close();
});

test('a genome projects onto a Copilot Studio harness workspace, with or without the bridge', async () => {
  const g = await readGenome(FIXTURE);
  const workDir = mkdtempSync(join(tmpdir(), 'stemcell-'));
  const plain = await buildStudioWorkspace(g, { name: 'Fixture Twin', schemaName: 'rapp_FixtureTwin', workDir });
  assert.ok(existsSync(join(plain.workspace, 'settings.mcs.yml')));
  const settings = readFileSync(join(plain.workspace, 'settings.mcs.yml'), 'utf8');
  assert.match(settings, /template: cliagent-1\.0\.0/);
  assert.match(settings, /kind: CLICopilotRecognizer/);
  assert.match(settings, /You are Fixture, a test brainstem/);
  assert.deepEqual(plain.components.map((c) => c.name).sort(), ['echo', 'hello-skill']);
  assert.match(readFileSync(join(plain.workspace, 'behaviors', 'hello-skill.mcs.yml'), 'utf8'), /kind: InlineAgentSkill[\s\S]*Reply with exactly/);
  assert.match(readFileSync(join(plain.workspace, 'behaviors', 'echo.mcs.yml'), 'utf8'), /class EchoAgent/);
  const bridged = await buildStudioWorkspace(g, { name: 'Fixture Twin', schemaName: 'rapp_FixtureTwin', workDir, bridgeUrl: 'shared_rapp-brainstem-5f1234' });
  assert.deepEqual(bridged.components.map((c) => c.kind).sort(), ['InlineAgentSkill', 'McpTool']);
  const tool = readFileSync(join(bridged.workspace, 'capabilities', 'tools', 'RAPPBrainstem.mcs.yml'), 'utf8');
  assert.match(tool, /kind: McpTool[\s\S]*connectorId: shared_rapp-brainstem-5f1234[\s\S]*operationId: InvokeMCP/);
  assert.ok(existsSync(join(bridged.workspace, 'infrastructure', 'connections', 'rapp_FixtureTwin.cr.brainstem.sync.yaml')));
  assert.ok(!existsSync(join(bridged.workspace, 'behaviors', 'echo.mcs.yml')), 'with the bridge nothing is ported');
});

test('with a friend, agents route through a connectionless Phone-a-friend flow and growth is a capability card', async () => {
  const g = await readGenome(FIXTURE);
  const workDir = mkdtempSync(join(tmpdir(), 'stemcell-'));
  const built = await buildStudioWorkspace(g, { name: 'Fixture Twin', schemaName: 'rapp_FixtureTwin', workDir, friend: { url: 'https://friend.example.com/' } });
  assert.deepEqual(built.components.map((c) => c.kind).sort(), ['InlineAgentSkill', 'InlineAgentSkill', 'WorkflowTool']);
  const tool = readFileSync(join(built.workspace, 'capabilities', 'tools', 'PhoneAFriend.mcs.yml'), 'utf8');
  assert.match(tool, /kind: WorkflowTool[\s\S]*name: user_input[\s\S]*name: response/);
  const wfDir = readdirSync(join(built.workspace, 'workflows'))[0];
  const wf = JSON.parse(readFileSync(join(built.workspace, 'workflows', wfDir, 'workflow.json'), 'utf8'));
  assert.equal(wf.properties.definition.actions.Phone_friend.inputs.uri, 'https://friend.example.com/chat');
  assert.equal(wf.properties.definition.actions.Phone_friend.inputs.method, 'POST');
  assert.equal(wf.properties.definition.triggers.manual.kind, 'Skills');
  assert.equal(wf.properties.definition.actions.Respond.kind, 'Skills');
  assert.match(readFileSync(join(built.workspace, 'workflows', wfDir, 'metadata.yml'), 'utf8'), new RegExp(`workflowId: ${built.components.find((c) => c.kind === 'WorkflowTool').workflowId}`));
  assert.match(readFileSync(join(built.workspace, 'settings.mcs.yml'), 'utf8'), /Use LearnNew to create a new agent/);
  assert.match(readFileSync(join(built.workspace, 'behaviors', 'echo.mcs.yml'), 'utf8'), /Phone a friend[\s\S]*runs the Echo agent for real/);
  assert.ok(!/class EchoAgent/.test(readFileSync(join(built.workspace, 'behaviors', 'echo.mcs.yml'), 'utf8')), 'no code is ported when a friend executes');
});
