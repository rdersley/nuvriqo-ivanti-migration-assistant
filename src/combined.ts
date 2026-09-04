import Resolver from '@forge/resolver';
import api, { storage } from '@forge/api';
import { handler as legacyHandler } from './index';

type InvocationEvent = {
  call?: {
    functionKey?: string;
    payload?: Record<string, unknown>;
    jobId?: string;
  };
  context?: Record<string, unknown>;
};

type IvantiConnection = {
  tenantUrl: string;
  apiKey: string;
  updatedAt: string;
};

const CONNECTION_KEY = 'ivanti-rest-connection-v1';
const IVANTI_FUNCTIONS = new Set([
  'getIvantiConnection',
  'saveIvantiConnection',
  'testIvantiConnection',
  'discoverIvantiRequestOfferings'
]);

const ivantiResolver = new Resolver();

function normaliseTenantUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Ivanti tenant URL is required.');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Enter a valid Ivanti tenant URL, for example https://yourtenant.ivanticloud.com.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Ivanti tenant URL must use HTTPS.');
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function normaliseApiKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('Ivanti REST API Key Reference ID is required.');
  if (key.length < 16 || key.length > 256) throw new Error('The REST API Key Reference ID does not look valid.');
  return key;
}

function maskKey(key: string): string {
  if (key.length < 10) return '••••••••';
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

async function getSavedConnection(): Promise<IvantiConnection> {
  const saved = await storage.get(CONNECTION_KEY) as IvantiConnection | undefined;
  if (!saved?.tenantUrl || !saved?.apiKey) {
    throw new Error('No Ivanti connection has been saved yet.');
  }
  return saved;
}

async function ivantiFetch(connection: IvantiConnection, path: string) {
  const response = await api.fetch(`${connection.tenantUrl}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, application/xml, text/xml;q=0.9, */*;q=0.8',
      Authorization: `rest_api_key=${connection.apiKey}`
    }
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    contentType: response.headers.get('content-type') || ''
  };
}

function explainHttp(status: number, body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (status === 401) return 'Ivanti rejected the REST API key (401 Unauthorized). Check that the key is active and belongs to this tenant.';
  if (status === 403) return 'Ivanti accepted the request but the selected user/role is not allowed to access this resource (403 Forbidden).';
  if (status === 404) return 'The Ivanti API endpoint was not found on this tenant (404).';
  return `Ivanti returned HTTP ${status}${compact ? `: ${compact}` : ''}`;
}

async function testConnection(connection: IvantiConnection) {
  // OData metadata is the safest discovery probe because it does not create or modify data.
  const metadata = await ivantiFetch(connection, '/api/odata/$metadata');
  if (metadata.ok) {
    return {
      ok: true,
      status: metadata.status,
      tenantUrl: connection.tenantUrl,
      message: 'Connected to the Ivanti OData API successfully.',
      metadataAvailable: true
    };
  }

  // Some tenants restrict $metadata while allowing business-object reads. Use a tiny read-only fallback.
  const employeeProbe = await ivantiFetch(connection, '/api/odata/businessobject/employees?$top=1');
  if (employeeProbe.ok) {
    return {
      ok: true,
      status: employeeProbe.status,
      tenantUrl: connection.tenantUrl,
      message: 'Connected to the Ivanti REST API successfully.',
      metadataAvailable: false
    };
  }

  throw new Error(explainHttp(employeeProbe.status || metadata.status, employeeProbe.text || metadata.text));
}

function entitySetsFromMetadata(xml: string): string[] {
  const names = new Set<string>();
  const regex = /<EntitySet\s+[^>]*Name=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) names.add(match[1]);
  return [...names];
}

function offeringCandidates(metadata: string): string[] {
  const discovered = entitySetsFromMetadata(metadata)
    .filter((name) => /request.*offer|offer.*request|servicereq.*template|request.*template/i.test(name));
  return [...new Set([
    ...discovered,
    'requestofferings',
    'servicereqtemplates',
    'servicerequesttemplates'
  ])];
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function extractRecords(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const candidate = body as { value?: unknown; d?: { results?: unknown } };
  if (Array.isArray(candidate.value)) return candidate.value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (Array.isArray(candidate.d?.results)) return candidate.d.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  return [];
}

function firstString(record: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const direct = record[name];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
    const key = Object.keys(record).find((item) => item.toLowerCase() === name.toLowerCase());
    if (key && record[key] !== undefined && record[key] !== null && String(record[key]).trim()) return String(record[key]).trim();
  }
  return '';
}

ivantiResolver.define('getIvantiConnection', async () => {
  const saved = await storage.get(CONNECTION_KEY) as IvantiConnection | undefined;
  return saved?.tenantUrl && saved?.apiKey
    ? {
        configured: true,
        tenantUrl: saved.tenantUrl,
        apiKeyMasked: maskKey(saved.apiKey),
        updatedAt: saved.updatedAt
      }
    : { configured: false, tenantUrl: '', apiKeyMasked: '' };
});

ivantiResolver.define('saveIvantiConnection', async ({ payload }) => {
  const tenantUrl = normaliseTenantUrl(payload?.tenantUrl);
  const suppliedKey = String(payload?.apiKey ?? '').trim();
  const existing = await storage.get(CONNECTION_KEY) as IvantiConnection | undefined;
  const apiKey = suppliedKey ? normaliseApiKey(suppliedKey) : existing?.apiKey;
  if (!apiKey) throw new Error('Ivanti REST API Key Reference ID is required.');

  const saved: IvantiConnection = { tenantUrl, apiKey, updatedAt: new Date().toISOString() };
  await storage.set(CONNECTION_KEY, saved);
  return {
    configured: true,
    tenantUrl,
    apiKeyMasked: maskKey(apiKey),
    updatedAt: saved.updatedAt
  };
});

ivantiResolver.define('testIvantiConnection', async () => {
  return testConnection(await getSavedConnection());
});

ivantiResolver.define('discoverIvantiRequestOfferings', async () => {
  const connection = await getSavedConnection();
  await testConnection(connection);

  const metadataResponse = await ivantiFetch(connection, '/api/odata/$metadata');
  const candidates = offeringCandidates(metadataResponse.ok ? metadataResponse.text : '');
  const attempts: Array<{ entitySet: string; status: number; message: string }> = [];

  for (const entitySet of candidates) {
    const safeEntitySet = encodeURIComponent(entitySet);
    const response = await ivantiFetch(connection, `/api/odata/businessobject/${safeEntitySet}?$top=250`);
    if (!response.ok) {
      attempts.push({ entitySet, status: response.status, message: explainHttp(response.status, response.text) });
      continue;
    }

    const records = extractRecords(parseJson(response.text));
    const offerings = records.map((record, index) => ({
      id: firstString(record, ['RecId', 'RecID', 'Id', 'ID']) || `${entitySet}-${index + 1}`,
      name: firstString(record, ['Name', 'DisplayName', 'Title', 'Subject']) || `Request offering ${index + 1}`,
      description: firstString(record, ['Description', 'Details']),
      status: firstString(record, ['Status', 'State']),
      service: firstString(record, ['Service', 'ServiceName', 'Category']),
      raw: record
    }));

    return {
      ok: true,
      entitySet,
      count: offerings.length,
      offerings,
      message: `Discovered ${offerings.length} Ivanti request offering${offerings.length === 1 ? '' : 's'} from ${entitySet}.`
    };
  }

  throw new Error(`Connected to Ivanti, but no readable Request Offering business object was found. Tried: ${attempts.map((item) => `${item.entitySet} (${item.status})`).join(', ')}. This usually means the object has a different tenant-specific name or the API user/role cannot read it.`);
});

const ivantiHandler = ivantiResolver.getDefinitions();

export const handler = async (event: InvocationEvent, runtimeContext: unknown) => {
  const functionKey = event?.call?.functionKey || '';
  if (IVANTI_FUNCTIONS.has(functionKey)) {
    return ivantiHandler(event as never, runtimeContext as never);
  }
  return legacyHandler(event as never, runtimeContext as never);
};
