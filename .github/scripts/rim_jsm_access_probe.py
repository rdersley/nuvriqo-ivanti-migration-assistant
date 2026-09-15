#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'jsm-access-probe'
OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL'];token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json'}

def get(path):
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode();
   try:b=json.loads(raw) if raw else {}
   except:b=raw
   return x.status,b
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw) if raw else {}
  except:b=raw
  return e.code,b

checks={}
for ident in ['SD','projectKey:SD','projectId:10221']:
 s,b=get(f'/rest/servicedeskapi/servicedesk/{ident}')
 checks[f'serviceDesk:{ident}']={'status':s,'body':b}
for ident in ['SD','projectKey:SD','projectId:10221']:
 s,b=get(f'/rest/servicedeskapi/servicedesk/{ident}/requesttype?limit=100&includeHiddenRequestTypesInSearch=true')
 checks[f'requestTypes:{ident}']={'status':s,'body':b}
s,b=get('/rest/servicedeskapi/servicedesk/SD/requesttypegroup?limit=100')
checks['requestTypeGroups:SD']={'status':s,'body':b}
summary={'mode':'READ_ONLY_JSM_SD_ACCESS_PROBE','checks':checks}
(OUT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:{'status':v['status'],'error':(v['body'].get('errorMessage') if isinstance(v['body'],dict) else str(v['body'])[:180])} for k,v in checks.items()},indent=2))
