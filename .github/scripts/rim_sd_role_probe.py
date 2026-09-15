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
account_id=me.get('accountId') if isinstance(me,dict) else None
extra={}
probes={
 'applicationRoles':'/rest/api/3/applicationrole',
 'myPermissionsSD':'/rest/api/3/mypermissions?projectKey=SD',
 'userGroups':f'/rest/api/3/user/groups?accountId={account_id}' if account_id else None,
 'serviceDesks':'/rest/servicedeskapi/servicedesk?start=0&limit=100',
 'requestTypesAll':'/rest/servicedeskapi/requesttype?start=0&limit=1'
}
for name,path in probes.items():
 if path:
  st,body=get(path);extra[name]={'status':st,'body':body}
result={'mode':'READ_ONLY_SD_ROLE_AND_ENTITLEMENT_PROBE','myselfStatus':s,'myself':me,'rolesStatus':rs,'roles':role_data,'probes':extra}
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
summary={'myselfStatus':s,'accountId':account_id,'displayName':me.get('displayName') if isinstance(me,dict) else None,
 'roleMemberships':[{'name':k,'id':(v['body'].get('id') if isinstance(v['body'],dict) else None)} for k,v in role_data.items() if isinstance(v['body'],dict) and any(((a.get('actorUser') or {}).get('accountId')==account_id) for a in (v['body'].get('actors') or []))],
 'probeStatuses':{k:v['status'] for k,v in extra.items()}}
print(json.dumps(summary,indent=2))
