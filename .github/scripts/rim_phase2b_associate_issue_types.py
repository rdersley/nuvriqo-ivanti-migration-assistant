#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'live-create-phase2b'
OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
SCHEME_ID='10766'
PROJECT_ID='10221'
ISSUE_TYPES={
 'AWS Account management':'12525','Bitbucket Cloud Support':'12526','Domain Password Reset':'12527','Employee Move':'12528','Leaver':'12529',
 'New Application Access Request':'12530','New IT Software Request':'12531','New Service Request':'12532','New Vector System Provisioning':'12533',
 'Production Vector System Decommissioning':'12534','Suspend Temporary Access':'12535','Test Vector System Decommissioning':'12536',
 'UAT Vector System Decommissioning':'12537','cBase Leaver':'12538'
}
CLEANUP_IDS=['customfield_14504','customfield_14512','customfield_14516','customfield_14525']

def req(method,path,body=None,follow_redirects=True):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',data=data,headers=HEAD,method=method)
 opener=urllib.request.build_opener() if follow_redirects else urllib.request.build_opener(urllib.request.HTTPHandler())
 try:
  with opener.open(r,timeout=40) as x:
   raw=x.read().decode();
   try:b=json.loads(raw) if raw else {}
   except:b=raw
   return x.status,b,dict(x.headers)
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw) if raw else {}
  except:b=raw
  return e.code,b,dict(e.headers)

def custom_ids():
 ids=set();start=0
 while True:
  s,b,_=req('GET',f'/rest/api/3/field/search?type=custom&startAt={start}&maxResults=100')
  if s!=200 or not isinstance(b,dict): raise SystemExit(f'field search failed {s}: {b}')
  vals=b.get('values') or []
  for f in vals:
   if f.get('id'): ids.add(str(f['id']))
  start+=len(vals)
  if not vals or start>=int(b.get('total') or 0):break
 return ids

# Verify asynchronous cleanup accepted by prior 303 responses has completed.
before_ids=custom_ids()
cleanup={fid:('absent' if fid not in before_ids else 'still-present') for fid in CLEANUP_IDS}

# Get current issue-type scheme mappings, then add only issue types that are not already present.
s,mapping,_=req('GET',f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={SCHEME_ID}&maxResults=100')
if s!=200 or not isinstance(mapping,dict): raise SystemExit(f'scheme mapping failed {s}: {mapping}')
existing={str(v.get('issueTypeId')) for v in (mapping.get('values') or []) if str(v.get('issueTypeSchemeId'))==SCHEME_ID}
wanted=set(ISSUE_TYPES.values())
missing=sorted(wanted-existing,key=int)
add_status='nothing-to-add'; add_http=None; add_body=None
if missing:
 add_http,add_body,_=req('PUT',f'/rest/api/3/issuetypescheme/{SCHEME_ID}/issuetype',{'issueTypeIds':missing})
 add_status='added' if add_http==204 else 'failed'

# Read back complete scheme mapping and SD project issue types.
rs,rmapping,_=req('GET',f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={SCHEME_ID}&maxResults=100')
now={str(v.get('issueTypeId')) for v in (rmapping.get('values') or []) if str(v.get('issueTypeSchemeId'))==SCHEME_ID} if rs==200 and isinstance(rmapping,dict) else set()
ps,project,_=req('GET','/rest/api/3/project/SD')
project_issue_ids={str(x.get('id')) for x in (project.get('issueTypes') or [])} if ps==200 and isinstance(project,dict) else set()
missing_from_scheme=sorted(wanted-now,key=int)
missing_from_project=sorted(wanted-project_issue_ids,key=int)
summary={
 'mode':'LIVE_PHASE2B_ASSOCIATE_ISSUE_TYPES',
 'projectId':PROJECT_ID,
 'projectKey':'SD',
 'issueTypeSchemeId':SCHEME_ID,
 'cleanupVerification':cleanup,
 'preExistingInScheme':sorted(wanted & existing,key=int),
 'requestedAdditions':missing,
 'addStatus':add_status,
 'addHttp':add_http,
 'addBody':add_body if add_status=='failed' else None,
 'schemeReadBackStatus':rs,
 'missingFromSchemeAfterWrite':missing_from_scheme,
 'projectReadBackStatus':ps,
 'missingFromProjectAfterWrite':missing_from_project,
 'projectIssueTypes':[{'id':x.get('id'),'name':x.get('name')} for x in (project.get('issueTypes') or [])] if isinstance(project,dict) else [],
}
(OUT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in {'projectIssueTypes','addBody'}},indent=2))
if add_status=='failed' or missing_from_scheme or missing_from_project: raise SystemExit(2)
