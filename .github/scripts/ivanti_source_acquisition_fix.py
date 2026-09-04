from pathlib import Path

p = Path('static/src/App.tsx')
s = p.read_text()

needle = "  const [successMessage, setSuccessMessage] = useState('');\n  const fileInput = useRef<HTMLInputElement>(null);"
replacement = """  const [successMessage, setSuccessMessage] = useState('');
  const [ivantiSourceMode, setIvantiSourceMode] = useState<'files' | 'connection'>('files');
  const [ivantiBaseUrl, setIvantiBaseUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);"""
if needle in s and 'ivantiSourceMode' not in s:
    s = s.replace(needle, replacement)

# Add a source-acquisition panel immediately before the existing hidden file input.
needle2 = '<input ref={fileInput} type="file"'
if needle2 in s and 'Ivanti source acquisition' not in s:
    panel = """<div className=\"card\" style={{marginBottom:12}}>
        <div className=\"section-title\">Ivanti source acquisition</div>
        <div className=\"hint\">Use exported files today, or prepare a read-only Ivanti connection for estate discovery. Workflow Instance/GetInstance remains the emergency fallback.</div>
        <div className=\"button-row\" style={{marginTop:10}}>
          <button className={ivantiSourceMode === 'files' ? 'primary' : ''} onClick={() => setIvantiSourceMode('files')}>Import Ivanti files</button>
          <button className={ivantiSourceMode === 'connection' ? 'primary' : ''} onClick={() => setIvantiSourceMode('connection')}>Connect to Ivanti</button>
        </div>
        {ivantiSourceMode === 'files' ? (
          <div className=\"hint\" style={{marginTop:10}}>Select Request Offering .rox/XML plus native workflow .xml when available. Multiple files are supported and matching workflows are paired automatically. GetInstance JSON is still accepted as a fallback.</div>
        ) : (
          <div style={{marginTop:10}}>
            <label>Ivanti tenant URL</label>
            <input value={ivantiBaseUrl} onChange={(event) => setIvantiBaseUrl(event.target.value)} placeholder=\"https://your-tenant.example.com\" />
            <div className=\"hint\" style={{marginTop:8}}>Read-only discovery is being prepared around Ivanti business-object search and workflow-instance retrieval. Credentials are deliberately not collected in the browser yet; authentication will be handled securely by the Forge backend.</div>
            <div className=\"status warning\" style={{marginTop:8}}>Connection discovery foundation ready — authentication and tenant endpoint verification required before live use.</div>
          </div>
        )}
      </div>
      """
    s = s.replace(needle2, panel + needle2, 1)

p.write_text(s)
print('Applied Ivanti source acquisition UI foundation')
