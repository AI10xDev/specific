import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './eval.mjs';

const repository = { head: 'abc', files: { 'source.ts': 'a' }, priorityHash: 'p', sourceHash: 's' };
const now = new Date('2026-09-14T13:05:00Z');
const azure = (hour, failures = 5, samples = 200) => ({ scope: 'prod', gaps: [],
  metrics: { windowEnd: `2026-09-14T${hour}:00:00Z`, requests: 200, failures, p95Ms: 2500, samples } });

test('missing, stale and sparse telemetry never count as healthy or substantial', () => {
  for (const telemetry of [{ scope: 'prod', metrics: null }, azure('10'), azure('13', 5, 99), azure('14')]) {
    const result = evaluate(repository, telemetry, null, now);
    assert.equal(result.hypotheses[0].status, 'unmeasured');
    assert.equal(result.substantial, false);
  }
});

test('requires two distinct consecutive hours and does not count repeated manual runs', () => {
  const first = evaluate(repository, azure('12'), null, new Date('2026-09-14T12:05:00Z'));
  assert.equal(first.substantial, false);
  const duplicate = evaluate(repository, azure('12'), first, now);
  assert.equal(duplicate.hypotheses[0].breachWindows, 1);
  const second = evaluate(repository, azure('13'), duplicate, now);
  assert.equal(second.substantial, true);
  assert.equal(second.findings.length, 2);
});

test('scope changes and skipped hours reset evidence streaks', () => {
  const previous = evaluate(repository, azure('11'), null, new Date('2026-09-14T11:05:00Z'));
  assert.equal(evaluate(repository, azure('13'), previous, now).substantial, false);
  const first = evaluate(repository, azure('12'), null, now);
  assert.equal(evaluate(repository, { ...azure('13'), scope: 'other' }, first, now).substantial, false);
});

test('late ingestion can change an unmeasured or healthy hour into the first breached hour', () => {
  for (const telemetry of [azure('12', 5, 99), azure('12', 0)]) {
    const previous = evaluate(repository, telemetry, null, now);
    const updated = evaluate(repository, azure('12'), previous, now);
    assert.equal(updated.hypotheses[0].breachWindows, 1);
    assert.equal(evaluate(repository, azure('13'), updated, now).substantial, true);
  }
});

test('refines after outcomes or source changes without weakening targets', () => {
  const first = evaluate(repository, azure('12'), null, now);
  const second = evaluate(repository, azure('13', 0), first, now);
  assert.equal(second.hypotheses[0].status, 'supported');
  assert.equal(second.hypotheses[0].target, first.hypotheses[0].target);
  assert.equal(second.revision, 2);
  assert.deepEqual(second.changedFiles, []);
  const changed = evaluate({ ...repository, files: { 'source.ts': 'b' }, sourceHash: 'new' }, azure('13', 0), second, now);
  assert.deepEqual(changed.changedFiles, ['source.ts']);
  assert.equal(changed.revision, 3);
});

test('fixture specifications trace evidence and subsequent passes support fixture-only implementation', () => {
  const input = { ...repository, priority: 'Scale SWA functions\nDatabase resilience\nSecurity vulnerabilities',
    evidence: { azureFunctions: ['workflow.yml'], database: ['pgPool.ts'], authorizationTests: ['auth.test.ts'] } };
  const first = evaluate(input, azure('12'), null, now);
  assert.equal(first.fixtures.length, 4);
  assert.ok(first.fixtures.every((item) => item.status === 'specified' && !item.handoffEligible));
  assert.equal(first.fixturePass, false);
  assert.deepEqual(first.fixtures[0].priorityEvidence, ['Scale SWA functions']);
  assert.deepEqual(first.fixtures[0].sourceEvidence, ['workflow.yml']);
  assert.deepEqual(first.fixtures[2].priorityEvidence, ['Database resilience']);
  assert.deepEqual(first.fixtures[3].sourceEvidence, ['auth.test.ts']);
  const second = evaluate(input, azure('13'), first, now);
  assert.deepEqual(second.fixtures.filter((item) => item.handoffEligible).map((item) => item.id),
    ['swa-reliability', 'scale-latency']);
  assert.equal(second.fixtures[0].observation.value, 0.025);
  assert.equal(second.fixtures[0].target, 0.01);
  assert.equal(second.fixturePass, false);
  assert.ok(second.fixtures.every((item) => item.environment === 'local-or-staging'));
  const recovered = evaluate(input, { ...azure('14', 0), metrics: { ...azure('14', 0).metrics, p95Ms: 100 } },
    second, new Date('2026-09-14T14:05:00Z'));
  assert.ok(recovered.fixtures.every((item) => item.handoffEligible));
  assert.equal(recovered.fixturePass, true);
  const validated = { status: 'passed', branch: 'eval/fixtures-123', at: now.toISOString() };
  const unmeasured = evaluate(input, { scope: 'prod', metrics: null }, { ...recovered, fixtureValidation: validated }, now);
  assert.equal(unmeasured.fixturePass, true);
  assert.deepEqual(unmeasured.fixtureValidation, validated);
  assert.ok(unmeasured.hypotheses.every((item) => item.status === 'unmeasured'));
});

test('CLI logs real source/priority changes, rejects bad state, and locks concurrent runs', () => {
  const repo = mkdtempSync(join(tmpdir(), 'spec-eval-'));
  const wrapper = fileURLToPath(new URL('./spec-eval', import.meta.url));
  const runGit = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const run = () => execFileSync(wrapper, ['--repo', repo, '--offline'], { cwd: tmpdir(), stdio: 'pipe' });
  try {
    mkdirSync(join(repo, 'qore-nextjs/src'), { recursive: true });
    writeFileSync(join(repo, 'priority.md'), 'Prioritize scaling and security.');
    writeFileSync(join(repo, '.gitignore'), '/logs/\n');
    writeFileSync(join(repo, 'qore-nextjs/src/a.ts'), 'export const a = 1;\n');
    runGit('init', '-b', 'main');
    runGit('add', '.');
    runGit('-c', 'user.name=Eval Test', '-c', 'user.email=eval@example.invalid', 'commit', '-m', 'test fixture');
    run();
    const latest = join(repo, 'logs/eval/latest.json');
    const first = JSON.parse(readFileSync(latest, 'utf8'));
    assert.equal(first.azure.status, 'unavailable');
    assert.equal(first.repository.priority, 'Prioritize scaling and security.');
    assert.equal(first.remediation.status, 'disabled');
    assert.equal(first.revision, 1);
    const fixtures = JSON.parse(readFileSync(join(repo, 'logs/eval/fixtures.json'), 'utf8'));
    assert.deepEqual(fixtures.fixtures, first.fixtures);
    assert.equal(fixtures.head, first.repository.head);
    assert.deepEqual(fixtures.handoff, { status: 'disabled' });
    // Existing installations have schema 1 reports without fixture fields.
    const legacy = structuredClone(first);
    for (const key of ['fixtures', 'fixturePass', 'fixtureValidation']) delete legacy[key];
    for (const hypothesis of legacy.hypotheses) {
      delete hypothesis.priorityEvidence;
      delete hypothesis.sourceEvidence;
    }
    legacy.lastAttempt = { status: 'published', branch: 'eval/fix-legacy', at: first.createdAt };
    writeFileSync(latest, JSON.stringify(legacy));
    run();
    const repeated = JSON.parse(readFileSync(latest, 'utf8'));
    assert.equal(repeated.revision, 1);
    assert.equal(repeated.fixturePass, false);
    assert.ok(repeated.fixtures.every((item) => !item.handoffEligible));
    assert.deepEqual(repeated.lastAttempt, legacy.lastAttempt);
    assert.equal(repeated.remediation.status, 'blocked');
    assert.equal(repeated.fixtureValidation, null);
    writeFileSync(join(repo, 'qore-nextjs/src/a.ts'), 'export const a = 2;\n');
    run();
    assert.deepEqual(JSON.parse(readFileSync(latest, 'utf8')).changedFiles, ['qore-nextjs/src/a.ts']);
    assert.throws(() => execFileSync('flock', [join(repo, '.git/spec-eval.lock'), wrapper, '--repo', repo, '--offline'],
      { stdio: 'pipe' }), (error) => error.status === 75);
    writeFileSync(latest, '{corrupt');
    assert.throws(run, (error) => error.status === 1);
    assert.equal(readFileSync(latest, 'utf8'), '{corrupt');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
