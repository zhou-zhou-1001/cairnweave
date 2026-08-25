#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { relayExternalResult, ResultStore, MemoryPassport } = require('..');

function requireAssets(bundle) {
  const assets = bundle && bundle.payload && bundle.payload.assets;
  if (!Array.isArray(assets)) throw new TypeError('bundle.payload.assets must be an array');
  const gene = assets.find((asset) => asset && asset.type === 'Gene');
  if (!gene) throw new Error('asset bundle must contain a Gene');
  if (!Array.isArray(gene.validation) || gene.validation.length === 0) {
    throw new Error('Gene validation must be a non-empty array');
  }
  return { assets, gene };
}

function runValidation(declaration, baseDirectory) {
  if (typeof declaration !== 'string') throw new TypeError('Gene validation entries must be strings');
  const match = /^bash -n ([A-Za-z0-9._/-]+)$/.exec(declaration);
  if (!match) throw new Error(`unsupported validation: ${declaration}`);

  const target = path.resolve(baseDirectory, match[1]);
  const relative = path.relative(baseDirectory, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`validation target escapes bundle directory: ${match[1]}`);
  }
  const exists = fs.existsSync(target);
  const result = exists
    ? spawnSync('bash', ['-n', target], { encoding: 'utf8' })
    : { status: null, stderr: 'referenced file does not exist' };
  return {
    declaration,
    referencedFile: match[1],
    referencedFileExists: exists,
    passed: exists && result.status === 0,
    error: exists && result.status === 0 ? null : String(result.stderr || 'validation failed').trim()
  };
}

function verifyAssetBundle(bundlePath) {
  const absoluteBundlePath = path.resolve(bundlePath);
  const bundle = JSON.parse(fs.readFileSync(absoluteBundlePath, 'utf8'));
  const { assets, gene } = requireAssets(bundle);
  const store = new ResultStore();
  const collected = relayExternalResult({
    agentId: 'evomap-collector',
    result: { sourceFile: path.basename(absoluteBundlePath), assetCount: assets.length, assets }
  });
  const collectedEvent = store.append(collected.agentId, collected);

  const checks = gene.validation.map((item) => runValidation(item, path.dirname(absoluteBundlePath)));
  const verdict = checks.every((check) => check.passed) ? 'verified' : 'not_verified';
  const verification = { checkedAsset: gene.asset_id, declaredValidation: gene.validation, checks, verdict };
  const verified = relayExternalResult({ agentId: 'asset-verifier', result: verification });
  const verifiedEvent = store.append(verified.agentId, verified);

  const passport = new MemoryPassport();
  const memoryId = `evomap-asset-${String(gene.asset_id || 'gene').replace(/^sha256:/, '').slice(0, 16)}`;
  passport.create({
    memoryId,
    actorAgentId: collected.agentId,
    content: { claim: 'The asset bundle passes its Gene-declared validation.', assetId: gene.asset_id },
    source: { resultSequence: collectedEvent.sequence, sourceFile: path.basename(absoluteBundlePath), note: 'not independently verified' }
  });
  passport.requestReview(memoryId, {
    actorAgentId: verified.agentId,
    reason: verdict === 'verified' ? 'Independent local validation passed.' : 'Independent local validation failed.',
    source: { resultSequence: verifiedEvent.sequence, checks }
  });
  passport.resolve(memoryId, {
    adjudicatorAgentId: verified.agentId,
    reason: verdict === 'verified' ? 'All supported declared checks passed.' : 'At least one declared check failed.',
    decision: verdict === 'verified' ? 'accept' : 'reject',
    source: { resultSequence: verifiedEvent.sequence, check: 'independent local verification' }
  });
  const current = passport.current(memoryId);

  return {
    input: path.basename(absoluteBundlePath),
    assetCount: assets.length,
    checkedAsset: gene.asset_id,
    verdict,
    checks,
    resultEvents: store.readAll().map(({ sequence, agentId }) => ({ sequence, agentId })),
    passport: {
      memoryId,
      status: current.status,
      decision: current.resolution.decision,
      eventTypes: passport.history(memoryId).map((event) => event.eventType)
    },
    timeline: passport.timeline(memoryId)
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node bin/guard-asset-verify.js <bundle.json>');
    const output = verifyAssetBundle(process.argv[2]);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.verdict !== 'verified') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ verdict: 'error', error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyAssetBundle };
