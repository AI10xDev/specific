import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'spec spaced-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'isolated worktree');
  for (const dir of [bin, home, cwd]) await mkdir(dir);
  const spec = path.join(bin, 'spec');
  await copyFile(new URL('./spec', import.meta.url), spec);
  const capture = path.join(root, 'capture.json');
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
setTimeout(() => {
  fs.writeFileSync(process.env.CAPTURE, JSON.stringify({
    binary: require('node:path').basename(process.argv[1]),
    args: process.argv.slice(2), cwd: process.cwd(),
    foreground: process.env.SPEC_BUILD_FOREGROUND,
  }));
  process.stdout.write('foreground finished');
  process.exit(Number(process.env.STUB_STATUS || 0));
}, 30);
`;
  for (const name of ['opencode', 'spec-eval', 'legacy-spec']) {
    await writeFile(path.join(bin, name), stub, { mode: 0o755 });
  }
  await writeFile(path.join(home, '.bash_aliases'), 'spec() { legacy-spec "$@"; }\n');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture,
    SPEC_BUILD_AUTO: '0', SPEC_BUILD_FOREGROUND: '0', STUB_STATUS: '0' };
  return { root, home, cwd, spec, capture, env,
    run: (args, overrides = {}) => spawnSync(spec, args, {
      cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5_000,
    }),
    captured: async () => JSON.parse(await readFile(capture, 'utf8')),
  };
}

test('auto build reads a spaced prompt path, awaits completion and returns the exact exit status', async (t) => {
  const mock = await fixture(t);
  // Auto mode must not depend on the external shell harness.
  await rm(path.join(mock.home, '.bash_aliases'));
  const promptPath = path.join(mock.root, 'private prompt.md');
  const prompt = '--literal prompt\nDo not expand $(exit 99), `exit 98`, "$HOME", or a * glob.';
  await writeFile(promptPath, prompt, { mode: 0o600 });
  for (const status of [0, 23]) {
    const result = mock.run(['build', promptPath], { SPEC_BUILD_AUTO: '1', STUB_STATUS: String(status) });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, 'foreground finished');
    assert.deepEqual(await mock.captured(), {
      binary: 'opencode', args: ['run', '--auto', '--dir', mock.cwd, '--agent', 'build', '--', prompt],
      cwd: mock.cwd, foreground: '0',
    });
  }
  const relative = mock.run(['build', '../private prompt.md'], { SPEC_BUILD_AUTO: '1' });
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal((await mock.captured()).args.at(-1), prompt);
});

test('auto build rejects missing, extra and non-file prompt arguments without dispatch', async (t) => {
  const mock = await fixture(t);
  for (const args of [['build'], ['build', 'one', 'two'], ['build', 'missing.md'], ['build', mock.cwd]]) {
    const result = mock.run(args, { SPEC_BUILD_AUTO: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Spec file is not readable/);
    await assert.rejects(readFile(mock.capture), { code: 'ENOENT' });
  }
});

test('ordinary editor and build calls retain harness dispatch and foreground failure propagation', async (t) => {
  const mock = await fixture(t);
  for (const [args, auto] of [[[], '0'], [['edit me.md'], '1'], [['build'], '0'], [['build', 'spec file.md'], 'true']]) {
    const result = mock.run(args, { SPEC_BUILD_AUTO: auto, SPEC_BUILD_FOREGROUND: '1', STUB_STATUS: '19' });
    assert.equal(result.status, 19, result.stderr);
    assert.equal(result.stdout, 'foreground finished');
    assert.deepEqual(await mock.captured(), { binary: 'legacy-spec', args, cwd: mock.cwd, foreground: '1' });
  }
});

test('eval aliases dispatch through the resolved wrapper even with auto mode enabled', async (t) => {
  const mock = await fixture(t);
  const link = path.join(mock.root, 'linked spec');
  await symlink(mock.spec, link);
  for (const command of ['eval', '--eval']) {
    const result = spawnSync(link, [command, '--repo', mock.cwd, '--offline'], {
      cwd: mock.cwd, env: { ...mock.env, SPEC_BUILD_AUTO: '1', STUB_STATUS: '17' }, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.status, 17, result.stderr);
    assert.deepEqual(await mock.captured(), {
      binary: 'spec-eval', args: ['--repo', mock.cwd, '--offline'], cwd: mock.cwd, foreground: '0',
    });
  }
});
