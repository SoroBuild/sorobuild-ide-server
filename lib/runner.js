import { fail } from './store.js';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateFiles, validatePath } from './workspace.js';

export function commandFor(action, manifest) {
  validatePath(manifest);
  if (action === 'build') return ['cargo', 'build', '--offline', '--manifest-path', manifest, '--target', 'wasm32v1-none', '--release'];
  if (action === 'format') return ['cargo', 'fmt', '--manifest-path', manifest, '--all'];
  if (action === 'test') return ['cargo', 'test', '--offline', '--manifest-path', manifest, '--', '--nocapture'];
  throw new Error('Unsupported operation');
}

export function runProcess(command, args, { timeout = 600000, maxOutput = 8 * 1024 * 1024, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeout);
    const append = chunk => {
      output += chunk.toString();
      onOutput?.(chunk.toString());
      if (Buffer.byteLength(output) > maxOutput) { output = output.slice(0, maxOutput); exceeded = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ success: code === 0 && !exceeded, output: output + (exceeded ? '\nJob exceeded its time or output limit.' : '') }); });
  });
}

export async function runJob(action, input, { onOutput } = {}) {
  const files = validateFiles(input.files);
  let command;
  try { command = commandFor(action, input.manifest); } catch (error) { throw fail(400, error.message); }
  if (!Object.hasOwn(files, input.manifest)) throw fail(400, 'Selected manifest is missing.');
  // Cargo configuration can override the toolchain or execute arbitrary runners.
  if (Object.keys(files).some(file => file.split('/').includes('.cargo') || /(^|\/)rust-toolchain(\.toml)?$/.test(file))) throw fail(400, 'Custom Cargo configuration and toolchains are not supported.');
  const jobsRoot = process.env.JOBS_DIR || tmpdir();
  await mkdir(jobsRoot, { recursive: true });
  const dir = await mkdtemp(path.join(jobsRoot, 'sorobuild-'));
  await chmod(dir, 0o755);
  const name = `sorobuild-${randomUUID()}`;
  try {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }
    let pending = '';
    const emit = line => { if (!line.startsWith('SOROBUILD_ARTIFACT:') && !line.startsWith('SOROBUILD_FORMAT:')) onOutput?.(line + '\n'); };
    const result = await runProcess('docker', [
      'run', '--rm', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=4g', '--cpus=2',
      '--user=65534:65534', '--tmpfs', '/tmp:rw,exec,nosuid,size=4g,mode=1777',
      '--mount', `type=bind,source=${dir},target=/input,readonly`,
      '-e', 'CARGO_TARGET_DIR=/tmp/target', '-e', 'CARGO_NET_OFFLINE=true',
      process.env.SOROBUILD_RUNNER_IMAGE || 'sorobuild-runner:25',
      ...command,
    ], { onOutput: chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) emit(line);
    } });
    if (pending) emit(pending);
    // The runner emits base64 WASM records after compilation, from inside its sandbox.
    const formatted = { ...files };
    result.output = result.output.replace(/^SOROBUILD_FORMAT:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]*)$/gm, (_, encoded, text) => {
      const file = Buffer.from(encoded, 'base64').toString();
      if (Object.hasOwn(files, file)) formatted[file] = Buffer.from(text, 'base64').toString();
      return '';
    });
    const artifacts = [];
    result.output = result.output.replace(/^SOROBUILD_ARTIFACT:([^:]+):([A-Za-z0-9+/=]+)$/gm, (_, name, wasm) => {
      if (artifacts.length < 32 && wasm.length < 4 * 1024 * 1024) artifacts.push({ name, wasm });
      return '';
    });
    return { ...result, artifacts: result.success ? artifacts : [], ...(action === 'format' && result.success ? { files: validateFiles(formatted) } : {}) };
  } finally {
    await runProcess('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
