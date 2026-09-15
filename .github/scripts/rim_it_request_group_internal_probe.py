#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

SITE = 'https://retailinmotion.atlassian.net'
PROJECT_KEY = 'IT'
PROJECT_ID = '12789'
SERVICE_DESK_ID = '2183'
TEST_GROUP_ID = '2256'
TEST_REQUEST_TYPE_ID = '2424'
OUT = Path('migration-output/it-request-type-groups/internal-probe.json')
OUT.parent.mkdir(parents=True, exist_ok=True)

email = os.environ.get('FORGE_EMAIL','').strip()
token = os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token:
    raise SystemExit('Missing FORGE_EMAIL/FORGE_API_TOKEN')
auth = base64.b64encode(f'{email}:{token}'.encode()).decode()
headers = {'Authorization': f'Basic {auth}', 'Accept': 'application/json', 'Content-Type': 'application/json'}

# Read-only discovery only. No Jira mutations are made here.
probes = [
    ('GET', f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups'),
    ('GET', f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{TEST_GROUP_ID}/request-types'),
    ('GET', f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{TEST_GROUP_ID}/request-types/{TEST_REQUEST_TYPE_ID}'),
    ('OPTIONS', f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{TEST_GROUP_ID}/request-types'),
    ('OPTIONS', f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{TEST_GROUP_ID}/request-types/{TEST_REQUEST_TYPE_ID}'),
]

def probe(method, path):
    req = urllib.request.Request(SITE + path, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode('utf-8','replace')
            try: body = json.loads(raw) if raw else None
            except Exception: body = raw
            return {'method':method,'path':path,'status':r.status,'allow':r.headers.get('Allow'),'body':body}
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8','replace')
        try: body = json.loads(raw) if raw else None
        except Exception: body = raw[:4000]
        return {'method':method,'path':path,'status':e.code,'allow':e.headers.get('Allow'),'body':body}

results = [probe(m,p) for m,p in probes]
OUT.write_text(json.dumps({'mode':'READ_ONLY_INTERNAL_GROUP_PROBE','projectKey':PROJECT_KEY,'projectId':PROJECT_ID,'serviceDeskId':SERVICE_DESK_ID,'results':results}, indent=2), encoding='utf-8')
for r in results:
    preview = r['body'] if isinstance(r['body'], (dict,list)) else str(r['body'])[:1000]
    print(json.dumps({'method':r['method'],'path':r['path'],'status':r['status'],'allow':r['allow'],'bodyPreview':preview}, default=str, separators=(',',':')))
