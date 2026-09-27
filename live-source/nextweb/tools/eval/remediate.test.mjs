import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { remediate } from './remediate.mjs';

const head = 'a'.repeat(40);
const secret = 'DO-NOT-EXPOSE-SECRET';
const report = { substantial: true, repository: { head }, findings: [{ id: 'auth-regression', evidence: { failures: 15 } }] };
const fixtureReport = { substantial: false, fixturePass: true, repository: { head }, fixtures: [
  { id: 'database', hypothesis: 'Database retries are bounded', observation: { status: 'unmeasured' } },
  { id: 'security', hypothesis: 'Expired sessions are rejected', observation: { status: 'unmeasured' } },
] };
const source = 'qore-nextjs/src/lib/auth.ts';
const regression = 'qore-nextjs/src/lib/auth.test.ts';
const checks = ['test:auth', 'test:subscription', 'test:tts', 'test:signup', 'test:ledger'];
const spec = fileURLToPath(new URL('./spec', import.meta.url));

async function fixture(t, settings = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'remediate spaced-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const logDir = path.join(root, 'logs');
  await mkdir(repo);
  const calls = [];
  let worktree;
  let branch;
  let agentRan = false;
  const files = settings.files ?? { [source]: 'export const authorized = true;\n', [regression]: 'export const regression = true;\n' };
  const run = async (binary, args, options) => {
    calls.push({ binary, args, ...options });
    assert.equal(options.timeout, binary === 'git' ? 45_000 : binary === spec ? 600_000
      : binary === 'npm' && args[0] === 'ci' ? 300_000 : 120_000);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    if (settings.fail?.(binary, args, options)) {
      throw Object.assign(new Error(`stderr ${secret}`), { stdout: `stdout ${secret}` });
    }
    let stdout = '';
    if (binary === 'git') {
      if (args[0] === 'status') {
        assert.ok(args.includes('--ignore-submodules=none'));
        assert.ok(args.includes('-z'));
        stdout = options.cwd === repo
          ? (agentRan ? settings.laterDirty : settings.dirty) ?? ''
          : agentRan ? settings.status ?? Object.keys(files).map((file) => `?? ${file}\0`).join('') : '';
      } else if (args[0] === 'branch') {
        stdout = options.cwd === repo ? settings.branch ?? 'main' : branch;
      } else if (args[0] === 'rev-parse') {
        stdout = args[1] === 'origin/main' ? settings.remote ?? head
          : options.cwd === repo ? settings.head ?? head : settings.agentHead ?? head;
      } else if (args[0] === 'worktree') {
        assert.deepEqual(args.slice(0, 3), ['worktree', 'add', '--detach']);
        assert.equal(args[4], head);
        worktree = args[3];
        await mkdir(path.join(worktree, 'qore-nextjs/src/lib'), { recursive: true });
      } else if (args[0] === 'switch') {
        assert.equal(options.cwd, worktree);
        branch = args[2];
      } else if (args[0] === 'diff' && args.includes('--name-only')) {
        stdout = settings.staged ?? Object.keys(files).filter((file) => files[file] !== null).map((file) => `${file}\0`).join('');
      }
    } else if (binary === spec) {
      assert.equal(args.length, 2);
      assert.equal(args[0], 'build');
      assert.equal(options.cwd, worktree);
      assert.equal(options.env.SPEC_BUILD_AUTO, '1');
      assert.equal(options.env.SPEC_BUILD_FOREGROUND, '1');
      assert.equal(path.dirname(args[1]), logDir);
      assert.equal((await stat(args[1])).mode & 0o777, 0o600);
      assert.match(await readFile(args[1], 'utf8'), /untrusted data/);
      agentRan = true;
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(worktree, file);
        await mkdir(path.dirname(target), { recursive: true });
        if (content !== null) await writeFile(target, content);
      }
      if (settings.symlink) await symlink(path.join(repo, 'outside.ts'), path.join(worktree, settings.symlink));
      stdout = `Agent output ${secret}`;
    }
    return { stdout };
  };
  return { calls, repo, logDir, run, input: { repo, logDir, report, env: { EVAL_AUTO_FIX: '1' } } };
}

test('disabled by default, exact opt-in required, and no substantial finding needs no runner', async () => {
  const run = () => assert.fail('Runner must not be called');
  for (const env of [{}, { EVAL_AUTO_FIX: 'true' }, { EVAL_AUTO_FIX: 1 }, { EVAL_AUTO_FIX: '0' }]) {
    assert.deepEqual(await remediate({ report, env }, run), { status: 'disabled' });
  }
  for (const evidence of [undefined, { ...report, substantial: false }, { ...report, findings: [] }]) {
    assert.deepEqual(await remediate({ report: evidence, env: { EVAL_AUTO_FIX: '1' } }, run), { status: 'not-needed' });
  }
  for (const evidence of [{ ...report, repository: { head: '--bad' } }, { ...report, findings: [{}] }]) {
    assert.equal((await remediate({ report: evidence, env: { EVAL_AUTO_FIX: '1' } }, run)).status, 'blocked');
  }
});

test('refuses dirty tracked/untracked/staged/submodule state, other branches and stale heads', async (t) => {
  for (const settings of [
    { dirty: ' M existing.ts\0' }, { dirty: '?? existing.ts\0' }, { dirty: 'M  existing.ts\0' },
    { dirty: ' m TalkingHead\0' }, { dirty: ' ? TalkingHead\0' },
    { branch: 'feature/user-work' }, { branch: '' }, { head: 'b'.repeat(40) },
    { remote: 'b'.repeat(40) },
  ]) {
    const mock = await fixture(t, settings);
    const result = await remediate(mock.input, mock.run);
    assert.equal(result.status, 'blocked');
    assert.ok(mock.calls.every(({ binary, args }) => binary === 'git' && !['worktree', 'switch', 'add', 'commit', 'push'].includes(args[0])));
    if (settings.remote) {
      assert.ok(mock.calls.findIndex(({ args }) => args[0] === 'fetch') < mock.calls.findIndex(({ args }) => args[1] === 'origin/main'));
    }
  }
});

test('fixture-only requests require exact opt-in, nonempty valid fixtures and a valid head before any runner call', async () => {
  const run = () => assert.fail('Runner must not be called');
  for (const env of [{}, { EVAL_AUTO_FIX: 'true' }, { EVAL_AUTO_FIX: '0' }]) {
    assert.deepEqual(await remediate({ report: fixtureReport, env }, run), { status: 'disabled' });
  }
  for (const overrides of [
    { fixturePass: undefined }, { fixturePass: 'true' }, { fixturePass: false },
    { fixtures: undefined }, { fixtures: [] }, { fixtures: {} }, { fixtures: 'fixture' },
    { substantial: true },
  ]) {
    assert.deepEqual(await remediate({ report: { ...fixtureReport, ...overrides }, env: { EVAL_AUTO_FIX: '1' } }, run),
      { status: 'not-needed' });
  }
  for (const overrides of [
    { repository: undefined }, { repository: { head: '--bad' } },
    { fixtures: [null] }, { fixtures: [{}] }, { fixtures: [{ id: ' ' }] }, { fixtures: [{ id: 1 }] },
  ]) {
    assert.equal((await remediate({ report: { ...fixtureReport, ...overrides }, env: { EVAL_AUTO_FIX: '1' } }, run)).status, 'blocked');
  }
});

test('fixture-only passes publish test files without findings through all independent gates', async (t) => {
  const component = 'qore-nextjs/src/components/session fixture.test.tsx';
  for (const findings of [undefined, []]) {
    const mock = await fixture(t, { files: { [regression]: 'test();', [component]: 'test();' } });
    mock.input.report = { ...fixtureReport, findings };
    const result = await remediate(mock.input, mock.run);
    assert.match(result.branch, /^eval\/fixtures-\d+$/);
    assert.deepEqual(result, { status: 'published', branch: result.branch, mode: 'fixtures' });
    const agent = mock.calls.find(({ binary }) => binary === spec);
    const id = result.branch.slice('eval/fixtures-'.length);
    assert.equal(agent.cwd, path.join(mock.logDir, `fix-${id}`));
    assert.deepEqual(agent.args, ['build', path.join(mock.logDir, `remediation-${id}.md`)]);
    const prompt = await readFile(agent.args[1], 'utf8');
    assert.match(prompt, /Implement and execute deterministic LOCAL existing-behavior evaluation fixtures/);
    assert.match(prompt, /Do not change production source or any non-test file/);
    assert.match(prompt, /No before-fix failure is required/);
    assert.match(prompt, /Never fabricate production metrics/);
    assert.doesNotMatch(prompt, /must fail before the fix|If no reproducible defect is established/);
    const evidence = JSON.parse(prompt.split('Evidence report (sensitive fields redacted):\n')[1]);
    assert.equal(evidence.substantial, false);
    assert.deepEqual(evidence.fixtures, fixtureReport.fixtures);
    assert.deepEqual(mock.calls.filter(({ binary }) => binary === 'npm').map(({ args }) => args), [
      ['ci', '--ignore-scripts'], ...checks.map((script) => ['run', script]),
    ]);
    assert.deepEqual(mock.calls.filter(({ binary }) => binary === 'npx').map(({ args }) => args), [
      ['--no-install', 'tsx', '--test', 'src/lib/auth.test.ts', 'src/components/session fixture.test.tsx'],
      ['--no-install', 'tsc', '--noEmit'],
    ]);
    const commit = mock.calls.findIndex(({ args }) => args[0] === 'commit');
    assert.deepEqual(mock.calls[commit].args, ['commit', '-m', 'test(eval): add hypothesis evaluation fixtures']);
    assert.ok(mock.calls.filter(({ binary }) => binary === 'npm' || binary === 'npx').every((call) => mock.calls.indexOf(call) < commit));
    assert.deepEqual(mock.calls.find(({ args }) => args[0] === 'push').args, ['push', 'origin', `HEAD:refs/heads/${result.branch}`]);
  }
});

test('fixture-only validation rejects production edits, deletions, renames and tests outside src', async (t) => {
  const existing = 'qore-nextjs/src/lib/existing.test.ts';
  for (const settings of [
    {},
    { files: { [regression]: 'test();', [source]: null }, status: `?? ${regression}\0 D ${source}\0` },
    { files: { [regression]: 'test();' }, status: `R  ${regression}\0${source}\0` },
    { files: { 'qore-nextjs/outside.test.ts': 'test();' } },
    { files: { [regression]: null }, status: ` D ${regression}\0` },
    { files: { [regression]: 'test();', [existing]: null }, status: `?? ${regression}\0 D ${existing}\0` },
    { files: { [regression]: 'test();', [existing]: null }, status: `?? ${regression}\0D  ${existing}\0` },
    { files: { [regression]: 'test();' }, status: `R  ${regression}\0${existing}\0` },
  ]) {
    const mock = await fixture(t, settings);
    mock.input.report = fixtureReport;
    const result = await remediate(mock.input, mock.run);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'Remediation change validation failed.');
    assert.ok(!mock.calls.some(({ args }) => ['add', 'commit', 'push'].includes(args[0])));
  }
});

test('fixture-only passes preserve source cleanliness gates and independent test failure propagation', async (t) => {
  for (const settings of [
    { dirty: ' M user-change.ts\0' }, { laterDirty: ' M user-change.ts\0' },
    { branch: 'feature/user-work' }, { remote: 'b'.repeat(40) },
    { fail: (binary, args) => binary === 'npx' && args[1] === 'tsx' },
  ]) {
    const mock = await fixture(t, { ...settings, files: { [regression]: 'test();' } });
    mock.input.report = fixtureReport;
    const result = await remediate(mock.input, mock.run);
    assert.equal(result.status, settings.fail ? 'failed' : 'blocked');
    if (settings.fail) assert.equal(result.reason, 'Independent remediation checks failed.');
    if (!settings.laterDirty && !settings.fail) assert.ok(!mock.calls.some(({ binary }) => binary === spec));
    assert.ok(!mock.calls.some(({ args }) => ['add', 'commit', 'push'].includes(args[0])));
  }
});

test('publishes only the isolated branch after independent gates and logs stdout privately', async (t) => {
  const mock = await fixture(t);
  const result = await remediate(mock.input, mock.run);
  assert.equal(result.status, 'published');
  assert.equal(Object.hasOwn(result, 'mode'), false);
  assert.match(result.branch, /^eval\/fix-\d+$/);
  const index = (binary, command) => mock.calls.findIndex((call) => call.binary === binary && call.args[0] === command);
  const agent = mock.calls[index(spec, 'build')];
  const worktree = agent.cwd;
  assert.equal(worktree, path.join(mock.logDir, result.branch.replace('eval/', '')));
  const promptPath = path.join(mock.logDir, `remediation-${result.branch.slice('eval/fix-'.length)}.md`);
  assert.deepEqual(agent.args, ['build', promptPath]);
  const prompt = await readFile(promptPath, 'utf8');
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /Do not commit, push, deploy/);
  assert.match(prompt, /auth-regression/);
  assert.match(prompt, /Implement a deterministic regression fixture/);
  assert.match(prompt, /fail before the fix and pass after/);
  assert.match(prompt, /If no reproducible defect is established, leave the code unchanged/);
  assert.equal(mock.input.env.SPEC_BUILD_AUTO, undefined);
  assert.ok(mock.calls.every(({ binary, env }) => binary === spec || env === mock.input.env));
  assert.ok(!mock.calls.some(({ binary }) => binary === 'opencode'));
  assert.deepEqual(mock.calls.filter(({ binary }) => binary === 'npm').map(({ args }) => args), [
    ['ci', '--ignore-scripts'], ...checks.map((script) => ['run', script]),
  ]);
  assert.ok(index('npm', 'ci') < index(spec, 'build'));
  for (const call of mock.calls.filter(({ binary }) => binary === 'npm' || binary === 'npx')) {
    assert.equal(call.cwd, path.join(worktree, 'qore-nextjs'));
    if (call.args[0] !== 'ci') assert.ok(mock.calls.indexOf(call) > index(spec, 'build') && mock.calls.indexOf(call) < index('git', 'add'));
  }
  assert.deepEqual(mock.calls.filter(({ binary }) => binary === 'npx').map(({ args }) => args), [
    ['--no-install', 'tsx', '--test', 'src/lib/auth.test.ts'],
    ['--no-install', 'tsc', '--noEmit'],
  ]);
  const gates = mock.calls.filter(({ binary, args }) => binary === 'npx' || binary === 'npm' && args[0] === 'run');
  assert.equal(gates.length, 7);
  assert.equal(gates.reduce((total, { timeout }) => total + timeout, 0), 14 * 60_000);
  assert.ok(mock.calls.reduce((total, { timeout }) => total + timeout, 0) < 50 * 60_000);
  assert.deepEqual(mock.calls[index('git', 'add')].args, ['add', '--', source, regression]);
  assert.deepEqual(mock.calls[index('git', 'commit')].args, ['commit', '-m', 'fix(eval): address observed production regression']);
  assert.deepEqual(mock.calls[index('git', 'push')].args, ['push', 'origin', `HEAD:refs/heads/${result.branch}`]);
  assert.ok(index('git', 'commit') > index('git', 'add'));
  for (const args of [
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    ['diff', head, '--'], ['log', '--oneline', '-10'],
  ]) {
    const inspection = mock.calls.findIndex((call) => call.binary === 'git' && call.cwd === worktree
      && JSON.stringify(call.args) === JSON.stringify(args));
    assert.ok(inspection > index(spec, 'build') && inspection < index('git', 'add'));
  }
  assert.ok(index('git', 'push') > index('git', 'commit'));
  assert.ok(mock.calls.some(({ binary, args }) => binary === 'git' && args.join(' ') === `diff --check ${head} --`));
  assert.ok(mock.calls.some(({ args }) => args.join(' ') === 'diff --cached --check'));
  for (const call of mock.calls.filter(({ args }) => ['switch', 'add', 'commit', 'push'].includes(args[0]))) assert.equal(call.cwd, worktree);
  assert.ok(mock.calls.every(({ args }) => !args.includes('--force') && !['reset', 'checkout', 'clean'].includes(args[0])));
  const log = path.join(mock.logDir, `remediation-${result.branch.slice('eval/fix-'.length)}.log`);
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  assert.equal(await readFile(log, 'utf8'), `Agent output ${secret}`);
  assert.ok((await stat(worktree)).isDirectory());
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('awaits attempt persistence before creating a worktree and fails closed on rejection', async (t) => {
  for (const reject of [false, true]) {
    const mock = await fixture(t);
    const attempts = [];
    let persisted = false;
    const started = Date.now();
    mock.input.onAttempt = async (attempt) => {
      attempts.push(attempt);
      assert.ok(!mock.calls.some(({ args }) => args[0] === 'worktree'));
      await new Promise((resolve) => setImmediate(resolve));
      if (reject) throw new Error(secret);
      persisted = true;
    };
    const result = await remediate(mock.input, async (binary, args, options) => {
      if (args[0] === 'worktree') assert.equal(persisted, true);
      return mock.run(binary, args, options);
    });
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0], { status: 'in-progress', branch: result.branch, at: attempts[0].at });
    assert.match(result.branch, /^eval\/fix-\d+$/);
    assert.equal(new Date(attempts[0].at).toISOString(), attempts[0].at);
    assert.ok(Date.parse(attempts[0].at) >= started && Date.parse(attempts[0].at) <= Date.now());
    assert.equal(result.status, reject ? 'failed' : 'published');
    if (reject) {
      assert.equal(result.reason, 'Attempt persistence failed.');
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.ok(mock.calls.every(({ binary, args }) => binary === 'git' && !['worktree', 'switch', 'add', 'commit', 'push'].includes(args[0])));
      await assert.rejects(stat(mock.logDir), { code: 'ENOENT' });
    }
  }
});

test('runs every changed present regression test explicitly in one bounded gate; failure prevents publication', async (t) => {
  const component = 'qore-nextjs/src/components/new regression.test.tsx';
  const deleted = 'qore-nextjs/src/lib/deleted.test.ts';
  for (const fail of [false, true]) {
    const mock = await fixture(t, {
      files: { [source]: 'export const fixed = true;', [regression]: 'test();', [component]: 'test();', [deleted]: null },
      status: ` M ${source}\0?? ${regression}\0?? ${component}\0 D ${deleted}\0`,
      fail: (binary, args) => fail && binary === 'npx' && args[1] === 'tsx',
    });
    const result = await remediate(mock.input, mock.run);
    const gates = mock.calls.filter(({ binary, args }) => binary === 'npx' && args[1] === 'tsx');
    assert.equal(gates.length, 1);
    assert.deepEqual(gates[0].args, ['--no-install', 'tsx', '--test', 'src/lib/auth.test.ts', 'src/components/new regression.test.tsx']);
    assert.equal(gates[0].timeout, 120_000);
    const worktree = mock.calls.find(({ args }) => args[0] === 'worktree').args[3];
    assert.equal(gates[0].cwd, path.join(worktree, 'qore-nextjs'));
    const validation = mock.calls.findIndex(({ args }) => args.join(' ') === `diff --check ${head} --`);
    assert.ok(validation >= 0 && validation < mock.calls.indexOf(gates[0]));
    assert.equal(result.status, fail ? 'failed' : 'published');
    if (fail) {
      assert.equal(result.reason, 'Independent remediation checks failed.');
      assert.ok(!mock.calls.some(({ args }) => ['add', 'commit', 'push'].includes(args[0])));
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  }
});

test('redacts sensitive evidence fields, known environment secrets and credential text', async (t) => {
  const mock = await fixture(t);
  mock.input.env.API_TOKEN = secret;
  mock.input.report = { ...report,
    repository: { head, evidence: { database: ['src/lib/db.ts'], token: secret } },
    hypotheses: [{ id: 'auth-regression', hypothesis: 'Authorization rejects expired sessions', detail: secret }],
    findings: [{
      id: 'auth-regression', token: 'unknown-secret',
      evidenceRefs: ['logs/eval/prior-window.json'],
      evidence: `${secret} token="inline-secret" Bearer bearer-secret https://user:pass@example.com/path?key=url-secret`,
      detail: '-----BEGIN RSA PRIVATE KEY-----\nprivate-material\n-----END RSA PRIVATE KEY-----',
    }] };
  assert.equal((await remediate(mock.input, mock.run)).status, 'published');
  const prompt = await readFile(mock.calls.find(({ binary }) => binary === spec).args[1], 'utf8');
  assert.match(prompt, /src\/lib\/db.ts/);
  assert.match(prompt, /Authorization rejects expired sessions/);
  assert.match(prompt, /logs\/eval\/prior-window.json/);
  for (const value of [secret, 'unknown-secret', 'inline-secret', 'bearer-secret', 'user:pass', 'url-secret', 'private-material']) {
    assert.ok(!prompt.includes(value), value);
  }
});

test('prompt persistence fails closed without overwriting existing files or following symlinks', async (t) => {
  for (const linked of [false, true]) {
    const mock = await fixture(t);
    let existing;
    const result = await remediate(mock.input, async (binary, args, options) => {
      const result = await mock.run(binary, args, options);
      if (binary === 'npm' && args[0] === 'ci') {
        const id = path.basename(path.dirname(options.cwd)).slice('fix-'.length);
        const promptPath = path.join(mock.logDir, `remediation-${id}.md`);
        existing = linked ? path.join(mock.repo, 'user-file.md') : promptPath;
        await writeFile(existing, 'existing private content');
        if (linked) await symlink(existing, promptPath);
      }
      return result;
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'Remediation prompt persistence failed.');
    assert.equal(await readFile(existing, 'utf8'), 'existing private content');
    assert.ok(!mock.calls.some(({ binary, args }) => binary === spec || ['add', 'commit', 'push'].includes(args[0])));
  }
});

test('additional hypothesis evidence remains size bounded before dispatch', async (t) => {
  const mock = await fixture(t);
  mock.input.report = { ...report, hypotheses: [{ hypothesis: 'x '.repeat(32_000) }] };
  const result = await remediate(mock.input, mock.run);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'Remediation evidence is too large.');
  assert.ok(!mock.calls.some(({ binary }) => binary === spec));
});

test('rejects disallowed paths, absent/deleted tests, symlinks, history changes and secret-like files', async (t) => {
  for (const settings of [
    { files: { [source]: 'export const fixed = true;' } },
    { files: { [regression]: null }, status: ` D ${regression}\0` },
    { files: { 'qore-nextjs/package.json': '{}', [regression]: 'test();' } },
    { files: { 'qore-nextjs/src/../outside.test.ts': 'test();' } },
    { files: { [regression]: 'const token = "hardcoded-value";' } },
    { files: { [regression]: '// TOKEN=unquoted-secret-value' } },
    { files: { [regression]: '// PRIVATE KEY' } },
    { files: { [regression]: null }, symlink: regression },
    { agentHead: 'b'.repeat(40) },
    { status: `UU ${regression}\0` },
  ]) {
    const mock = await fixture(t, settings);
    const result = await remediate(mock.input, mock.run);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'Remediation change validation failed.');
    assert.ok(!mock.calls.some(({ binary, args }) => binary === 'npm' && args[0] === 'run'));
    assert.ok(!mock.calls.some(({ args }) => ['add', 'commit', 'push'].includes(args[0])));
  }
});

test('handles NUL-delimited rename paths and whitespace without shell splitting', async (t) => {
  const renamed = 'qore-nextjs/src/lib/new name.test.tsx';
  const old = 'qore-nextjs/src/lib/old name.test.tsx';
  const mock = await fixture(t, { files: { [renamed]: 'export const test = true;' }, status: `R  ${renamed}\0${old}\0` });
  assert.equal((await remediate(mock.input, mock.run)).status, 'published');
  assert.deepEqual(mock.calls.find(({ args }) => args[0] === 'add').args, ['add', '--', renamed, old]);
});

test('a test reverted to HEAD cannot satisfy the final staged regression test requirement', async (t) => {
  const mock = await fixture(t, { status: ` M ${source}\0MM ${regression}\0`, staged: `${source}\0` });
  const result = await remediate(mock.input, mock.run);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'Commit must include a changed regression test.');
  assert.ok(!mock.calls.some(({ args }) => ['commit', 'push'].includes(args[0])));
});

test('failures never push or leak subprocess output; failed worktrees remain available', async (t) => {
  for (const fail of [
    (binary, args) => binary === 'git' && args[0] === 'fetch',
    (binary, args) => binary === 'npm' && args[0] === 'ci',
    (binary) => binary === spec,
    ...checks.map((script) => (binary, args) => binary === 'npm' && args[1] === script),
    (binary, args) => binary === 'npx' && args[1] === 'tsx',
    (binary, args) => binary === 'npx' && args[1] === 'tsc',
    (binary, args) => binary === 'git' && args[0] === 'diff',
    (binary, args) => binary === 'git' && args[0] === 'log',
    (binary, args) => binary === 'git' && args[0] === 'commit',
  ]) {
    const mock = await fixture(t, { fail });
    const result = await remediate(mock.input, mock.run);
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!mock.calls.some(({ args }) => args[0] === 'push'));
    const worktree = mock.calls.find(({ args }) => args[0] === 'worktree')?.args[3];
    if (worktree) assert.ok((await stat(worktree)).isDirectory());
    if (mock.calls.some(({ binary }) => binary === spec) && !mock.calls.some(({ binary }) => binary === 'npx')) {
      const log = path.join(mock.logDir, `remediation-${result.branch.slice('eval/fix-'.length)}.log`);
      assert.ok((await readFile(log, 'utf8')).includes(secret));
    }
  }
});

test('rechecks source without touching concurrent changes and hides publication errors', async (t) => {
  const dirty = await fixture(t, { laterDirty: ' M user-change.ts\0' });
  assert.equal((await remediate(dirty.input, dirty.run)).status, 'blocked');
  assert.ok(!dirty.calls.some(({ args }) => ['add', 'commit', 'push'].includes(args[0])));
  const push = await fixture(t, { fail: (binary, args) => binary === 'git' && args[0] === 'push' });
  const result = await remediate(push.input, push.run);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Remediation branch publication failed.');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('default runner bounds subprocesses and kills the detached process group on timeout or overflow', async (t) => {
  for (const failure of ['timeout', 'overflow', 'exit', 'spawn']) {
    const killed = [];
    let spawnOptions;
    t.mock.method(process, 'kill', (pid, signal) => { killed.push({ pid, signal }); return true; });
    t.mock.method(childProcess, 'spawn', (binary, args, options) => {
      spawnOptions = options;
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        if (failure === 'overflow') child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1));
        if (failure === 'exit') { child.stderr.write(secret); child.emit('close', 1); }
        if (failure === 'spawn') child.emit('error', new Error(secret));
      });
      return child;
    });
    const actualSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, timeout) => {
      assert.equal(timeout, 45_000);
      return actualSetTimeout(callback, 1);
    });
    try {
      const result = await remediate({ repo: '/repo', logDir: '/logs', report, env: { EVAL_AUTO_FIX: '1' } });
      assert.equal(result.status, 'failed');
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.equal(spawnOptions.detached, true);
      assert.equal(spawnOptions.shell, false);
      assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
      assert.deepEqual(killed, [{ pid: -12345, signal: 'SIGKILL' }]);
    } finally {
      t.mock.restoreAll();
    }
  }
});
