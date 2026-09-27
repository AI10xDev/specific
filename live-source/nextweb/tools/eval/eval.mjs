#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAzure } from './azure.mjs';
import { remediate } from './remediate.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}).trimEnd();

export function snapshot(repo) {
  const priority = readFileSync(join(repo, 'priority.md'), 'utf8');
  if (!priority.trim() || priority.length > 64 * 1024) throw new Error('priority.md must contain 1-65536 characters.');
  // Read tracked source only, never environment files, credentials, or developer transcripts.
  const files = git(repo, 'ls-files', '-z').split('\0').filter((name) =>
    /^(qore-nextjs\/src\/|services\/video-scene-rs\/src\/|\.github\/workflows\/|tools\/eval\/)/.test(name)
    && /\.(?:[cm]?[jt]sx?|rs|ya?ml)$/.test(name));
  const hashes = {};
  const evidence = { azureFunctions: [], database: [], authorizationTests: [] };
  for (const name of files) {
    const path = join(repo, name);
    if (!existsSync(path)) { hashes[name] = 'deleted'; continue; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    const content = readFileSync(path);
    hashes[name] = digest(content);
    if (/azure|function/i.test(name) || /azure-functions|FUNCTIONS_WORKER_RUNTIME/.test(content.toString())) evidence.azureFunctions.push(name);
    if (/pgPool|postgres|Db\./.test(name)) evidence.database.push(name);
    if (/auth.*test|test.*auth/i.test(name)) evidence.authorizationTests.push(name);
  }
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    branch: git(repo, 'branch', '--show-current'),
    dirty: Boolean(git(repo, 'status', '--porcelain')),
    priority,
    priorityHash: digest(priority),
    sourceHash: digest(JSON.stringify(hashes)),
    files: hashes,
    evidence,
    coverage: 'Tracked application/Rust source, workflows, evaluator; untracked source is excluded.',
  };
}

export function evaluate(repository, azure, previous = null, now = new Date()) {
  const metrics = azure.metrics;
  const end = metrics ? Date.parse(metrics.windowEnd) : NaN;
  const fresh = Number.isFinite(end) && end <= now.getTime() && now.getTime() - end < 2 * 3600_000;
  const enough = fresh && metrics.samples >= 100 && metrics.requests >= 100;
  const observations = {
    failureRate: enough ? metrics.failures / metrics.requests : null,
    p95Ms: enough ? metrics.p95Ms : null,
  };
  const definitions = [
    { id: 'swa-reliability', metric: 'failureRate', target: 0.01, priorityPattern: /swa|function|reliab/i,
      sourceEvidence: repository.evidence?.azureFunctions ?? [],
      hypothesis: 'SWA and Azure Functions changes keep failed production requests at or below 1% per complete hour.',
      experiment: 'Compare failure rates before/after a deployment; use an isolated staging load test before raising concurrency.' },
    { id: 'scale-latency', metric: 'p95Ms', target: 2000, priorityPattern: /scal|load|latency/i,
      sourceEvidence: repository.evidence?.database ?? [],
      hypothesis: 'Function and database scaling keep sampled production request p95 at or below 2000 ms.',
      experiment: 'Measure p95 under staged 1x/2x load alongside database wait time and connection saturation; do not load-test production.' },
    { id: 'database-resilience', metric: null, target: null, priorityPattern: /database|resilien/i,
      sourceEvidence: repository.evidence?.database ?? [],
      hypothesis: 'Bounded connection pools and transient-error handling prevent connection exhaustion under 2x staging load.',
      experiment: 'Collect pool waiting, acquisition p95 and error rates; inject staging database outages and verify recovery.' },
    { id: 'security', metric: null, target: null, priorityPattern: /secur|vulnerab|auth/i,
      sourceEvidence: repository.evidence?.authorizationTests ?? [],
      hypothesis: 'Security changes leave no unwaived high/critical reachable vulnerabilities or authorization regressions.',
      experiment: 'Run pinned dependency scans plus authorization tests; record vulnerabilities, waivers and before/after evidence.' },
  ];
  const sameScope = previous?.repository?.priorityHash === repository.priorityHash
    && previous?.telemetryScope === azure.scope;
  const consecutiveWindow = sameScope && previous?.azure?.metrics
    && Date.parse(previous.azure.metrics.windowEnd) === end - 3600_000;
  const sameWindow = sameScope && previous?.azure?.metrics?.windowEnd === metrics?.windowEnd;
  const hypotheses = definitions.map(({ priorityPattern, ...definition }) => {
    const observed = definition.metric ? observations[definition.metric] : null;
    const prior = previous?.hypotheses?.find((item) => item.id === definition.id);
    const status = observed === null ? 'unmeasured' : observed > definition.target ? 'breached' : 'supported';
    const streak = status !== 'breached' ? 0 : sameWindow ? (prior?.status === 'breached' ? prior.breachWindows : 1)
      : consecutiveWindow && prior?.status === 'breached' ? (prior.breachWindows ?? 0) + 1 : 1;
    return { ...definition,
      priorityEvidence: (repository.priority ?? '').split('\n').filter((line) => priorityPattern.test(line)),
      observed, status, breachWindows: streak,
      refinement: status === 'unmeasured' ? 'Collect missing evidence; absence of telemetry is not success.'
        : status === 'breached' ? 'Investigate deployment, endpoint mix and database contention; retain the target rather than normalizing regressions.'
          : 'Provisionally supported for this window only; validate under representative staging load.',
    };
  });
  const changedFiles = previous ? [...new Set([...Object.keys(previous.repository.files), ...Object.keys(repository.files)])]
    .filter((name) => previous.repository.files[name] !== repository.files[name]) : Object.keys(repository.files);
  const findings = hypotheses.filter((item) => item.breachWindows >= 2)
    .map((item) => ({ id: item.id, observed: item.observed, target: item.target,
      reason: 'Target breached in at least two consecutive, distinct complete hourly windows with >=100 samples each.' }));
  const fixtures = hypotheses.map((item) => ({
    id: item.id, status: 'specified', environment: 'local-or-staging',
    hypothesis: item.hypothesis, priorityEvidence: item.priorityEvidence, sourceEvidence: item.sourceEvidence,
    experiment: item.experiment, metric: item.metric, target: item.target,
    observation: { status: item.status, value: item.observed, windowEnd: metrics?.windowEnd ?? null },
    implementationRequired: findings.length
      ? 'Implement deterministic .test.ts/.test.tsx fixtures, establish a reproducible defect, and validate before and after the fix. Never load-test production.'
      : 'Implement deterministic local .test.ts/.test.tsx fixtures for existing behavior. Do not change production code or interpret local results as production metrics.',
    handoffEligible: findings.length ? findings.some((finding) => finding.id === item.id) : Boolean(previous),
  }));
  const revisionKey = digest(JSON.stringify({ priority: repository.priorityHash, source: repository.sourceHash,
    states: hypotheses.map(({ id, status, refinement }) => ({ id, status, refinement })) }));
  return {
    schemaVersion: 1, createdAt: now.toISOString(), repository, azure, telemetryScope: azure.scope,
    revision: (previous?.revision ?? 0) + (previous?.revisionKey === revisionKey ? 0 : 1), revisionKey,
    changedFiles, priorityChanged: Boolean(previous && previous.repository.priorityHash !== repository.priorityHash), hypotheses, findings,
    substantial: findings.length > 0, fixtures, fixturePass: Boolean(previous) && findings.length === 0,
    fixtureValidation: previous?.fixtureValidation ?? null,
    limitations: [
      'Targets are provisional evaluation hypotheses, not measured SLAs or causal proof.',
      'Application Insights latency percentiles use sampled rows; synthetic warmup traffic may affect results.',
      'Database resilience and security require additional instrumentation and controlled tests.',
      ...(!enough ? ['No fresh production hour with at least 100 request samples; request hypotheses remain unmeasured.'] : []),
    ],
  };
}

function markdown(report) {
  return `# Eval Daemon\n\nRun: ${report.createdAt}\nRevision: ${report.revision}\nCommit: ${report.repository.head}\n\n`
    + `## Repository Priorities\n\n${report.repository.priority}\n\n`
    + `## Hypotheses\n\n${report.hypotheses.map((item) =>
      `### ${item.id}\n\n${item.hypothesis}\n\nStatus: ${item.status}; observed: ${item.observed ?? 'unknown'}; consecutive breach windows: ${item.breachWindows}.\n\n${item.refinement}\n\nNext experiment: ${item.experiment}`).join('\n\n')}\n\n`
    + `## Fixture Handoff\n\nFixture specifications: logs/eval/fixtures.json. Subsequent live passes hand local test implementation to spec build; substantial findings can also request production code fixes. Both use isolated worktrees and independent validation. Specifications alone are not executed tests.\n\nLast validated fixtures: ${report.fixtureValidation ? `${report.fixtureValidation.branch} at ${report.fixtureValidation.at}` : 'none'}.\n\n`
    + `## Evidence Gaps\n\n${[...report.azure.gaps, ...report.limitations].map((gap) => `- ${gap}`).join('\n')}\n\n`
    + `Changed source files: ${report.changedFiles.length}\nSubstantial finding: ${report.substantial}\nRemediation: ${report.remediation.status}\n`;
}

function atomic(path, content) {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: spec eval [--repo PATH] [--offline]\nAlso accepts spec --eval. Logs: REPO/logs/eval/.');
    return;
  }
  let cwd = process.cwd();
  let offline = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--offline') offline = true;
    else if (arg === '--repo' && args[0] && !args[0].startsWith('--')) cwd = resolve(args.shift());
    else throw new Error('Unknown option or missing value. Use spec eval --help.');
  }
  const repo = git(cwd, 'rev-parse', '--show-toplevel');
  const logDir = join(repo, 'logs/eval');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const latestPath = join(logDir, 'latest.json');
  let previous = null;
  if (existsSync(latestPath)) {
    previous = JSON.parse(readFileSync(latestPath, 'utf8'));
    if (previous.schemaVersion !== 1) throw new Error('Unsupported evaluation state version. Preserve logs and migrate state.');
  }
  const repository = snapshot(repo);
  const azure = offline ? { status: 'unavailable', deployments: [], metrics: null, gaps: ['Offline run: Azure was not queried.'] }
    : await collectAzure(process.env);
  azure.scope = digest(JSON.stringify([process.env.EVAL_SWA_RESOURCE_ID, process.env.EVAL_REPOSITORY_URL,
    process.env.EVAL_APP_INSIGHTS_APP_ID, process.env.EVAL_PRODUCTION_HOST, offline]));
  const report = evaluate(repository, azure, previous);
  if (offline) {
    report.fixturePass = false;
    for (const fixture of report.fixtures) fixture.handoffEligible = false;
  }
  // Persist evidence before a potentially long-running fix attempt.
  report.remediation = { status: 'pending' };
  const runPath = join(logDir, report.createdAt.replace(/[:.]/g, '-') + '.json');
  atomic(runPath, JSON.stringify(report, null, 2) + '\n');
  report.lastAttempt = previous?.lastAttempt ?? null;
  const alreadyAttempted = report.lastAttempt && (['published', 'in-progress'].includes(report.lastAttempt.status)
    || Date.now() - Date.parse(report.lastAttempt.at) < 24 * 3600_000);
  report.remediation = alreadyAttempted
    ? { status: 'blocked', reason: 'A fix was attempted in the last 24 hours, or a published fix awaits review.',
      branch: report.lastAttempt.branch }
    : await remediate({ repo, logDir, report, onAttempt: async (attempt) => {
      report.lastAttempt = attempt;
      atomic(latestPath, JSON.stringify(report, null, 2) + '\n');
      atomic(runPath, JSON.stringify(report, null, 2) + '\n');
    } });
  if (['published', 'failed'].includes(report.remediation.status) || report.remediation.branch) {
    if (!alreadyAttempted) report.lastAttempt = { ...report.remediation, at: report.createdAt };
  }
  if (report.remediation.status === 'published') {
    report.fixtureValidation = { status: 'passed', branch: report.remediation.branch, at: report.createdAt,
      baseHead: repository.head, scope: 'Local regression tests and TypeScript checks; not production metric validation.' };
  }
  atomic(runPath, JSON.stringify(report, null, 2) + '\n');
  atomic(latestPath, JSON.stringify(report, null, 2) + '\n');
  atomic(join(logDir, 'fixtures.json'), JSON.stringify({ schemaVersion: 1, createdAt: report.createdAt,
    revision: report.revision, head: repository.head, sourceHash: repository.sourceHash,
    priorityHash: repository.priorityHash, fixtures: report.fixtures, handoff: report.remediation,
    lastValidation: report.fixtureValidation,
  }, null, 2) + '\n');
  atomic(join(logDir, 'hypothesis.md'), markdown(report));
  console.log(`Eval Daemon: revision ${report.revision}; telemetry ${azure.status}; findings ${report.findings.length}; ${runPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Eval Daemon failed: check repository, priority.md, state and permissions. No credentials are printed.');
    process.exitCode = 1;
  });
}
