'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyAssetBundle } = require('./bin/guard-asset-verify');

function fixture(script = '#!/bin/sh\necho ok\n', validation = ['bash -n artifact.sh']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-asset-'));
  fs.writeFileSync(path.join(directory, 'artifact.sh'), script);
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify({ payload: { assets: [
    { type: 'Gene', asset_id: 'gene-1', validation },
    { type: 'Capsule', asset_id: 'sha256:capsule-1' }
  ] } }));
  return path.join(directory, 'bundle.json');
}

test('asset verifier executes validation declared on Gene and records review evidence', () => {
  const output = verifyAssetBundle(fixture());
  assert.equal(output.verdict, 'verified');
  assert.deepEqual(output.resultEvents.map(({ sequence, agentId }) => [sequence, agentId]), [
    [1, 'evomap-collector'], [2, 'asset-verifier']
  ]);
  assert.equal(output.checks[0].passed, true);
  assert.deepEqual(output.passport.eventTypes, ['create', 'review', 'resolve']);
  assert.equal(output.passport.status, 'resolved');
  assert.equal(output.passport.decision, 'accept');
});

test('asset verifier does not fall back to Capsule validation', () => {
  const bundlePath = fixture(undefined, []);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  bundle.payload.assets[1].validation = ['bash -n artifact.sh'];
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));
  assert.throws(() => verifyAssetBundle(bundlePath), /Gene validation/);
});

test('CLI emits structured failure JSON and exits non-zero', () => {
  const result = spawnSync(process.execPath, ['bin/guard-asset-verify.js', fixture('if then\n')], {
    cwd: __dirname, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict, 'not_verified');
  assert.equal(output.checks[0].passed, false);
});

test('asset verifier rejects unsupported validation commands without a shell', () => {
  assert.throws(() => verifyAssetBundle(fixture(undefined, ['rm -rf artifact.sh'])), /unsupported validation/);
});
