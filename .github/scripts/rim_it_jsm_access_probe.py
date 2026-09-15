#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'it-jsm-access-probe'
OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json'}
PROJECT_KEY='IT'; PROJECT_ID='12789'

def get(path):
    r=urllib.request.Request(f'https://{site}{path}',headers=HEAD)
    try:
        with urllib.request.urlopen(r,timeout=40) as x:
            raw=x.read().decode('utf-8','replace')
            try: body=json.loads(raw) if raw else {}
            except: body=raw
            return x.status,body
    except urllib.error.HTTPError as e:
        raw=e.read().decode('utf-8','replace')
        try: body=json.loads(raw) if raw else {}
        except: body=raw
        return e.code,body

checks={}
for label,path in {
    'myself':'/rest/api/3/myself',
    'project':'/rest/api/3/project/IT',
    'projectRoles':'/rest/api/3/project/IT/role',
    'myPermissions':'/rest/api/3/mypermissions?projectKey=IT',
    'serviceDesks':'/rest/servicedeskapi/servicedesk?start=0&limit=100',
    'requestTypesAll':'/rest/servicedeskapi/requesttype?start=0&limit=1',
}.items():
    s,b=get(path); checks[label]={'status':s,'body':b}

# Resolve the IT service desk from the service desk collection when available.
desk_id=None
sd=checks['serviceDesks']
if sd['status']==200 and isinstance(sd['body'],dict):
    for d in sd['body'].get('values',[]):
        if str(d.get('projectId',''))==PROJECT_ID or str(d.get('projectKey','')).upper()==PROJECT_KEY:
            desk_id=str(d.get('id')); break

# Probe documented identifier variants without any writes.
for ident in [PROJECT_KEY,f'projectKey:{PROJECT_KEY}',f'projectId:{PROJECT_ID}']:
    s,b=get(f'/rest/servicedeskapi/servicedesk/{ident}')
    checks[f'serviceDesk:{ident}']={'status':s,'body':b}

if desk_id:
    for suffix,key in [
        (f'/rest/servicedeskapi/servicedesk/{desk_id}/requesttype?limit=100&includeHiddenRequestTypesInSearch=true','requestTypes'),
        (f'/rest/servicedeskapi/servicedesk/{desk_id}/requesttypegroup?limit=100','requestTypeGroups'),
    ]:
        s,b=get(suffix); checks[f'{key}:desk:{desk_id}']={'status':s,'body':b}
else:
    for ident in [PROJECT_KEY,f'projectId:{PROJECT_ID}']:
        s,b=get(f'/rest/servicedeskapi/servicedesk/{ident}/requesttype?limit=100&includeHiddenRequestTypesInSearch=true')
        checks[f'requestTypes:{ident}']={'status':s,'body':b}

result={'mode':'READ_ONLY_JSM_IT_HELP_ACCESS_PROBE','projectKey':PROJECT_KEY,'projectId':PROJECT_ID,'resolvedServiceDeskId':desk_id,'checks':checks}
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({
    'projectKey':PROJECT_KEY,
    'projectId':PROJECT_ID,
    'resolvedServiceDeskId':desk_id,
    'statuses':{k:v['status'] for k,v in checks.items()}
},indent=2))
