#!/usr/bin/env python3
import base64,json,os,sys,urllib.request,urllib.error,uuid
from collections import defaultdict
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
PLAN=ROOT/'migration-output'/'jira-creation-plan.json'
OUT=ROOT/'migration-output'/'it-forms'; OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/'); email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode(); HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
PROJECT_ID='12789'; PROJECT_KEY='IT'; DESK='2183'
REQUEST_TYPES={
'AWS Account management':'2424','Bitbucket Cloud Support':'2425','Domain Password Reset':'2426','Employee Move':'2427','Leaver':'2428','New Application Access Request':'2429','New IT Software Request':'2430','New Service Request':'2431','New Vector System Provisioning':'2432','Production Vector System Decommissioning':'2433','Suspend Temporary Access':'2434','Test Vector System Decommissioning':'2435','UAT Vector System Decommissioning':'2436','cBase Leaver':'2437'}

def req(path,method='GET',body=None):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD,method=method,data=data)
 try:
  with urllib.request.urlopen(r,timeout=60) as x:
   raw=x.read().decode('utf-8','replace')
   try:b=json.loads(raw) if raw else {}
   except:b=raw
   return x.status,b
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw) if raw else {}
  except:b=raw
  return e.code,b

def norm(v): return ' '.join(str(v or '').casefold().split())
def kind(f):
 if str(f.get('id')) in {'summary','description'}: return 'text' if f.get('id')=='summary' else 'paragraph'
 c=str((f.get('schema') or {}).get('custom') or '')
 if 'textarea' in c:return 'paragraph'
 if 'textfield' in c:return 'text'
 if 'datepicker' in c:return 'date'
 if 'userpicker' in c:return 'user'
 if c.endswith(':select'):return 'select'
 if 'float' in c:return 'number'
 return None

def all_fields():
 s,base=req('/rest/api/3/field')
 if s!=200 or not isinstance(base,list): raise SystemExit(f'Cannot inventory Jira fields: {s} {base}')
 merged={str(f.get('id')):f for f in base if f.get('id')}
 start=0
 while True:
  cs,b=req(f'/rest/api/3/field/search?type=custom&startAt={start}&maxResults=100')
  if cs!=200 or not isinstance(b,dict): raise SystemExit(f'Cannot inventory custom fields: {cs} {b}')
  vals=b.get('values') or []
  for f in vals:
   if f.get('id'): merged[str(f['id'])]=f
  start += len(vals)
  if not vals or start>=int(b.get('total') or 0): break
 return list(merged.values())

def resolve_field(service_name, source):
 name=source.get('name',''); jtype=source.get('jiraType','text')
 if jtype=='lookup-select': return None
 candidates=[]
 if name=='Name':
  if service_name=='cBase Leaver': candidates=['Name - cBase Leaver']
  else: candidates=['Name - Ivanti Person','Name']
 else:
  candidates=[name,f'{name} - Ivanti']
 for cname in candidates:
  for f in byname.get(norm(cname),[]):
   fk=kind(f)
   compat=(cname in {'Summary','Description'} and jtype in {'text','paragraph'}) or fk==jtype or (jtype=='checkbox' and fk=='select')
   if compat:return f
 return None

def qtype(jtype):
 return {'paragraph':'tl','date':'da','select':'cd','checkbox':'cd','user':'us','number':'no'}.get(jtype,'ts')
def question_ext(qid):
 return {'type':'extension','attrs':{'extensionKey':'question','extensionType':'com.thinktilt.proforma','layout':'default','localId':str(uuid.uuid4()),'parameters':{'id':int(qid)}}}
def heading(name): return {'type':'heading','attrs':{'level':2},'content':[{'type':'text','text':name}]}

def build_design(service):
 fields=sorted(service.get('fields',[]),key=lambda x:(int(x.get('sequence') or 0),norm(x.get('name'))))
 sections=sorted(service.get('sections',[]),key=lambda x:int(x.get('sequence') or 0))
 questions={}; qid_by_source={}; unresolved=[]; qnum=1
 for f in fields:
  jf=resolve_field(service['name'],f)
  if not jf:
   unresolved.append({'name':f.get('name'),'jiraType':f.get('jiraType'),'reason':'No compatible Jira field or deferred lookup'})
   continue
  qid=str(qnum); qnum+=1
  questions[qid]={'label':f.get('name'),'description':f.get('description') or '','type':qtype(f.get('jiraType')),'jiraField':str(jf.get('id')),'questionKey':f'ivanti-{qid}','validation':{'rq':bool(f.get('required'))}}
  if f.get('sourceId'): qid_by_source[str(f['sourceId'])]=qid
  f['_qid']=qid
 # Sequence-based section reconstruction: every field belongs to the latest category heading before it.
 buckets=[]
 if sections:
  for s in sections:buckets.append({'name':s.get('name') or 'Section','seq':int(s.get('sequence') or 0),'qids':[]})
  pre=[]
  for f in fields:
   qid=f.get('_qid')
   if not qid: continue
   eligible=[b for b in buckets if b['seq']<=int(f.get('sequence') or 0)]
   if eligible:max(eligible,key=lambda b:b['seq'])['qids'].append(qid)
   else: pre.append(qid)
  if pre:buckets.insert(0,{'name':'Request details','seq':-1,'qids':pre})
 else:
  buckets=[{'name':'Request details','seq':0,'qids':[f['_qid'] for f in fields if f.get('_qid')]}]
 layout=[]; form_sections={}
 for i,b in enumerate(buckets):
  content=[heading(b['name'])]+[question_ext(q) for q in b['qids']]
  layout.append({'version':1,'type':'doc','content':content})
  if i>0: form_sections[str(i)]={'name':b['name'],'sectionType':'p'}
 settings={'language':'en','name':f"{service['name']} - Ivanti Migration Form",'primaryLocale':'en-US','submit':{'lock':True,'pdf':True}}
 return {'conditions':{},'layout':layout,'questions':questions,'sections':form_sections,'settings':settings},unresolved

# target guards
ps,p=req('/rest/api/3/project/IT')
if ps!=200 or str((p or {}).get('id'))!=PROJECT_ID:
 print(json.dumps({'status':'blocked','reason':'IT target guard failed','http':ps,'project':p},indent=2));sys.exit(2)
js,j=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
if js!=200: print(json.dumps({'status':'blocked','reason':'cannot read IT request types','http':js,'body':j},indent=2));sys.exit(2)
actual={(x.get('name'),str(x.get('id'))):str(x.get('issueTypeId','')) for x in j.get('values',[])}
for name,rid in REQUEST_TYPES.items():
 if not any(n==name and i==rid for (n,i) in actual):
  print(json.dumps({'status':'blocked','reason':'request type guard failed','name':name,'requestTypeId':rid},indent=2));sys.exit(2)
if not PLAN.exists(): raise SystemExit('jira-creation-plan.json missing; run build_creation_plan.py first')
plan=json.loads(PLAN.read_text(encoding='utf-8'))
jira_fields=all_fields(); byname=defaultdict(list)
for f in jira_fields: byname[norm(f.get('name'))].append(f)
idxs,index=req(f'/forms/project/{PROJECT_ID}/form')
if idxs!=200 or not isinstance(index,list):
 print(json.dumps({'status':'blocked','reason':'Forms index unavailable','http':idxs,'body':index},indent=2));sys.exit(2)
existing_by_name={norm(x.get('name')):x for x in index if isinstance(x,dict)}
results=[]
for service in plan.get('services',[]):
 name=service.get('name'); rid=REQUEST_TYPES.get(name)
 if not rid: continue
 form_name=f'{name} - Ivanti Migration Form'
 design,unresolved=build_design(service)
 existing=existing_by_name.get(norm(form_name)); form_id=str((existing or {}).get('id') or '')
 row={'service':name,'requestTypeId':rid,'formName':form_name,'unresolvedFields':unresolved,'questionCount':len(design['questions']),'sectionCount':len(design['layout'])}
 if not design['questions']:
  row.update({'status':'failed','reason':'no resolvable questions'}); results.append(row); continue
 if not form_id:
  cs,created=req(f'/forms/project/{PROJECT_ID}/form','POST',{'design':{'conditions':{},'layout':[],'questions':{},'sections':{},'settings':design['settings']}})
  if cs not in (200,201): row.update({'status':'failed','stage':'create','http':cs,'body':created});results.append(row);continue
  form_id=str(((created or {}).get('formTemplate') or {}).get('id') or (created or {}).get('id') or '')
  if not form_id: row.update({'status':'failed','stage':'create','reason':'no form id returned','body':created});results.append(row);continue
  row['createdBase']=True
 else: row['createdBase']=False
 row['formId']=form_id
 us,ub=req(f'/forms/project/{PROJECT_ID}/form/{form_id}','PUT',{'design':design})
 if us not in (200,201,204): row.update({'status':'failed','stage':'populate','http':us,'body':ub});results.append(row);continue
 gs,stored=req(f'/forms/project/{PROJECT_ID}/form/{form_id}')
 stored_q=((stored or {}).get('design') or {}).get('questions') or {} if isinstance(stored,dict) else {}
 if gs!=200 or len(stored_q)<len(design['questions']): row.update({'status':'failed','stage':'readback','http':gs,'storedQuestions':len(stored_q)});results.append(row);continue
 publish={'design':design,'publish':{'jira':{'issueCreateIssueTypeIds':[],'issueCreateRequestTypeIds':[int(rid)],'recommendedIssueRequestTypeIds':[],'submitOnCreate':True,'validateOnCreate':True},'portal':{'portalRequestTypeIds':[int(rid)],'submitOnCreate':True,'validateOnCreate':True}}}
 ps2,pb=req(f'/forms/project/{PROJECT_ID}/form/{form_id}','PUT',publish)
 if ps2 not in (200,201,204): row.update({'status':'failed','stage':'publish','http':ps2,'body':pb});results.append(row);continue
 row.update({'status':'published','storedQuestions':len(stored_q),'publishHttp':ps2});results.append(row)
summary={'mode':'LIVE_IT_FORMS','projectKey':PROJECT_KEY,'projectId':PROJECT_ID,'serviceDeskId':DESK,'published':sum(r.get('status')=='published' for r in results),'failed':sum(r.get('status')=='failed' for r in results),'unresolvedFieldOccurrences':sum(len(r.get('unresolvedFields',[])) for r in results),'results':results}
(OUT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k!='results'},indent=2))
for r in results: print(f"{r['service']}: {r.get('status')} form={r.get('formId','')} questions={r.get('questionCount')} unresolved={len(r.get('unresolvedFields',[]))} stage={r.get('stage','')}")
if summary['failed']: sys.exit(2)
