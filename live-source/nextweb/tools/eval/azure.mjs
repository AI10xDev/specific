import childProcess from 'node:child_process';

const jsonArgs = ['--output', 'json', '--only-show-errors'];
const appFields = ['id', 'name', 'resourceGroup', 'defaultHostname', 'repositoryUrl', 'branch'];
const environmentFields = ['name', 'status', 'sourceBranch', 'lastUpdatedTime', 'hostname'];
const projection = (fields) => `[].{${fields.map((field) => `${field}:${field}`).join(',')}}`;
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [
  field, typeof value?.[field] === 'string' ? value[field] : null,
]));

async function defaultCommandRunner(binary, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(binary, args, {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return reject(new Error('Azure CLI command failed.'));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Azure CLI returned invalid JSON.'));
      }
    });
  });
}

function repository(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`;
  } catch {
    return null;
  }
}

export async function collectAzure(env = process.env, run = defaultCommandRunner) {
  const deployments = [];
  const gaps = [];
  let metrics = null;
  const command = (args) => run('az', [...args, ...jsonArgs]);
  const resourceId = env.EVAL_SWA_RESOURCE_ID;
  const targetRepository = repository(env.EVAL_REPOSITORY_URL ?? 'https://github.com/AI10x/nextweb');
  const explicitResource = resourceId !== undefined;
  const validTarget = explicitResource
    ? typeof resourceId === 'string' && resourceId.trim().startsWith('/')
    : targetRepository !== null;

  if (!validTarget) {
    gaps.push('Invalid Static Web App target configuration.');
  } else {
    try {
      const apps = await command(['staticwebapp', 'list', '--query', projection(appFields)]);
      if (!Array.isArray(apps)) throw new Error('Invalid app list');
      const matched = apps.filter((app) => explicitResource
        ? typeof app?.id === 'string' && app.id.toLowerCase() === resourceId.trim().toLowerCase()
        : repository(app?.repositoryUrl) === targetRepository);
      if (!matched.length) gaps.push('No Static Web App matched the configured resource or repository.');
      for (const app of matched) {
        if (!app.id || !app.name || !app.resourceGroup
          || !['id', 'name', 'resourceGroup'].every((key) => typeof app[key] === 'string')) {
          gaps.push('Matched Static Web App metadata is incomplete.');
          continue;
        }
        const deployment = {
          ...pick(app, appFields),
          repositoryUrl: repository(app.repositoryUrl) ? app.repositoryUrl : null,
          environments: [],
          metricDefinitions: [],
        };
        deployments.push(deployment);
        try {
          const environments = await command([
            'staticwebapp', 'environment', 'list', '--name', app.name,
            '--resource-group', app.resourceGroup, '--query', projection(environmentFields),
          ]);
          if (!Array.isArray(environments) || environments.some((item) => !item || typeof item !== 'object')) {
            throw new Error('Invalid environment list');
          }
          deployment.environments = environments.map((item) => pick(item, environmentFields));
        } catch {
          gaps.push('Static Web App environments unavailable; check Azure CLI authentication and access.');
        }
        try {
          // Definitions are informational; platform aggregates are not production-host telemetry.
          const definitions = await command([
            'monitor', 'metrics', 'list-definitions', '--resource', app.id,
            '--query', '[].{name:name.value,unit:unit,primaryAggregationType:primaryAggregationType}',
          ]);
          if (!Array.isArray(definitions)) throw new Error('Invalid metric definitions');
          deployment.metricDefinitions = definitions
            .filter((item) => typeof item?.name === 'string' && /request|error/i.test(item.name))
            .map((item) => pick(item, ['name', 'unit', 'primaryAggregationType']));
        } catch {
          gaps.push('Azure Monitor metric definitions unavailable; check Azure CLI authentication and access.');
        }
      }
    } catch {
      gaps.push('Static Web App discovery unavailable; check Azure CLI installation, authentication, and access.');
    }
  }

  const appId = env.EVAL_APP_INSIGHTS_APP_ID;
  const host = env.EVAL_PRODUCTION_HOST;
  if (!appId || !host) {
    gaps.push('Production telemetry requires both EVAL_APP_INSIGHTS_APP_ID and EVAL_PRODUCTION_HOST.');
  } else if (typeof appId !== 'string'
    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(appId)
    || typeof host !== 'string' || host.length > 253
    || !host.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    gaps.push('Invalid Application Insights app ID or production hostname.');
  } else {
    const query = [
      'let windowEnd = startofhour(now());',
      'let windowStart = windowEnd - 1h;',
      'requests',
      '| where timestamp >= windowStart and timestamp < windowEnd',
      `| where tolower(tostring(parse_url(url).Host)) == '${host.toLowerCase()}'`,
      '| summarize requests=sum(itemCount), failures=sumif(itemCount, success == false), p95Ms=percentile(duration, 95), samples=count()',
      '| extend windowEnd=tostring(windowEnd)',
      '| project windowEnd, requests, failures, p95Ms, samples',
    ].join('\n');
    try {
      const result = await command([
        'rest', '--method', 'GET', '--url',
        `https://api.applicationinsights.io/v1/apps/${appId}/query?query=${encodeURIComponent(query)}`,
        '--resource', 'https://api.applicationinsights.io',
      ]);
      if (result?.error) throw new Error('Telemetry query error');
      const table = result?.tables?.find((item) => item.name === 'PrimaryResult');
      if (!Array.isArray(table?.columns) || !Array.isArray(table?.rows)
        || table.rows.length !== 1 || !Array.isArray(table.rows[0])) throw new Error('Invalid telemetry table');
      const values = Object.fromEntries(table.columns.map((column, index) => [column.name, table.rows[0][index]]));
      const end = typeof values.windowEnd === 'string' ? Date.parse(values.windowEnd) : NaN;
      if (!Number.isFinite(end) || end % 3_600_000 !== 0
        || !['requests', 'failures', 'samples'].every((key) => Number.isSafeInteger(values[key]) && values[key] >= 0)
        || !Number.isFinite(values.p95Ms) || values.p95Ms < 0
        || values.failures > values.requests || values.samples === 0) {
        throw new Error('Missing or invalid telemetry aggregates');
      }
      metrics = {
        windowEnd: new Date(end).toISOString(),
        requests: values.requests,
        failures: values.failures,
        p95Ms: values.p95Ms,
        samples: values.samples,
      };
    } catch {
      gaps.push('Production telemetry unavailable or has no usable samples; check Application Insights configuration, authentication, and access.');
    }
  }

  return {
    status: gaps.length === 0 ? 'available' : deployments.length || metrics ? 'partial' : 'unavailable',
    deployments,
    metrics,
    gaps,
  };
}
