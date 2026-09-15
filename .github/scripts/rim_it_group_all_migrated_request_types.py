#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

SITE='https://retailinmotion.atlassian.net'
PROJECT_ID='12789'
SERVICE_DESK_ID='2183'
OUT=Path('migration-output/it-request-type-groups/all-migrated-assignments.json')
OUT.parent.mkdir(parents=True,exist_ok=True)

# Portal grouping is a Jira UX categorisation based on the request names/purpose.
# It is deliberately NOT represented as an Ivanti-source category mapping.
GROUPS={
 '2256':'Common Requests',
 '2257':'Computers',
 '2258':'Logins and Accounts',
 '2259':'Applications',
 '2260':'Servers and Infrastructure',
}
TARGETS={
 '2424':('AWS Account management',['2258','2260']),
 '2425':('Bitbucket Cloud Support',['2258','2259']),
 '2426':('Domain Password Reset',['2258']),
 '2427':('Employee Move',['2256']),
 '2428':('Leaver',['2256','2258']),
 '2429':('New Application Access Request',['2258','2259']),
 '2430':('New IT Software Request',['2259']),
 '2431':('New Service Request',['2256']),
 '2432':('New Vector System Provisioning',['2260']),
 '2433':('Production Vector System Decommissioning',['2260']),
 '2434':('Suspend Temporary Access',['2258']),
 '2435':('Test Vector System Decommissioning',['2260']),
 '2436':('UAT Vector System Decommissioning',['2260']),
 '2437':('cBase Leaver',['2256','2259']),
}

email=os.environ.get('FORGE_EMAIL','').strip(); token=os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token: raise SystemExit('Missing credentials')
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

# Hard guard: verify official API shows exactly the expected migrated IDs/names and target project/service desk.
s,listing=call('GET',f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
if s!=200 or not isinstance(listing,dict): raise SystemExit(f'Official request type inventory failed: {s}')
values={str(x.get('id')):x for x in listing.get('values',[]) if isinstance(x,dict)}
for rid,(name,gids) in TARGETS.items():
    item=values.get(rid)
    if not item or item.get('name')!=name or str(item.get('serviceDeskId'))!=SERVICE_DESK_ID:
        raise SystemExit(f'Identity guard failed for {rid} {name}: {item}')
    if not set(gids)<=set(GROUPS): raise SystemExit(f'Unknown target group for {rid}')

results=[]
for rid,(name,gids) in TARGETS.items():
    # Any allowed group path can retrieve the request type object even before membership exists.
    primary=gids[0]
    path=f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{primary}/request-types/{rid}'
    gs,current=call('GET',path)
    if gs!=200 or not isinstance(current,dict) or str(current.get('id'))!=rid or int(current.get('projectId',0))!=12789 or current.get('name')!=name:
        raise SystemExit(f'Internal identity guard failed for {rid}: {gs} {current}')
    payload=dict(current)
    payload['groups']=[{'id':int(gid),'name':GROUPS[gid]} for gid in gids]
    ps,pbody=call('PUT',path,payload)
    if ps!=200:
        raise SystemExit(f'PUT failed for {rid} {name}: {ps} {pbody}')
    rs,rb=call('GET',f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{rid}')
    actual=sorted(str(x) for x in rb.get('groupIds',[])) if rs==200 and isinstance(rb,dict) else []
    expected=sorted(gids)
    results.append({'id':rid,'name':name,'putStatus':ps,'readbackStatus':rs,'expectedGroupIds':expected,'actualGroupIds':actual})
    if actual!=expected:
        raise SystemExit(f'Readback mismatch for {rid}: expected {expected}, got {actual}')

# Final independent whole-estate readback.
fs,final=call('GET',f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
if fs!=200 or not isinstance(final,dict): raise SystemExit('Final inventory failed')
final_values={str(x.get('id')):x for x in final.get('values',[]) if isinstance(x,dict)}
missing=[]
for rid,(name,gids) in TARGETS.items():
    actual=sorted(str(x) for x in final_values.get(rid,{}).get('groupIds',[]))
    if actual!=sorted(gids): missing.append({'id':rid,'name':name,'expected':sorted(gids),'actual':actual})
report={'mode':'GUARDED_MIGRATED_PORTAL_GROUP_ASSIGNMENT','projectId':PROJECT_ID,'serviceDeskId':SERVICE_DESK_ID,'groupingBasis':'Jira portal UX categorisation inferred from request purpose; not claimed as Ivanti source metadata','updated':len(results),'verified':len(results)-len(missing),'mismatches':missing,'results':results}
OUT.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'updated':report['updated'],'verified':report['verified'],'mismatches':missing},indent=2))
if missing: raise SystemExit('Final portal-group readback failed')
