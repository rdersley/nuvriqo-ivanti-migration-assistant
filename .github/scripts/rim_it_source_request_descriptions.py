#!/usr/bin/env python3
import base64, html, json, os, re, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from pathlib import Path

SITE='https://retailinmotion.atlassian.net'
PROJECT_ID='12789'
SERVICE_DESK_ID='2183'
INPUT=Path('migration-input')
OUT=Path('migration-output/it-source-fidelity/request-descriptions.json')
OUT.parent.mkdir(parents=True,exist_ok=True)

REQUEST_TYPES={
 'AWS Account management':'2424','Bitbucket Cloud Support':'2425','Domain Password Reset':'2426',
 'Employee Move':'2427','Leaver':'2428','New Application Access Request':'2429',
 'New IT Software Request':'2430','New Service Request':'2431','New Vector System Provisioning':'2432',
 'Production Vector System Decommissioning':'2433','Suspend Temporary Access':'2434',
 'Test Vector System Decommissioning':'2435','UAT Vector System Decommissioning':'2436','cBase Leaver':'2437'
}

def local(tag): return tag.split('}')[-1]
def child_text(parent,name):
    for c in list(parent):
        if local(c.tag).lower()==name.lower(): return (c.text or '').strip()
    return ''
def descendants(root,name): return [e for e in root.iter() if local(e.tag).lower()==name.lower()]
def clean_html(value):
    value=re.sub(r'<br\s*/?>',' ',value or '',flags=re.I)
    value=re.sub(r'<[^>]+>','',value)
    value=html.unescape(value).replace('\xa0',' ')
    return re.sub(r'\s+',' ',value).strip()

def source_descriptions():
    out={}
    for path in sorted(INPUT.glob('*.rox')):
        root=ET.parse(path).getroot(); templates=descendants(root,'ServiceRequestTemplate')
        if not templates: continue
        t=templates[0]
        name=child_text(t,'Name') or path.stem
        out[name]={'sourceFile':path.name,'description':clean_html(child_text(t,'Description'))}
    return out

email=os.environ.get('FORGE_EMAIL','').strip(); token=os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token: raise SystemExit('Missing FORGE_EMAIL/FORGE_API_TOKEN')
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
headers={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}

def call(method,path,body=None):
    data=None if body is None else json.dumps(body,separators=(',',':')).encode()
    req=urllib.request.Request(SITE+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            raw=r.read().decode('utf-8','replace')
            try: parsed=json.loads(raw) if raw else None
            except Exception: parsed=raw
            return r.status,parsed
    except urllib.error.HTTPError as e:
        raw=e.read().decode('utf-8','replace')
        try: parsed=json.loads(raw) if raw else None
        except Exception: parsed=raw
        return e.code,parsed

src=source_descriptions()
if set(src)!=set(REQUEST_TYPES):
    raise SystemExit(f'Source offering set mismatch. Missing={sorted(set(REQUEST_TYPES)-set(src))} extra={sorted(set(src)-set(REQUEST_TYPES))}')

ls,listing=call('GET',f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
if ls!=200 or not isinstance(listing,dict): raise SystemExit(f'Cannot inventory request types: {ls}')
values={str(v.get('id')):v for v in listing.get('values',[]) if isinstance(v,dict)}
results=[]
for name,rid in REQUEST_TYPES.items():
    public=values.get(rid)
    if not public or public.get('name')!=name or str(public.get('serviceDeskId'))!=SERVICE_DESK_ID:
        raise SystemExit(f'Identity guard failed for {name}/{rid}: {public}')
    groups=[str(g) for g in public.get('groupIds',[])];
    if not groups: raise SystemExit(f'Portal group guard failed for {name}: no groupIds')
    source_desc=src[name]['description']
    if not source_desc:
        results.append({'id':rid,'name':name,'sourceFile':src[name]['sourceFile'],'status':'skipped-source-description-empty','groupIds':groups})
        continue
    path=f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{groups[0]}/request-types/{rid}'
    gs,current=call('GET',path)
    if gs!=200 or not isinstance(current,dict) or str(current.get('id'))!=rid or current.get('name')!=name or int(current.get('projectId',0))!=12789:
        raise SystemExit(f'Internal identity guard failed for {name}: {gs} {current}')
    payload=dict(current)
    payload['description']=source_desc
    payload['helpText']=source_desc
    ps,pbody=call('PUT',path,payload)
    if ps!=200: raise SystemExit(f'Description PUT failed for {name}: {ps} {pbody}')
    rs,readback=call('GET',f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{rid}')
    if rs!=200 or not isinstance(readback,dict): raise SystemExit(f'Readback failed for {name}: {rs}')
    actual_desc=str(readback.get('description') or '')
    if actual_desc!=source_desc:
        raise SystemExit(f'Description readback mismatch for {name}: expected {source_desc!r}, got {actual_desc!r}')
    actual_groups=sorted(str(g) for g in readback.get('groupIds',[]))
    if actual_groups!=sorted(groups):
        raise SystemExit(f'Grouping changed unexpectedly for {name}: {groups} -> {actual_groups}')
    results.append({'id':rid,'name':name,'sourceFile':src[name]['sourceFile'],'status':'updated-and-verified','description':source_desc,'groupIds':actual_groups})

report={'mode':'SOURCE_FAITHFUL_REQUEST_TYPE_DESCRIPTION_SYNC','projectId':PROJECT_ID,'serviceDeskId':SERVICE_DESK_ID,'sourceOfferings':len(src),'updated':sum(r['status']=='updated-and-verified' for r in results),'skippedEmpty':sum(r['status'].startswith('skipped') for r in results),'results':results}
OUT.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'sourceOfferings':report['sourceOfferings'],'updated':report['updated'],'skippedEmpty':report['skippedEmpty']},indent=2))
