'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { captureAgentTask, resolveCapturedTask, runProcess } = require('../core/agent-task');

function parseRunArguments(argv) {
  const [cwd, taskId, prompt, ...rest] = argv;
  const separator = rest.indexOf('--');
  const optionValues = separator === -1 ? [] : rest.slice(0, separator);
  const commandValues = separator === -1 ? rest : rest.slice(separator + 1);
  if (separator === -1 && rest.some((value) => value.startsWith('--output=') || value.startsWith('--allow='))) {
    throw new Error('run options must precede a -- command separator');
  }
  if (optionValues.some((value) => !value.startsWith('--output=') && !value.startsWith('--allow='))) {
    throw new Error('usage: unknown run option');
  }
  const outputs = optionValues.filter((value) => value.startsWith('--output='));
  if (outputs.length > 1) throw new Error('run accepts at most one --output option');
  const output = outputs[0]?.slice('--output='.length);
  if (outputs.length && !output) throw new Error('--output must be non-empty');
  const allowedPaths = optionValues.filter((value) => value.startsWith('--allow=')).map((value) => value.slice('--allow='.length));
  if (allowedPaths.some((value) => !value)) throw new Error('--allow must be non-empty');
  const [command, ...args] = commandValues;
  return { cwd, taskId, prompt, command, args, output, allowedPaths };
}

async function writeArtifact(destination, artifact) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`);
}

async function captureCommandTask({ command, args = [], agentId = 'command-agent', ...options } = {}) {
  if (typeof command !== 'string' || command.trim() === '') throw new TypeError('command must be non-empty');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings');
  return captureAgentTask({ ...options, agentId, run: ({ cwd, prompt }) => runProcess(command, args, cwd, prompt) });
}

async function main(argv) {
  const mode = argv[0];
  if (mode === 'run') {
    const { cwd, taskId, prompt, command, args, output, allowedPaths } = parseRunArguments(argv.slice(1));
    const destination = path.resolve(output || `${taskId}.guard.json`);
    const artifact = await captureCommandTask({ cwd, taskId, prompt, command, args, artifactPath: destination, ...(allowedPaths.length ? { allowedPaths } : {}) });
    await writeArtifact(destination, artifact);
    console.log(JSON.stringify({ ok: artifact.task.status === 'awaiting_review', taskId, taskStatus: artifact.task.status, reviewRequired: artifact.review.required, artifact: destination }));
    return;
  }
  if (mode === 'resolve') {
    const [artifactPath, decision, reason, outputPath] = argv.slice(1);
    if (argv.length > 5) throw new Error('usage: too many resolve arguments');
    const artifact = await resolveCapturedTask({ artifactPath, decision, reason });
    await writeArtifact(path.resolve(outputPath || artifactPath), artifact);
    console.log(JSON.stringify({ ok: true, taskId: artifact.taskId, decision, taskStatus: artifact.task.status, reviewRequired: artifact.review.required }));
    return;
  }
  throw new Error('usage: guard-agent-task.js run <cwd> <taskId> <prompt> [--output=file] [--allow=path]... -- <command> [args...] | resolve <artifact> <decision> <reason> [output]');
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { captureCommandTask, main, parseRunArguments, writeArtifact };
