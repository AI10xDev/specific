import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { test } from 'node:test';
import { collectAzure } from './azure.mjs';

const secret = 'DO-NOT-EXPOSE-SECRET';
const app = {
  id: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/site-rg/providers/Microsoft.Web/staticSites/site',
  name: 'site',
  resourceGroup: 'site-rg',
  defaultHostname: 'site.azurestaticapps.net',
  repositoryUrl: 'https://github.com/AI10x/nextweb.git/',
  branch: 'main',
  secret,
};
const telemetryEnv = {
  EVAL_APP_INSIGHTS_APP_ID: '22222222-2222-2222-2222-222222222222',
  EVAL_PRODUCTION_HOST: 'Production.Example.com',
};
const telemetry = (overrides = {}) => {
  const values = { samples: 12, p95Ms: 250.5, requests: 30, failures: 4, windowEnd: '2026-09-14T10:00:00Z', ...overrides };
  return {
    tables: [{
      name: 'PrimaryResult',
      columns: Object.keys(values).map((name) => ({ name, type: 'real' })),
      rows: [Object.values(values)],
    }],
  };
};
function runner({ apps = [app], environments = [], definitions = [], response = telemetry(), fail } = {}) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push({ binary, args });
    assert.equal(binary, 'az');
    assert.deepEqual(args.slice(-3), ['--output', 'json', '--only-show-errors']);
    const kind = args[0] === 'rest' ? 'telemetry'
      : args[0] === 'monitor' ? 'definitions'
        : args[1] === 'environment' ? 'environments' : 'apps';
    if (fail === kind) throw new Error(`Authentication failed: ${secret}`);
    return { apps, environments, definitions, telemetry: response }[kind];
  };
  return { calls, run };
}

test('filters repository, normalizes suffixes, selects only safe metadata for each match', async () => {
  const other = { ...app, id: '/unrelated', name: 'other', repositoryUrl: 'https://github.com/elsewhere/app' };
  const second = { ...app, id: `${app.id}-two`, name: 'site-two', repositoryUrl: 'https://github.com/AI10x/nextweb/' };
  const mock = runner({
    apps: [other, app, second],
    environments: [{ name: 'default', status: 'Ready', sourceBranch: 'main', lastUpdatedTime: '2026-09-14', hostname: app.defaultHostname, secret }],
    definitions: [{ name: 'Requests', unit: 'Count', primaryAggregationType: 'Total', secret }, { name: 'BytesSent' }],
  });
  const result = await collectAzure({}, mock.run);
  assert.equal(result.status, 'partial');
  assert.equal(result.metrics, null);
  assert.deepEqual(result.deployments.map((item) => item.name), ['site', 'site-two']);
  assert.equal(result.deployments[0].environments[0].status, 'Ready');
  assert.deepEqual(result.deployments[0].metricDefinitions, [{ name: 'Requests', unit: 'Count', primaryAggregationType: 'Total' }]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(mock.calls.length, 5);
  assert.equal(mock.calls[0].args[3], '[].{id:id,name:name,resourceGroup:resourceGroup,defaultHostname:defaultHostname,repositoryUrl:repositoryUrl,branch:branch}');
  for (const call of mock.calls.filter(({ args }) => args[1] === 'environment')) {
    assert.equal(call.args[call.args.indexOf('--resource-group') + 1], 'site-rg');
    assert.equal(call.args[call.args.indexOf('--query') + 1], '[].{name:name,status:status,sourceBranch:sourceBranch,lastUpdatedTime:lastUpdatedTime,hostname:hostname}');
    assert.ok(['site', 'site-two'].includes(call.args[call.args.indexOf('--name') + 1]));
  }
  assert.ok(mock.calls.filter(({ args }) => args[0] === 'monitor').every(({ args }) => args[2] === 'list-definitions'));
});

test('explicit resource overrides repository but must match a discovered resource', async () => {
  const other = { ...app, repositoryUrl: 'https://github.com/elsewhere/app' };
  const found = runner({ apps: [other] });
  const result = await collectAzure({ EVAL_SWA_RESOURCE_ID: app.id.toUpperCase() }, found.run);
  assert.equal(result.deployments.length, 1);
  const missing = runner();
  const unmatched = await collectAzure({ EVAL_SWA_RESOURCE_ID: `${app.id}-missing` }, missing.run);
  assert.equal(unmatched.status, 'unavailable');
  assert.deepEqual(unmatched.deployments, []);
  assert.equal(missing.calls.length, 1);
  assert.match(unmatched.gaps.join(' '), /No Static Web App matched/);
});

test('custom repository matches exactly, never selects unrelated applications', async () => {
  const mock = runner();
  const result = await collectAzure({ EVAL_REPOSITORY_URL: 'https://github.com/AI10x/nextweb-other' }, mock.run);
  assert.equal(result.status, 'unavailable');
  assert.equal(mock.calls.length, 1);
  const normalized = await collectAzure({ EVAL_REPOSITORY_URL: 'https://github.com/AI10x/nextweb.git/' }, runner().run);
  assert.equal(normalized.deployments.length, 1);
});

test('both telemetry settings are required; no query is sent when either is missing', async () => {
  for (const env of [{}, { EVAL_APP_INSIGHTS_APP_ID: telemetryEnv.EVAL_APP_INSIGHTS_APP_ID }, { EVAL_PRODUCTION_HOST: telemetryEnv.EVAL_PRODUCTION_HOST }]) {
    const mock = runner();
    const result = await collectAzure(env, mock.run);
    assert.equal(result.status, 'partial');
    assert.equal(result.metrics, null);
    assert.match(result.gaps.join(' '), /requires both/);
    assert.ok(mock.calls.every(({ args }) => args[0] !== 'rest'));
  }
});

test('queries last complete hour with exact host and parses only aggregate columns', async () => {
  const mock = runner({ response: telemetry({ ignored: secret }) });
  const result = await collectAzure(telemetryEnv, mock.run);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.metrics, { windowEnd: '2026-09-14T10:00:00.000Z', requests: 30, failures: 4, p95Ms: 250.5, samples: 12 });
  assert.ok(!JSON.stringify(result).includes(secret));
  const args = mock.calls.at(-1).args;
  assert.deepEqual(args.slice(0, 3), ['rest', '--method', 'GET']);
  assert.equal(args[args.indexOf('--resource') + 1], 'https://api.applicationinsights.io');
  const url = new URL(args[args.indexOf('--url') + 1]);
  assert.equal(url.origin, 'https://api.applicationinsights.io');
  assert.equal(url.pathname, `/v1/apps/${telemetryEnv.EVAL_APP_INSIGHTS_APP_ID}/query`);
  const kql = url.searchParams.get('query');
  assert.match(kql, /windowEnd = startofhour\(now\(\)\)/);
  assert.match(kql, /windowStart = windowEnd - 1h/);
  assert.match(kql, /timestamp >= windowStart and timestamp < windowEnd/);
  assert.match(kql, /tolower\(tostring\(parse_url\(url\)\.Host\)\) == 'production\.example\.com'/);
  assert.match(kql, /requests=sum\(itemCount\)/);
  assert.match(kql, /failures=sumif\(itemCount, success == false\)/);
  assert.match(kql, /p95Ms=percentile\(duration, 95\), samples=count\(\)/);
});

test('rejects malformed telemetry config without embedding it in commands or results', async () => {
  for (const invalid of [
    { EVAL_APP_INSIGHTS_APP_ID: secret },
    { EVAL_PRODUCTION_HOST: `host'; ${secret}` },
    { EVAL_PRODUCTION_HOST: 'https://example.com' },
    { EVAL_PRODUCTION_HOST: 'example.com/path' },
    { EVAL_PRODUCTION_HOST: 'example.com:443' },
    { EVAL_PRODUCTION_HOST: '-example.com' },
    { EVAL_PRODUCTION_HOST: 'example..com' },
    { EVAL_PRODUCTION_HOST: `${'a'.repeat(64)}.com` },
  ]) {
    const mock = runner();
    const result = await collectAzure({ ...telemetryEnv, ...invalid }, mock.run);
    assert.equal(result.metrics, null);
    assert.match(result.gaps.join(' '), /Invalid Application Insights/);
    assert.ok(mock.calls.every(({ args }) => args[0] !== 'rest'));
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('rejects malformed target config without falling back to defaults', async () => {
  for (const env of [{ EVAL_REPOSITORY_URL: secret }, { EVAL_SWA_RESOURCE_ID: '' }]) {
    const mock = runner();
    const result = await collectAzure(env, mock.run);
    assert.equal(result.status, 'unavailable');
    assert.equal(mock.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('command errors preserve independent results and never reveal error details', async () => {
  for (const fail of ['apps', 'environments', 'definitions', 'telemetry']) {
    const result = await collectAzure(telemetryEnv, runner({ fail }).run);
    assert.equal(result.status, 'partial');
    assert.ok(result.gaps.length > 0);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.metrics === null, fail === 'telemetry');
  }
  const result = await collectAzure({}, runner({ fail: 'apps' }).run);
  assert.equal(result.status, 'unavailable');
});

test('missing, invalid, empty, or partial telemetry is not reported as healthy', async () => {
  for (const response of [
    {}, { tables: [] }, { error: { message: secret }, ...telemetry() },
    telemetry({ requests: '30' }), telemetry({ failures: 31 }),
    telemetry({ p95Ms: null }), telemetry({ p95Ms: -1 }),
    telemetry({ windowEnd: 'not-a-date' }), telemetry({ windowEnd: '2026-09-14T10:30:00Z' }),
    telemetry({ requests: 0, failures: 0, samples: 0, p95Ms: null }),
  ]) {
    const result = await collectAzure(telemetryEnv, runner({ response }).run);
    assert.equal(result.status, 'partial');
    assert.equal(result.metrics, null);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('default runner uses bounded execFile, parses JSON, and hides stderr and invalid output', async (t) => {
  for (const failure of [null, 'exec', 'json']) {
    const calls = [];
    const mock = t.mock.method(childProcess, 'execFile', (binary, args, options, callback) => {
      calls.push({ binary, args, options });
      callback(failure === 'exec' ? new Error(secret) : null, failure === 'json' ? secret : '[]', secret);
    });
    try {
      const result = await collectAzure({});
      assert.equal(result.status, 'unavailable');
      assert.ok(!JSON.stringify(result).includes(secret));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].binary, 'az');
      assert.deepEqual(calls[0].options, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
      assert.match(result.gaps[0], failure ? /discovery unavailable/ : /No Static Web App matched/);
    } finally {
      mock.mock.restore();
    }
  }
});
