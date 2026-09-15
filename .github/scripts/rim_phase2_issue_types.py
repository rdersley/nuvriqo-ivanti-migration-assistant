#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'
PLAN=OUT/'jira-creation-plan.json'
REPORT=OUT/'live-create-phase2'
REPORT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}

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

def norm(v):return ' '.join(str(v or '').lower().split())

def all_custom_fields():
 out=[]; start=0
 while True:
  s,b=req('GET',f'/rest/api/3/field/search?type=custom&startAt={start}&maxResults=100')
  if s!=200 or not isinstance(b,dict): raise SystemExit(f'custom field catalogue failed {s}: {b}')
  vals=b.get('values') or []; out.extend(vals); start+=len(vals)
  if not vals or start>=int(b.get('total') or 0):break
 return out

# These four were created by the first controlled migration pass before Jira's complete
# custom-field catalogue was used for collision detection. The second pass created the
# intended collision-safe - Ivanti variants. Delete only these known migration-created IDs,
# and only when a same-name peer or - Ivanti replacement is present.
cleanup_allow={
 'customfield_14504':'Date required',
 'customfield_14512':'Forward Email',
 'customfield_14516':'Is it a new supplier?',
 'customfield_14525':'Performance Evaluation Tool',
}
fields=all_custom_fields(); byid={f.get('id'):f for f in fields}; byname={}
for f in fields:byname.setdefault(norm(f.get('name')),[]).append(f)
cleanup=[]
for fid,name in cleanup_allow.items():
 f=byid.get(fid)
 if not f:
  cleanup.append({'id':fid,'name':name,'status':'already-absent'});continue
 peers=[x for x in byname.get(norm(name),[]) if x.get('id')!=fid]
 replacements=byname.get(norm(name+' - Ivanti'),[])
 if not peers and not replacements:
  cleanup.append({'id':fid,'name':name,'status':'kept','reason':'no independently verified duplicate/replacement'});continue
 s,b=req('DELETE',f'/rest/api/3/field/{fid}')
 cleanup.append({'id':fid,'name':name,'status':'deleted' if s in (204,200) else 'delete-failed','http':s,'body':b if s not in (204,200) else None})

plan=json.loads(PLAN.read_text())
s,types=req('GET','/rest/api/3/issuetype')
if s!=200 or not isinstance(types,list):raise SystemExit(f'issue type inventory failed {s}: {types}')
byname_it={norm(t.get('name')):t for t in types if t.get('name')}
created=[]
for svc in plan.get('services',[]):
 name=str(svc.get('name') or '').strip()
 if not name:continue
 ex=byname_it.get(norm(name))
 if ex:
  created.append({'service':name,'status':'reused','id':ex.get('id')});continue
 body={'name':name,'description':str(svc.get('description') or '').strip() or f'Migrated from Ivanti request offering: {name}','type':'standard'}
 cs,c=req('POST','/rest/api/3/issuetype',body)
 if cs not in (200,201):
  created.append({'service':name,'status':'failed','http':cs,'error':c});continue
 byname_it[norm(name)]=c
 created.append({'service':name,'status':'created','id':c.get('id')})

vs,vtypes=req('GET','/rest/api/3/issuetype')
verify={norm(t.get('name')):t.get('id') for t in vtypes} if vs==200 and isinstance(vtypes,list) else {}
for r in created:
 r['readBackId']=verify.get(norm(r['service']));r['readBackOk']=bool(r['readBackId'])

# Read target project metadata and current issue-type scheme without changing it yet.
ps,project=req('GET','/rest/api/3/project/SD')
scheme_status,scheme=req('GET',f"/rest/api/3/issuetypescheme/project?projectId={(project or {}).get('id','')}" ) if ps==200 else (0,{})
summary={
 'mode':'LIVE_PHASE2_ISSUE_TYPES',
 'targetProjectKey':'SD',
 'cleanup':cleanup,
 'issueTypesCreated':sum(r['status']=='created' for r in created),
 'issueTypesReused':sum(r['status']=='reused' for r in created),
 'issueTypesFailed':sum(r['status']=='failed' for r in created),
 'readBackFailures':sum(r.get('readBackOk') is False for r in created),
 'targetProject':project if ps==200 else {'status':ps},
 'issueTypeSchemeStatus':scheme_status,
 'issueTypeScheme':scheme,
 'results':created,
}
(REPORT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k not in {'results','issueTypeScheme','targetProject','cleanup'}},indent=2))
for x in cleanup:print('cleanup',x['id'],x['status'])
for r in created:print(r['service'],r['status'],r.get('id',''))
if summary['issueTypesFailed'] or summary['readBackFailures'] or any(x['status']=='delete-failed' for x in cleanup):raise SystemExit(2)
