from pathlib import Path

p = Path('static/src/App.tsx')
s = p.read_text()

needle = "  const [successMessage, setSuccessMessage] = useState('');\n  const fileInput = useRef<HTMLInputElement>(null);"
replacement = """  const [successMessage, setSuccessMessage] = useState('');
  const [ivantiSourceMode, setIvantiSourceMode] = useState<'files' | 'connection'>('files');
  const [ivantiBaseUrl, setIvantiBaseUrl] = useState('');
  const [ivantiApiKey, setIvantiApiKey] = useState('');
  const [ivantiConnectionBusy, setIvantiConnectionBusy] = useState(false);
  const [ivantiConnectionStatus, setIvantiConnectionStatus] = useState('');
  const [ivantiOfferings, setIvantiOfferings] = useState<Array<{recId:string;name:string;description?:string}>>([]);
  const fileInput = useRef<HTMLInputElement>(null);"""
if needle in s and 'ivantiSourceMode' not in s:
    s = s.replace(needle, replacement)

# Add direct read-only discovery handlers inside the React component.
anchor = "  useEffect(() => {\n    invoke('getProjects')"
if anchor in s and 'async function testIvantiConnection()' not in s:
    functions = r'''  async function testIvantiConnection() {
    if (!ivantiBaseUrl.trim() || !ivantiApiKey.trim()) {
      setMessage('Enter the Ivanti tenant URL and REST API key.');
      return;
    }
    setIvantiConnectionBusy(true);
    setMessage('');
    setSuccessMessage('');
    setIvantiConnectionStatus('Testing read-only Ivanti connection...');
    try {
      const result = await invoke('testIvantiConnection', {
        baseUrl: ivantiBaseUrl.trim(),
        apiKey: ivantiApiKey.trim()
      }) as unknown as { ok:boolean; tenantHost:string; sampleCount:number };
      setIvantiConnectionStatus(`Connected to ${result.tenantHost}. Read-only API access confirmed.`);
      setSuccessMessage('Ivanti connection verified.');
    } catch (error) {
      setIvantiConnectionStatus('');
      setMessage(`Ivanti connection failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIvantiConnectionBusy(false);
    }
  }

  async function discoverIvantiEstate() {
    if (!ivantiBaseUrl.trim() || !ivantiApiKey.trim()) {
      setMessage('Enter the Ivanti tenant URL and REST API key.');
      return;
    }
    setIvantiConnectionBusy(true);
    setMessage('');
    setSuccessMessage('');
    setIvantiConnectionStatus('Discovering Request Offerings from Ivanti...');
    try {
      const result = await invoke('discoverIvantiOfferings', {
        baseUrl: ivantiBaseUrl.trim(),
        apiKey: ivantiApiKey.trim()
      }) as unknown as { offerings:Array<{recId:string;name:string;description?:string}>; total:number; tenantHost:string };
      setIvantiOfferings(result.offerings || []);
      setIvantiConnectionStatus(`Connected to ${result.tenantHost}. ${result.total} Request Offering record(s) discovered.`);
      setSuccessMessage(`Ivanti discovery completed: ${result.total} Request Offering record(s) found.`);
    } catch (error) {
      setIvantiOfferings([]);
      setIvantiConnectionStatus('');
      setMessage(`Ivanti discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIvantiConnectionBusy(false);
    }
  }

'''
    s = s.replace(anchor, functions + anchor, 1)

# Add a source-acquisition panel immediately before the existing hidden file input.
needle2 = '<input ref={fileInput} type="file"'
if needle2 in s and 'Ivanti source acquisition' not in s:
    panel = r'''<div className="card" style={{marginBottom:12}}>
        <div className="section-title">Ivanti source acquisition</div>
        <div className="hint">Use exported files immediately, or connect read-only to Ivanti to discover the source estate. Workflow Instance/GetInstance remains the fallback for workflow graphs.</div>
        <div className="button-row" style={{marginTop:10}}>
          <button className={ivantiSourceMode === 'files' ? 'primary' : ''} onClick={() => setIvantiSourceMode('files')}>Import Ivanti files</button>
          <button className={ivantiSourceMode === 'connection' ? 'primary' : ''} onClick={() => setIvantiSourceMode('connection')}>Connect to Ivanti</button>
        </div>
        {ivantiSourceMode === 'files' ? (
          <div className="hint" style={{marginTop:10}}>Select Request Offering .rox/XML plus native workflow .xml when available. Multiple files are supported and matching workflows are paired automatically. GetInstance JSON is still accepted as a fallback.</div>
        ) : (
          <div style={{marginTop:10}}>
            <label>Ivanti tenant URL</label>
            <input value={ivantiBaseUrl} onChange={(event) => setIvantiBaseUrl(event.target.value)} placeholder="https://your-tenant.example.com" />
            <label style={{marginTop:8}}>Ivanti REST API key</label>
            <input type="password" autoComplete="off" value={ivantiApiKey} onChange={(event) => setIvantiApiKey(event.target.value)} placeholder="REST API key Reference ID" />
            <div className="hint" style={{marginTop:8}}>The key is sent only to the Forge backend for this request and is not stored in the migration project or browser storage.</div>
            <div className="button-row" style={{marginTop:10}}>
              <button onClick={() => void testIvantiConnection()} disabled={ivantiConnectionBusy}>{ivantiConnectionBusy ? 'Working...' : 'Test connection'}</button>
              <button className="primary" onClick={() => void discoverIvantiEstate()} disabled={ivantiConnectionBusy}>{ivantiConnectionBusy ? 'Discovering...' : 'Discover Request Offerings'}</button>
            </div>
            {ivantiConnectionStatus && <div className="status success" style={{marginTop:8}}>{ivantiConnectionStatus}</div>}
            {ivantiOfferings.length > 0 && (
              <div style={{marginTop:10}}>
                <div className="hint">First {Math.min(ivantiOfferings.length, 20)} discovered offering(s):</div>
                <div style={{maxHeight:260,overflow:'auto',marginTop:6}}>
                  {ivantiOfferings.slice(0,20).map((offering) => (
                    <div key={offering.recId || offering.name} className="sub-card" style={{marginBottom:6}}>
                      <strong>{offering.name || '(Unnamed Request Offering)'}</strong>
                      {offering.description && <div className="hint">{offering.description}</div>}
                      {offering.recId && <div className="hint">RecId: {offering.recId}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      '''
    s = s.replace(needle2, panel + needle2, 1)

p.write_text(s)
print('Applied functional Ivanti source acquisition UI')
