#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from collections import defaultdict
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'
PLAN=OUT/'jira-creation-plan.json'
REPORT=OUT/'live-create-phase1'
REPORT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}

TYPE_DEF={
 'text':('com.atlassian.jira.plugin.system.customfieldtypes:textfield','com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
 'paragraph':('com.atlassian.jira.plugin.system.customfieldtypes:textarea','com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
 'date':('com.atlassian.jira.plugin.system.customfieldtypes:datepicker','com.atlassian.jira.plugin.system.customfieldtypes:daterange'),
 'select':('com.atlassian.jira.plugin.system.customfieldtypes:select','com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
 'checkbox':('com.atlassian.jira.plugin.system.customfieldtypes:select','com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
 'user':('com.atlassian.jira.plugin.system.customfieldtypes:userpicker','com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'),
 'number':('com.atlassian.jira.plugin.system.customfieldtypes:float','com.atlassian.jira.plugin.system.customfieldtypes:exactnumber'),
}

def req(method,path,body=None):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',data=data,headers=HEAD,method=method)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode(); return x.status,json.loads(raw) if raw else {}
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try: b=json.loads(raw)
  except: b=raw
  return e.code,b

def norm(v): return ' '.join(str(v or '').lower().split())

def custom_kind(f):
 c=str((f.get('schema') or {}).get('custom') or '')
 if 'textarea' in c:return 'paragraph'
 if 'textfield' in c:return 'text'
 if 'datepicker' in c:return 'date'
 if 'userpicker' in c:return 'user'
 if c.endswith(':select'):return 'select'
 return None

def all_fields():
 # /field can omit newly-created custom fields until they are associated with screens.
 # Combine it with the paginated custom-field search endpoint used by the app itself.
 s,base=req('GET','/rest/api/3/field')
 if s!=200 or not isinstance(base,list):
  raise SystemExit(f'Cannot inventory Jira fields: {s} {base}')
 merged={str(f.get('id')):f for f in base if f.get('id')}
 start=0
 while True:
  cs,body=req('GET',f'/rest/api/3/field/search?type=custom&startAt={start}&maxResults=100')
  if cs!=200 or not isinstance(body,dict):
   raise SystemExit(f'Cannot inventory custom fields: {cs} {body}')
  vals=body.get('values') or []
  for f in vals:
   if f.get('id'): merged[str(f.get('id'))]=f
  start += len(vals)
  total=int(body.get('total') or 0)
  if not vals or start>=total: break
 return list(merged.values())

plan=json.loads(PLAN.read_text())
groups=defaultdict(lambda:{'types':set(),'options':[],'services':set(),'description':''})
for svc in plan.get('services',[]):
 for f in svc.get('fields',[]):
  k=norm(f.get('name'))
  if not k: continue
  g=groups[k]; g['name']=f['name']; g['types'].add(f.get('jiraType')); g['services'].add(svc['name'])
  if not g['description']: g['description']=f.get('description') or ''
  for o in f.get('options',[]):
   if o not in g['options']: g['options'].append(o)

fields=all_fields()
byname=defaultdict(list)
for f in fields: byname[norm(f.get('name'))].append(f)
results=[]
for key,g in sorted(groups.items()):
 types=sorted(t for t in g['types'] if t)
 if 'lookup-select' in types:
  results.append({'sourceName':g['name'],'status':'deferred','reason':'lookup-backed field requires source-value resolution'}); continue
 if len(types)>1:
  if key=='name':
   variants=[('Name - Ivanti Person','user',['Leaver','Suspend Temporary Access']),('Name - cBase Leaver','text',['cBase Leaver'])]
  else:
   results.append({'sourceName':g['name'],'status':'deferred','reason':f'type conflict: {types}'}); continue
 else: variants=[(g['name'],types[0] if types else 'text',sorted(g['services']))]
 for desired,jtype,services in variants:
  options=list(g['options']) if jtype in {'select','checkbox'} else []
  if jtype=='checkbox' and not options: options=['Yes','No']
  existing=byname.get(norm(desired),[])
  if len(existing)==1:
   ek=custom_kind(existing[0])
   compatible=(desired in {'Summary','Description'} and jtype in {'text','paragraph'}) or ek==jtype
   if compatible:
    results.append({'sourceName':g['name'],'jiraName':desired,'jiraType':jtype,'status':'reused','id':existing[0]['id'],'services':services}); continue
  if existing or (desired==g['name'] and len(byname.get(key,[]))>1):
   desired=f'{g["name"]} - Ivanti'
   if key=='name': desired='Name - Ivanti Person' if jtype=='user' else 'Name - cBase Leaver'
   ex2=byname.get(norm(desired),[])
   if len(ex2)==1 and custom_kind(ex2[0])==jtype:
    results.append({'sourceName':g['name'],'jiraName':desired,'jiraType':jtype,'status':'reused','id':ex2[0]['id'],'services':services}); continue
  t,srch=TYPE_DEF.get(jtype,TYPE_DEF['text'])
  cs,created=req('POST','/rest/api/3/field',{'name':desired,'description':g['description'] or f'Migrated from Ivanti for: {", ".join(services)}','type':t,'searcherKey':srch})
  if cs not in (200,201):
   results.append({'sourceName':g['name'],'jiraName':desired,'jiraType':jtype,'status':'failed','http':cs,'error':created,'services':services}); continue
  fid=created.get('id'); byname[norm(desired)].append(created)
  row={'sourceName':g['name'],'jiraName':desired,'jiraType':jtype,'status':'created','id':fid,'services':services,'optionsRequested':len(options),'optionsAdded':0}
  if options and fid:
   xs,ctx=req('GET',f'/rest/api/3/field/{fid}/context?maxResults=50')
   vals=(ctx or {}).get('values',[]) if xs==200 and isinstance(ctx,dict) else []
   if not vals:
    row['status']='partial'; row['optionError']=f'No context returned ({xs})'
   else:
    cid=vals[0]['id']
    for i in range(0,len(options),100):
     chunk=options[i:i+100]
     os_,ob=req('POST',f'/rest/api/3/field/{fid}/context/{cid}/option',{'options':[{'value':str(v)} for v in chunk]})
     if os_ not in (200,201):
      row['status']='partial'; row['optionError']={'http':os_,'body':ob}; break
     row['optionsAdded']+=len(chunk)
  results.append(row)

vfields=all_fields()
verify={norm(f.get('name')):f.get('id') for f in vfields}
for r in results:
 if r.get('jiraName') and r['status'] in {'created','reused','partial'}:
  r['readBackId']=verify.get(norm(r['jiraName'])); r['readBackOk']=bool(r['readBackId'])
summary={
 'mode':'LIVE_PHASE1_FIELDS',
 'targetProjectKey':'SD',
 'created':sum(r.get('status')=='created' for r in results),
 'reused':sum(r.get('status')=='reused' for r in results),
 'deferred':sum(r.get('status')=='deferred' for r in results),
 'partial':sum(r.get('status')=='partial' for r in results),
 'failed':sum(r.get('status')=='failed' for r in results),
 'readBackFailures':sum(r.get('readBackOk') is False for r in results),
 'results':results,
}
(REPORT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k!='results'},indent=2))
for r in results: print(f"{r.get('sourceName')}: {r.get('status')} -> {r.get('jiraName','')} {r.get('id','')}")
if summary['failed'] or summary['partial'] or summary['readBackFailures']: raise SystemExit(2)
