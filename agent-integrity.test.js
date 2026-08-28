'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE_CONTEXT_FILES, loadBaseContext } = require('./context-loader');
const { relayExternalResult } = require('./relay');
const { ResultStore } = require('./result-store');

test('package entry point exposes the complete public API', () => {
  const api = require('.');
  assert.deepEqual(Object.keys(api).sort(), [
    'BASE_CONTEXT_FILES',
    'MemoryPassport',
    'ResultStore',
    'captureAgentTask',
    'captureCodexTask',
    'captureCommandTask',
    'loadArtifact',
    'loadBaseContext',
    'relayExternalResult',
    'resolveCapturedTask',
    'saveArtifact'
  ]);
});

test('every prompt mode loads the identical complete base context', async () => {
  for (const promptMode of ['default', 'compact', 'worker']) {
    const requested = [];
    const loaded = await loadBaseContext({
      promptMode,
      readFile: async (filename) => {
        requested.push(filename);
        return `content:${filename}`;
      }
    });
    assert.deepEqual(requested, BASE_CONTEXT_FILES);
    assert.deepEqual(loaded.map(({ filename }) => filename), BASE_CONTEXT_FILES);
  }
});

test('unknown prompt modes fail explicitly', async () => {
  await assert.rejects(
    loadBaseContext({ promptMode: 'mystery', readFile: async () => '' }),
    /Unsupported promptMode/
  );
});

test('context loading requires an injected reader', async () => {
  await assert.rejects(loadBaseContext({ promptMode: 'default' }), /readFile must be a function/);
});

test('relay does not invent URL or model identity', () => {
  const output = relayExternalResult({ agentId: 'agent-a', result: 'done' });
  assert.equal(Object.hasOwn(output, 'url'), false);
  assert.equal(Object.hasOwn(output, 'model'), false);
});

test('relay preserves explicitly supplied URL and model identity', () => {
  const output = relayExternalResult({
    agentId: 'agent-a',
    result: 'done',
    url: 'https://explicit.example/result/1',
    model: 'explicit-model'
  });
  assert.equal(output.url, 'https://explicit.example/result/1');
  assert.equal(output.model, 'explicit-model');
});

test('relay ignores inherited provenance fields', () => {
  const inherited = { url: 'https://inherited.example', model: 'inherited-model' };
  const input = Object.assign(Object.create(inherited), { agentId: 'agent-a', result: 'done' });
  const output = relayExternalResult(input);

  assert.deepEqual(output, { agentId: 'agent-a', result: 'done' });
});

test('relay requires an explicit agent identity and result', () => {
  assert.throws(() => relayExternalResult({ result: 'done' }), /input\.agentId/);
  assert.throws(() => relayExternalResult({ agentId: 'agent-a' }), /input\.result/);
  assert.throws(() => relayExternalResult({ agentId: '  ', result: 'done' }), /input\.agentId/);
});

test('relay returns a defensive copy of supplied values', () => {
  const input = {
    agentId: 'agent-a',
    result: { nested: { value: 'original' } },
    model: { name: 'explicit-model' }
  };
  const output = relayExternalResult(input);

  input.result.nested.value = 'changed input';
  output.model.name = 'changed output';
  assert.equal(output.result.nested.value, 'original');
  assert.equal(input.model.name, 'explicit-model');
});

test('agent partitions append without overwriting other agents', () => {
  const store = new ResultStore();
  store.append('agent-a', { value: 'a1' });
  store.append('agent-b', { value: 'b1' });
  store.append('agent-a', { value: 'a2' });

  assert.deepEqual(store.readAgent('agent-a').map((x) => x.event.value), ['a1', 'a2']);
  assert.deepEqual(store.readAgent('agent-b').map((x) => x.event.value), ['b1']);
});

test('full event reads retain global append order', () => {
  const store = new ResultStore();
  store.append('agent-a', { value: 1 });
  store.append('agent-b', { value: 2 });
  store.append('agent-a', { value: 3 });

  assert.deepEqual(store.readAll().map((x) => x.agentId), ['agent-a', 'agent-b', 'agent-a']);
  assert.deepEqual(store.readAll().map((x) => x.sequence), [1, 2, 3]);
});

test('returned event data cannot mutate stored results', () => {
  const store = new ResultStore();
  const source = { nested: { value: 'original' } };
  store.append('agent-a', source);
  source.nested.value = 'changed';
  const read = store.readAgent('agent-a');
  read[0].event.nested.value = 'also changed';

  assert.equal(store.readAgent('agent-a')[0].event.nested.value, 'original');
});

test('a rejected append does not consume a global sequence number', () => {
  const store = new ResultStore();
  assert.throws(() => store.append('agent-a', { unsupported: () => {} }), /clone/);

  const stored = store.append('agent-a', { value: 'first valid event' });
  assert.equal(stored.sequence, 1);
  assert.equal(store.readAll().length, 1);
});

test('result store rejects unusable agent identities consistently', () => {
  const store = new ResultStore();
  assert.throws(() => store.append('  ', { value: 1 }), /agentId/);
  assert.throws(() => store.readAgent('  '), /agentId/);
  assert.equal(store.readAll().length, 0);
});
