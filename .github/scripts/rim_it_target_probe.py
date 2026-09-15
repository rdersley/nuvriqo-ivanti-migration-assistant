#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'it-target-probe'
OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
MIGRATED_IDS=['12525','12526','12527','12528','12529','12530','12531','12532','12533','12534','12535','12536','12537','12538']

def req(method,path,body=None):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',data=data,headers=HEAD,method=method)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode(); return x.status,json.loads(raw) if raw else {}
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw)
  except:b=raw
  return e.code,b

def issue_count(project_key, issue_type_id):
 jql=f'project = {project_key} AND issuetype = {issue_type_id}'
 s,b=req('POST','/rest/api/3/search/approximate-count',{'jql':jql})
 return {'status':s,'count':(b or {}).get('count') if isinstance(b,dict) else None,'body':b if s!=200 else None}

result={'mode':'READ_ONLY_IT_TARGET_PROBE','site':site}
ps,p=req('GET','/rest/api/3/project/IT')
result['projectStatus']=ps
result['project']=p
if ps!=200 or not isinstance(p,dict):
 (OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
 print(json.dumps(result,indent=2)); raise SystemExit(2)
if str(p.get('key','')).upper()!='IT': raise SystemExit('Resolved project is not IT')
pid=str(p.get('id'))
ss,sbody=req('GET',f'/rest/api/3/issuetypescheme/project?projectId={pid}')
result['schemeLookupStatus']=ss; result['schemeLookup']=sbody
scheme_id=None
if ss==200 and isinstance(sbody,dict):
 for entry in sbody.get('values',[]):
  if pid in [str(x) for x in entry.get('projectIds',[])]:
   scheme_id=str((entry.get('issueTypeScheme') or {}).get('id') or '')
   if scheme_id: break
result['issueTypeSchemeId']=scheme_id
if scheme_id:
 ms,mb=req('GET',f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={scheme_id}&maxResults=1000')
 result['schemeMappingsStatus']=ms
 vals=(mb or {}).get('values',[]) if isinstance(mb,dict) else []
 present={str(v.get('issueTypeId')) for v in vals}
 result['migratedAlreadyInItScheme']=[i for i in MIGRATED_IDS if i in present]
 result['migratedMissingFromItScheme']=[i for i in MIGRATED_IDS if i not in present]
# verify mistaken SD usage before any removal
result['sdUsage']={i:issue_count('SD',i) for i in MIGRATED_IDS}
result['itUsage']={i:issue_count('IT',i) for i in MIGRATED_IDS}
# JSM read-only probes for IT
for label,path in {
 'serviceDeskByProjectKey':'/rest/servicedeskapi/servicedesk/IT',
 f'serviceDeskByProjectId:{pid}':f'/rest/servicedeskapi/servicedesk/{pid}',
}.items():
 s,b=req('GET',path); result[label]={'status':s,'body':b}
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
