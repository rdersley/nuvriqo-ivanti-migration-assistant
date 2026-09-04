import { useEffect, useState } from 'react';
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
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
    <section style={box} data-ivanti-connection-panel="true">
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Source connection</div>
        <h2 style={{ margin: '5px 0 4px' }}>Ivanti REST API connection</h2>
        <p style={{ margin: 0, color: '#626f86' }}>Connect directly to the Ivanti tenant so Request Offerings and workflow evidence can be discovered without browser Developer Tools.</p>
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

      {error && <div style={{ marginTop: 16, padding: 12, borderRadius: 4, background: '#ffebe6', color: '#ae2a19' }}><strong>Connection error:</strong> {error}</div>}
      {message && !error && <div style={{ marginTop: 16, padding: 12, borderRadius: 4, background: '#dcfff1', color: '#164b35' }}>{message}</div>}

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
    </section>,
    target
  );
}
