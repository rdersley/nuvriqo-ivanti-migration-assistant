#!/usr/bin/env python3
import base64
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'migration-output' / 'write-preflight'
OUT.mkdir(parents=True, exist_ok=True)

site = os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email = os.environ['FORGE_EMAIL']
token = os.environ['FORGE_API_TOKEN']
auth = base64.b64encode(f'{email}:{token}'.encode()).decode()
headers = {'Authorization': f'Basic {auth}', 'Accept': 'application/json'}


def get(path):
    req = urllib.request.Request(f'https://{site}{path}', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode('utf-8')
            return r.status, json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            data = json.loads(body)
        except Exception:
            data = body
        return e.code, data

permissions = [
    'ADMINISTER',
    'ADMINISTER_PROJECTS',
    'CREATE_ISSUES',
    'EDIT_ISSUES',
    'BROWSE_PROJECTS',
]
status, global_perms = get('/rest/api/3/mypermissions?' + urllib.parse.urlencode({'permissions': ','.join(permissions)}))

projects = {}
for key in ['IT', 'SD', 'YUEJ', 'SDTEST']:
    ps, pdata = get(f'/rest/api/3/project/{key}')
    row = {'projectStatus': ps, 'project': pdata if ps == 200 else None}
    if ps == 200:
        pid = pdata.get('id')
        qs = urllib.parse.urlencode({'permissions': ','.join(permissions), 'projectId': pid})
        ms, mdata = get('/rest/api/3/mypermissions?' + qs)
        row['permissionStatus'] = ms
        row['permissions'] = mdata
    projects[key] = row

result = {
    'mode': 'READ_ONLY_PERMISSION_PREFLIGHT',
    'site': site,
    'globalPermissionStatus': status,
    'globalPermissions': global_perms,
    'projects': projects,
    'note': 'No POST, PUT, PATCH or DELETE requests are made by this preflight.'
}
(OUT / 'preflight.json').write_text(json.dumps(result, indent=2), encoding='utf-8')

summary = {
    'mode': result['mode'],
    'globalPermissionStatus': status,
    'globalPermissions': {k: v.get('havePermission') for k, v in (global_perms or {}).get('permissions', {}).items()} if isinstance(global_perms, dict) else {},
    'projects': {}
}
for key, row in projects.items():
    perms = ((row.get('permissions') or {}).get('permissions') or {}) if isinstance(row.get('permissions'), dict) else {}
    summary['projects'][key] = {
        'projectStatus': row.get('projectStatus'),
        'name': (row.get('project') or {}).get('name'),
        'permissions': {k: v.get('havePermission') for k, v in perms.items()}
    }
print(json.dumps(summary, indent=2))
