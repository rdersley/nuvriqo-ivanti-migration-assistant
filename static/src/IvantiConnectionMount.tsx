import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@forge/bridge';

type SavedConnection = {
  configured: boolean;
  tenantUrl: string;
  apiKeyMasked: string;
  updatedAt?: string;
};

type TestResult = {
  ok: boolean;
  status: number;
  tenantUrl: string;
  message: string;
  metadataAvailable?: boolean;
};

type Offering = {
  id: string;
  name: string;
  description?: string;
  status?: string;
  service?: string;
};

type DiscoveryResult = {
  ok: boolean;
  entitySet: string;
  count: number;
  offerings: Offering[];
  message: string;
};

type BrowserControl = {
  id?: string;
  uniqueId?: string;
  typeId?: number;
  parentId?: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  dataModel?: Record<string, unknown>;
  visualModel?: Record<string, unknown>;
  strValidationListRecId?: string;
};

type BrowserDependency = {
  sourceId?: string;
  targetId?: string;
  visibility?: boolean;
  required?: boolean;
  value?: boolean;
  constraint?: boolean;
};

type BrowserForm = {
  id?: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  controls?: BrowserControl[];
  dependencies?: BrowserDependency[];
  deliveryItems?: Array<Record<string, unknown>>;
  infoModel?: Record<string, unknown>;
  configModel?: Record<string, unknown>;
};

type BrowserOffering = {
  id?: string;
  forms?: BrowserForm[];
  serviceReqTemplateId?: string;
  serviceReqTemplateDefinitionId?: string;
};

type BrowserCaptureSummary = {
  offeringId: string;
  templateId: string;
  templateDefinitionId: string;
  name: string;
  description: string;
  forms: number;
  controls: number;
  sections: number;
  fields: number;
  requiredFields: number;
  conditionalFields: number;
  lookupFields: number;
  dependencies: number;
  deliveryItems: number;
  normalized: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

function english(value: Record<string, string> | undefined): string {
  if (!value) return '';
  return value['en-US'] || value['en-GB'] || value.en || Object.values(value).find(Boolean) || '';
}

function expressionSource(control: BrowserControl, key: 'requiredExpression' | 'visibilityExpression' | 'valueExpression' | 'readOnlyExpression'): string {
  const dataModel = control.dataModel as Record<string, unknown> | undefined;
  const expression = dataModel?.[key] as Record<string, unknown> | undefined;
  return String(expression?.Source || '');
}

function isRequired(control: BrowserControl): boolean {
  if ((control.visualModel as Record<string, unknown> | undefined)?.required === true) return true;
  const source = expressionSource(control, 'requiredExpression').trim().toLowerCase();
  return source === 'true' || source === '$(true)' || (source.includes('then true') && !source.includes('then false'));
}

function isConditional(control: BrowserControl): boolean {
  return Boolean(expressionSource(control, 'visibilityExpression') || expressionSource(control, 'requiredExpression').includes('$(') || expressionSource(control, 'valueExpression').includes('$('));
}

function fieldType(typeId?: number): string {
  const types: Record<number, string> = {
    1: 'section',
    3: 'checkbox',
    4: 'text',
    5: 'textarea',
    8: 'choice-or-lookup',
    9: 'date',
    12: 'image'
  };
  return typeId ? types[typeId] || `type-${typeId}` : 'unknown';
}

function parseBrowserCapture(text: string): BrowserCaptureSummary {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const rpc = rows.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    return row.action === 'ServiceRequest' && row.method === 'Get';
  }) as Record<string, unknown> | undefined;
  if (!rpc) throw new Error('No ServiceRequest.Get response was found in this JSON. Copy the Response body from the Ivanti Index request.');
  const result = rpc.result as BrowserOffering | undefined;
  if (!result?.forms?.length) throw new Error('The ServiceRequest.Get response does not contain any forms.');

  const allControls = result.forms.flatMap((form) => form.controls || []);
  const dependencies = result.forms.flatMap((form) => form.dependencies || []);
  const deliveryItems = result.forms.flatMap((form) => form.deliveryItems || []);
  const firstForm = result.forms[0];
  const fields = allControls.filter((control) => control.typeId !== 1);
  const sections = allControls.filter((control) => control.typeId === 1);
  const required = fields.filter(isRequired);
  const conditional = fields.filter(isConditional);
  const lookupFields = fields.filter((control) => Boolean(control.strValidationListRecId));

  const normalizedFields = fields.map((control) => ({
    id: control.id || '',
    key: control.uniqueId || control.id || '',
    parentId: control.parentId || '',
    label: english(control.title),
    description: english(control.description),
    typeId: control.typeId || 0,
    type: fieldType(control.typeId),
    required: isRequired(control),
    visible: (control.visualModel as Record<string, unknown> | undefined)?.visible !== false,
    readOnly: (control.visualModel as Record<string, unknown> | undefined)?.readOnly === true,
    validationListRecId: control.strValidationListRecId || '',
    requiredExpression: expressionSource(control, 'requiredExpression'),
    visibilityExpression: expressionSource(control, 'visibilityExpression'),
    valueExpression: expressionSource(control, 'valueExpression'),
    readOnlyExpression: expressionSource(control, 'readOnlyExpression'),
    dataModel: control.dataModel || {}
  }));

  const normalized = {
    source: 'ivanti-browser-capture',
    capturedAt: new Date().toISOString(),
    offering: {
      id: result.id || result.serviceReqTemplateId || '',
      serviceReqTemplateId: result.serviceReqTemplateId || '',
      serviceReqTemplateDefinitionId: result.serviceReqTemplateDefinitionId || '',
      name: english(firstForm.title),
      description: english(firstForm.description),
      infoModel: firstForm.infoModel || {},
      configModel: firstForm.configModel || {}
    },
    sections: sections.map((control) => ({ id: control.id || '', parentId: control.parentId || '', label: english(control.title) })),
    fields: normalizedFields,
    dependencies,
    deliveryItems
  };

  return {
    offeringId: result.id || result.serviceReqTemplateId || '',
    templateId: result.serviceReqTemplateId || '',
    templateDefinitionId: result.serviceReqTemplateDefinitionId || '',
    name: english(firstForm.title) || 'Unnamed Request Offering',
    description: english(firstForm.description),
    forms: result.forms.length,
    controls: allControls.length,
    sections: sections.length,
    fields: fields.length,
    requiredFields: required.length,
    conditionalFields: conditional.length,
    lookupFields: lookupFields.length,
    dependencies: dependencies.length,
    deliveryItems: deliveryItems.length,
    normalized
  };
}

export default function IvantiConnectionMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [tenantUrl, setTenantUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'discover' | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [browserCapture, setBrowserCapture] = useState('');
  const [browserSummary, setBrowserSummary] = useState<BrowserCaptureSummary | null>(null);
  const normalizedJson = useMemo(() => browserSummary ? JSON.stringify(browserSummary.normalized, null, 2) : '', [browserSummary]);

  useEffect(() => {
    const findSettings = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];
      const settings = panels.find((panel) => panel.querySelector('h1')?.textContent?.trim() === 'Migration settings') || null;
      setTarget((current) => current === settings ? current : settings);
    };

    findSettings();
    const observer = new MutationObserver(findSettings);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!target || loaded) return;
    setLoaded(true);
    invoke('getIvantiConnection')
      .then((raw) => {
        const saved = raw as unknown as SavedConnection;
        setConfigured(Boolean(saved?.configured));
        setTenantUrl(saved?.tenantUrl || '');
        setApiKeyMasked(saved?.apiKeyMasked || '');
      })
      .catch((err) => setError(`Could not load Ivanti connection settings: ${errorMessage(err)}`));
  }, [target, loaded]);

  async function saveConnection() {
    setBusy('save');
    setError('');
    setMessage('');
    try {
      const saved = await invoke('saveIvantiConnection', { tenantUrl, apiKey }) as unknown as SavedConnection;
      setConfigured(true);
      setTenantUrl(saved.tenantUrl);
      setApiKeyMasked(saved.apiKeyMasked);
      setApiKey('');
      setMessage('Ivanti connection settings saved securely in Forge app storage.');
    } catch (err) {
      setError(`Could not save connection: ${errorMessage(err)}`);
    } finally {
      setBusy('');
    }
  }

  async function testConnection() {
    setBusy('test');
    setError('');
    setMessage('');
    setTestResult(null);
    try {
      const result = await invoke('testIvantiConnection') as unknown as TestResult;
      setTestResult(result);
      setMessage(result.message);
    } catch (err) {
      setError(`Ivanti connection failed: ${errorMessage(err)}`);
    } finally {
      setBusy('');
    }
  }

  async function discoverOfferings() {
    setBusy('discover');
    setError('');
    setMessage('');
    setDiscovery(null);
    try {
      const result = await invoke('discoverIvantiRequestOfferings') as unknown as DiscoveryResult;
      setDiscovery(result);
      setMessage(result.message);
    } catch (err) {
      setError(`Request Offering discovery failed: ${errorMessage(err)}`);
    } finally {
      setBusy('');
    }
  }

  function analyseBrowserCapture() {
    setError('');
    setMessage('');
    setBrowserSummary(null);
    try {
      const summary = parseBrowserCapture(browserCapture.trim());
      setBrowserSummary(summary);
      setMessage(`Browser capture loaded: ${summary.name} · ${summary.fields} fields · ${summary.dependencies} dependencies.`);
    } catch (err) {
      setError(`Browser capture could not be imported: ${errorMessage(err)}`);
    }
  }

  async function copyNormalized() {
    if (!normalizedJson) return;
    try {
      await navigator.clipboard.writeText(normalizedJson);
      setMessage('Normalized Ivanti offering JSON copied to the clipboard.');
      setError('');
    } catch {
      setError('Could not copy automatically. Select the normalized JSON and copy it manually.');
    }
  }

  if (!target) return null;

  const box: React.CSSProperties = {
    marginTop: 24,
    border: '1px solid #dfe1e6',
    borderRadius: 8,
    padding: 20,
    background: '#fff'
  };
  const grid: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)',
    gap: 16,
    marginTop: 14
  };
  const input: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: 6,
    padding: '9px 10px',
    border: '1px solid #8590a2',
    borderRadius: 4,
    fontSize: 14
  };
  const buttonRow: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 };
  const secondaryButton: React.CSSProperties = { background: '#f1f2f4', color: '#172b4d' };

  return createPortal(
    <>
      <section style={box} data-ivanti-browser-capture-panel="true">
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Recommended source</div>
        <h2 style={{ margin: '5px 0 4px' }}>Ivanti Browser Capture</h2>
        <p style={{ margin: 0, color: '#626f86' }}>Use this when the REST/OData API is blocked. In Ivanti Developer Tools, open the successful <strong>Index</strong> XHR request, copy the <strong>Response</strong> JSON, and paste it below. No cookies, headers or session tokens are needed.</p>
        <textarea
          style={{ ...input, minHeight: 180, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' }}
          placeholder='Paste the JSON response containing action: "ServiceRequest", method: "Get" here…'
          value={browserCapture}
          onChange={(event) => setBrowserCapture(event.target.value)}
        />
        <div style={buttonRow}>
          <button onClick={analyseBrowserCapture} disabled={!browserCapture.trim()}>Analyse browser capture</button>
          {browserSummary && <button style={secondaryButton} onClick={copyNormalized}>Copy normalized migration JSON</button>}
        </div>

        {browserSummary && (
          <div style={{ marginTop: 18 }}>
            <div style={{ padding: 14, borderRadius: 6, background: '#f7f8f9', border: '1px solid #dfe1e6' }}>
              <h3 style={{ margin: '0 0 5px' }}>{browserSummary.name}</h3>
              {browserSummary.description && <div style={{ color: '#44546f', marginBottom: 10 }}>{browserSummary.description}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 8, fontSize: 13 }}>
                <div><strong>{browserSummary.fields}</strong><br />fields</div>
                <div><strong>{browserSummary.requiredFields}</strong><br />required</div>
                <div><strong>{browserSummary.conditionalFields}</strong><br />conditional</div>
                <div><strong>{browserSummary.lookupFields}</strong><br />lookups</div>
                <div><strong>{browserSummary.dependencies}</strong><br />dependencies</div>
                <div><strong>{browserSummary.sections}</strong><br />sections</div>
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: '#626f86' }}>Template: {browserSummary.templateId || browserSummary.offeringId} · definition: {browserSummary.templateDefinitionId || 'not supplied'}</div>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Normalized migration JSON</summary>
              <textarea readOnly value={normalizedJson} style={{ ...input, minHeight: 260, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
            </details>
          </div>
        )}
      </section>

      <section style={box} data-ivanti-connection-panel="true">
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Optional source connection</div>
          <h2 style={{ margin: '5px 0 4px' }}>Ivanti REST API connection</h2>
          <p style={{ margin: 0, color: '#626f86' }}>Keep this for tenants where Ivanti exposes Request Offerings through OData. Browser Capture above remains available when the tenant returns 403.</p>
        </div>

        <div style={grid}>
          <label style={{ fontWeight: 600 }}>
            Ivanti tenant URL
            <input
              style={input}
              type="url"
              placeholder="https://yourtenant.ivanticloud.com"
              value={tenantUrl}
              onChange={(event) => setTenantUrl(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label style={{ fontWeight: 600 }}>
            REST API Key Reference ID
            <input
              style={input}
              type="password"
              placeholder={configured ? `Saved: ${apiKeyMasked}` : 'Paste the Ivanti Reference ID'}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
            />
            {configured && <small style={{ display: 'block', marginTop: 5, color: '#626f86' }}>A key is already saved ({apiKeyMasked}). Leave this blank to keep it.</small>}
          </label>
        </div>

        <div style={buttonRow}>
          <button onClick={saveConnection} disabled={Boolean(busy) || !tenantUrl.trim() || (!configured && !apiKey.trim())}>
            {busy === 'save' ? 'Saving…' : configured ? 'Update connection' : 'Save connection'}
          </button>
          <button style={secondaryButton} onClick={testConnection} disabled={Boolean(busy) || !configured}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button style={secondaryButton} onClick={discoverOfferings} disabled={Boolean(busy) || !configured}>
            {busy === 'discover' ? 'Discovering…' : 'Discover Request Offerings'}
          </button>
        </div>

        {testResult?.ok && (
          <div style={{ marginTop: 12, color: '#44546f' }}>
            <strong>HTTP {testResult.status}</strong> · {testResult.tenantUrl}{testResult.metadataAvailable === false ? ' · OData metadata restricted, business-object access confirmed' : ' · OData metadata available'}
          </div>
        )}

        {discovery && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <h3 style={{ margin: 0 }}>Discovered Request Offerings</h3>
              <span style={{ color: '#626f86' }}>{discovery.count} found · source: {discovery.entitySet}</span>
            </div>
            <div style={{ marginTop: 10, border: '1px solid #dfe1e6', borderRadius: 6, maxHeight: 330, overflow: 'auto' }}>
              {discovery.offerings.length ? discovery.offerings.map((offering) => (
                <div key={offering.id} style={{ padding: '11px 12px', borderBottom: '1px solid #f1f2f4' }}>
                  <strong>{offering.name}</strong>
                  {(offering.service || offering.status) && <div style={{ marginTop: 3, fontSize: 12, color: '#626f86' }}>{[offering.service, offering.status].filter(Boolean).join(' · ')}</div>}
                  {offering.description && <div style={{ marginTop: 4, color: '#44546f' }}>{offering.description}</div>}
                </div>
              )) : <div style={{ padding: 14, color: '#626f86' }}>The Request Offering object is readable but contains no records visible to this API user/role.</div>}
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f2f4', fontSize: 12, color: '#626f86' }}>
          The Reference ID is sent only from the Forge backend in the Ivanti Authorization header and is not written into the browser migration-project JSON.
        </div>
      </section>

      {(error || message) && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 4, background: error ? '#ffebe6' : '#dcfff1', color: error ? '#ae2a19' : '#164b35' }}>
          {error ? <><strong>Error:</strong> {error}</> : message}
        </div>
      )}
    </>,
    target
  );
}
