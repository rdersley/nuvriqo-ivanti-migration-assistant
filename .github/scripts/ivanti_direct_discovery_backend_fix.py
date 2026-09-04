from pathlib import Path

p = Path('src/index.ts')
s = p.read_text()

if 'discoverIvantiOfferings' in s:
    print('Ivanti direct discovery backend already present')
    raise SystemExit(0)

marker = 'export const handler'
pos = s.rfind(marker)
if pos < 0:
    raise SystemExit('resolver export marker not found')

injected = r'''
type IvantiConnectionPayload = {
  baseUrl?: string;
  apiKey?: string;
};

type IvantiODataResponse = {
  '@odata.count'?: number;
  value?: Array<Record<string, unknown>>;
};

function normaliseIvantiBaseUrl(value: unknown): { baseUrl: string; tenantHost: string } {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Ivanti tenant URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('Ivanti tenant URL is not valid.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Ivanti tenant URL must use HTTPS.');
  if (parsed.username || parsed.password) throw new Error('Do not include credentials in the Ivanti tenant URL.');
  const host = parsed.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (privateHost) throw new Error('Private/local Ivanti hosts are not supported by the Forge connection.');
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return { baseUrl: parsed.toString().replace(/\/$/, ''), tenantHost: host };
}

function ivantiCredentials(payload: IvantiConnectionPayload): { baseUrl: string; tenantHost: string; apiKey: string } {
  const { baseUrl, tenantHost } = normaliseIvantiBaseUrl(payload.baseUrl);
  const apiKey = String(payload.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Ivanti REST API key is required.');
  if (apiKey.length > 500) throw new Error('Ivanti REST API key is not valid.');
  return { baseUrl, tenantHost, apiKey };
}

async function ivantiGetJson<T>(baseUrl: string, apiKey: string, path: string): Promise<T> {
  const response = await api.fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `rest_api_key=${apiKey}`
    }
  });
  return parseResponse<T>(response as unknown as ForgeResponse);
}

function ivantiText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

resolver.define('testIvantiConnection', async ({ payload }) => {
  const credentials = ivantiCredentials((payload ?? {}) as IvantiConnectionPayload);
  const body = await ivantiGetJson<IvantiODataResponse>(
    credentials.baseUrl,
    credentials.apiKey,
    '/api/odata/businessobject/ServiceReqTemplates?$top=1'
  );
  return {
    ok: true,
    tenantHost: credentials.tenantHost,
    sampleCount: Array.isArray(body.value) ? body.value.length : 0
  };
});

resolver.define('discoverIvantiOfferings', async ({ payload }) => {
  const credentials = ivantiCredentials((payload ?? {}) as IvantiConnectionPayload);
  const body = await ivantiGetJson<IvantiODataResponse>(
    credentials.baseUrl,
    credentials.apiKey,
    '/api/odata/businessobject/ServiceReqTemplates?$top=100'
  );
  const records = Array.isArray(body.value) ? body.value : [];
  const offerings = records.map((record) => ({
    recId: ivantiText(record, ['RecId', 'RecID', 'recId', 'recID']),
    name: ivantiText(record, ['Name', 'DisplayName', 'Title', 'ServiceReqTemplateName', 'RequestOfferingName']),
    description: ivantiText(record, ['Description', 'DescriptionText', 'Summary'])
  }));
  return {
    tenantHost: credentials.tenantHost,
    total: typeof body['@odata.count'] === 'number' ? body['@odata.count'] : offerings.length,
    offerings
  };
});

resolver.define('discoverIvantiWorkflowInstances', async ({ payload }) => {
  const credentials = ivantiCredentials((payload ?? {}) as IvantiConnectionPayload);
  const body = await ivantiGetJson<IvantiODataResponse>(
    credentials.baseUrl,
    credentials.apiKey,
    '/api/odata/businessobject/WorkflowInstances?$top=100'
  );
  const records = Array.isArray(body.value) ? body.value : [];
  return {
    tenantHost: credentials.tenantHost,
    total: typeof body['@odata.count'] === 'number' ? body['@odata.count'] : records.length,
    records: records.map((record) => ({
      recId: ivantiText(record, ['RecId', 'RecID', 'recId', 'recID']),
      name: ivantiText(record, ['Name', 'DefinitionName', 'WorkflowName', 'DisplayName']),
      parentName: ivantiText(record, ['ParentName', 'ContextBO', 'ParentBO']),
      version: ivantiText(record, ['Version', 'WorkflowVersion']),
      status: ivantiText(record, ['Status', 'State']),
      details: ivantiText(record, ['Details', 'WorkflowDetails', 'Definition'])
    }))
  };
});

'''

p.write_text(s[:pos] + injected + s[pos:])
print('Applied Ivanti direct discovery backend')
