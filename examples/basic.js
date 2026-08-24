'use strict';

const {
  MemoryPassport,
  ResultStore,
  relayExternalResult
} = require('..');

const relayed = relayExternalResult({
  agentId: 'researcher',
  result: { claim: 'The observation needs review.' }
});

const results = new ResultStore();
results.append(relayed.agentId, relayed.result);

const passport = new MemoryPassport();
passport.create({
  memoryId: 'finding-1',
  actorAgentId: relayed.agentId,
  content: relayed.result,
  source: { resultSequence: results.readAll()[0].sequence }
});
passport.dispute('finding-1', {
  actorAgentId: 'reviewer',
  reason: 'The supporting source is not attached.'
});

console.log(passport.formatTimeline('finding-1'));
