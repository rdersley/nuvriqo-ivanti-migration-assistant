#!/usr/bin/env python3
import base64,json,os,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'sd-role-probe';OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/');email=os.environ['FORGE_EMAIL'];token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode();HEAD={'Authorization':f'Basic {auth}','Accept':'application/json'}
def get(path):
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD)
 try:
  with urllib.request.urlopen(r,timeout=30) as x:
   raw=x.read().decode();return x.status,json.loads(raw) if raw else {}
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw)
  except:b=raw
  return e.code,b
s,me=get('/rest/api/3/myself')
rs,roles=get('/rest/api/3/project/SD/role')
role_data={}
if rs==200 and isinstance(roles,dict):
 for name,url in roles.items():
  path=url.split('.atlassian.net',1)[-1] if '.atlassian.net' in url else url
  st,body=get(path)
  role_data[name]={'status':st,'body':body}
result={'mode':'READ_ONLY_SD_ROLE_PROBE','myselfStatus':s,'myself':me,'rolesStatus':rs,'roles':role_data}
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({'myselfStatus':s,'accountId':me.get('accountId') if isinstance(me,dict) else None,'displayName':me.get('displayName') if isinstance(me,dict) else None,'roles':{k:{'status':v['status'],'id':(v['body'].get('id') if isinstance(v['body'],dict) else None),'actors':[{'displayName':a.get('displayName'),'type':a.get('type'),'accountId':((a.get('actorUser') or {}).get('accountId'))} for a in ((v['body'].get('actors') or []) if isinstance(v['body'],dict) else [])]} for k,v in role_data.items()}},indent=2))
