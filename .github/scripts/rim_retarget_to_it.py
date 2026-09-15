#!/usr/bin/env python3
import base64,json,os,urllib.request,urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'retarget-it';OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL'];token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
MIGRATED_IDS=['12525','12526','12527','12528','12529','12530','12531','12532','12533','12534','12535','12536','12537','12538']
OLD_SCHEME='10766'

def req(method,path,body=None):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD,data=data,method=method)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode();return x.status,json.loads(raw) if raw else {}
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw)
  except:b=raw
  return e.code,b

def scheme_for_project(pid):
 s,b=req('GET',f'/rest/api/3/issuetypescheme/project?projectId={pid}')
 if s!=200:return s,None,b
 vals=b.get('values',[]) if isinstance(b,dict) else []
 for row in vals:
  if str(pid) in [str(x) for x in row.get('projectIds',[])]:
   return s,row.get('issueTypeScheme'),b
 return s,None,b

def scheme_members(sid):
 s,b=req('GET',f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={sid}&maxResults=500')
 ids=[]
 if s==200 and isinstance(b,dict):
  ids=[str(v.get('issueTypeId')) for v in b.get('values',[]) if v.get('issueTypeId') is not None]
 return s,ids,b

ps,proj=req('GET','/rest/api/3/project/IT')
result={'mode':'LIVE_RETARGET_TO_IT','projectLookupStatus':ps,'project':proj if ps==200 else None}
if ps!=200 or not isinstance(proj,dict):
 result['status']='blocked';result['reason']='IT project could not be resolved';
 (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)

pid=str(proj.get('id',''));pname=str(proj.get('name',''));pkey=str(proj.get('key',''))
result['targetProjectId']=pid;result['targetProjectKey']=pkey;result['targetProjectName']=pname
if pkey!='IT':
 result['status']='blocked';result['reason']=f'Expected project key IT, got {pkey}'
 (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)

ss,scheme,raw=scheme_for_project(pid)
result['targetSchemeLookupStatus']=ss;result['targetScheme']=scheme
if ss!=200 or not scheme or not scheme.get('id'):
 result['status']='blocked';result['reason']='Could not resolve IT project issue type scheme'
 (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)

target_sid=str(scheme['id']);result['targetSchemeId']=target_sid
# Verify migrated issue types still exist before changing schemes.
is_,all_types=req('GET','/rest/api/3/issuetype')
existing={str(x.get('id')):x.get('name') for x in all_types} if is_==200 and isinstance(all_types,list) else {}
missing_types=[x for x in MIGRATED_IDS if x not in existing]
result['migratedIssueTypes']=[{'id':x,'name':existing.get(x)} for x in MIGRATED_IDS]
result['missingIssueTypes']=missing_types
if missing_types:
 result['status']='blocked';result['reason']='One or more migrated issue types are missing'
 (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)

# Check whether any issues already use these new types in the mistakenly targeted SD project.
jql='project = SD AND issuetype in ('+','.join(MIGRATED_IDS)+')'
cs,count=req('POST','/rest/api/3/search/approximate-count',{'jql':jql})
result['sdUsageCheckStatus']=cs;result['sdIssueCountUsingMigratedTypes']=count.get('count') if cs==200 and isinstance(count,dict) else None

# Add all 14 to IT's existing issue type scheme if needed.
ms,before,_=scheme_members(target_sid);result['targetSchemeReadBeforeStatus']=ms
missing_target=[x for x in MIGRATED_IDS if x not in before]
result['missingFromTargetBefore']=missing_target
if missing_target:
 add_s,add_b=req('PUT',f'/rest/api/3/issuetypescheme/{target_sid}/issuetype',{'issueTypeIds':missing_target})
 result['targetAddStatus']=add_s;result['targetAddBody']=add_b
 if add_s not in (200,204):
  result['status']='blocked';result['reason']='Failed adding migrated issue types to IT scheme'
  (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)
else:
 result['targetAddStatus']='already-present'

vs,after,_=scheme_members(target_sid);missing_after=[x for x in MIGRATED_IDS if x not in after]
result['targetSchemeReadAfterStatus']=vs;result['missingFromTargetAfter']=missing_after
if missing_after:
 result['status']='blocked';result['reason']='Target scheme read-back failed after association'
 (OUT/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));raise SystemExit(2)

# Correct the earlier SD association only when IT uses a different scheme and no SD issues use the migrated types.
cleanup=[]
if target_sid==OLD_SCHEME:
 result['oldSchemeCleanup']='skipped-shared-scheme'
elif cs!=200:
 result['oldSchemeCleanup']='skipped-usage-check-unavailable'
elif int(count.get('count',0))!=0:
 result['oldSchemeCleanup']='skipped-migrated-types-in-use-in-SD'
else:
 old_s,old_ids,_=scheme_members(OLD_SCHEME);result['oldSchemeReadStatus']=old_s
 if old_s==200:
  for iid in MIGRATED_IDS:
   if iid not in old_ids:
    cleanup.append({'id':iid,'status':'already-absent'});continue
   ds,db=req('DELETE',f'/rest/api/3/issuetypescheme/{OLD_SCHEME}/issuetype/{iid}')
   cleanup.append({'id':iid,'status':'removed' if ds in (200,204) else 'failed','http':ds,'body':db})
  result['oldSchemeCleanup']=cleanup
  _,old_after,_=scheme_members(OLD_SCHEME)
  result['stillInOldSchemeAfterCleanup']=[x for x in MIGRATED_IDS if x in old_after]
 else:
  result['oldSchemeCleanup']='skipped-old-scheme-read-failed'

result['status']='success'
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({
 'status':result['status'],'targetProject':f'{pname} ({pkey})','targetProjectId':pid,'targetSchemeId':target_sid,
 'missingFromTargetAfter':result.get('missingFromTargetAfter',[]),'sdIssueCountUsingMigratedTypes':result.get('sdIssueCountUsingMigratedTypes'),
 'oldSchemeCleanup':result.get('oldSchemeCleanup'),'stillInOldSchemeAfterCleanup':result.get('stillInOldSchemeAfterCleanup',[])
},indent=2))
