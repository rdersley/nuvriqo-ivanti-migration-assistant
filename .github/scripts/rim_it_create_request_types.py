#!/usr/bin/env python3
import base64,json,os,sys,urllib.request,urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'it-request-types';OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/');email=os.environ['FORGE_EMAIL'];token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
BASE={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
DESK='2183'; PROJECT_KEY='IT'; PROJECT_ID='12789'
SERVICES=[
('AWS Account management','12525'),('Bitbucket Cloud Support','12526'),('Domain Password Reset','12527'),('Employee Move','12528'),('Leaver','12529'),('New Application Access Request','12530'),('New IT Software Request','12531'),('New Service Request','12532'),('New Vector System Provisioning','12533'),('Production Vector System Decommissioning','12534'),('Suspend Temporary Access','12535'),('Test Vector System Decommissioning','12536'),('UAT Vector System Decommissioning','12537'),('cBase Leaver','12538')]

def req(path,method='GET',body=None,extra=None):
 h=dict(BASE); h.update(extra or {})
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',headers=h,method=method,data=data)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode('utf-8','replace')
   try:b=json.loads(raw) if raw else {}
   except:b=raw
   return x.status,b
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw) if raw else {}
  except:b=raw
  return e.code,b

# Hard target guard.
st,proj=req(f'/rest/api/3/project/{PROJECT_KEY}')
if st!=200 or str((proj or {}).get('id'))!=PROJECT_ID:
 print(json.dumps({'status':'blocked','reason':'IT target guard failed','http':st,'project':proj},indent=2));sys.exit(2)

st,existing=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
if st!=200:
 print(json.dumps({'status':'blocked','reason':'cannot list IT request types','http':st,'body':existing},indent=2));sys.exit(2)
vals=existing.get('values',[]) if isinstance(existing,dict) else []
results=[]
for name,issue_type_id in SERVICES:
 same=[x for x in vals if str(x.get('name','')).strip().casefold()==name.casefold()]
 exact=next((x for x in same if str(x.get('issueTypeId',''))==issue_type_id),None)
 if exact:
  results.append({'name':name,'issueTypeId':issue_type_id,'status':'reused','requestTypeId':str(exact.get('id'))});continue
 payload={'name':name,'description':f'Migrated from Ivanti: {name}','helpText':f'Migrated from Ivanti: {name}','issueTypeId':issue_type_id}
 cs,created=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype','POST',payload,{'X-ExperimentalApi':'opt-in'})
 if cs not in (200,201):
  results.append({'name':name,'issueTypeId':issue_type_id,'status':'failed','http':cs,'body':created});continue
 results.append({'name':name,'issueTypeId':issue_type_id,'status':'created','requestTypeId':str((created or {}).get('id','')),'http':cs})

# Read back and verify all 14 canonical name/issue-type pairs.
rs,readback=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
rvals=readback.get('values',[]) if rs==200 and isinstance(readback,dict) else []
missing=[]
for name,issue_type_id in SERVICES:
 if not any(str(x.get('name','')).strip().casefold()==name.casefold() and str(x.get('issueTypeId',''))==issue_type_id for x in rvals): missing.append({'name':name,'issueTypeId':issue_type_id})
summary={'mode':'LIVE_IT_REQUEST_TYPES','projectKey':PROJECT_KEY,'projectId':PROJECT_ID,'serviceDeskId':DESK,'created':sum(x['status']=='created' for x in results),'reused':sum(x['status']=='reused' for x in results),'failed':sum(x['status']=='failed' for x in results),'readBackStatus':rs,'missingAfterReadBack':missing,'results':results}
(OUT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary,indent=2))
if summary['failed'] or missing: sys.exit(2)
