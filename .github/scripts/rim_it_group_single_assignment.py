#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

SITE='https://retailinmotion.atlassian.net'
PROJECT_ID='12789'
SERVICE_DESK_ID='2183'
GROUP_ID='2258'
GROUP_NAME='Logins and Accounts'
REQUEST_TYPE_ID='2424'
REQUEST_TYPE_NAME='AWS Account management'
OUT=Path('migration-output/it-request-type-groups/single-assignment.json')
OUT.parent.mkdir(parents=True,exist_ok=True)

email=os.environ.get('FORGE_EMAIL','').strip(); token=os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token: raise SystemExit('Missing credentials')
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
headers={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
internal=f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{GROUP_ID}/request-types/{REQUEST_TYPE_ID}'
public=f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{REQUEST_TYPE_ID}'

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

s,before=call('GET',internal)
if s!=200 or not isinstance(before,dict): raise SystemExit(f'GET guard failed {s}: {before}')
if int(before.get('id',0))!=2424 or int(before.get('projectId',0))!=12789 or before.get('name')!=REQUEST_TYPE_NAME:
    raise SystemExit('Hard request type identity guard failed')
existing=[int(g.get('id',0)) for g in before.get('groups',[]) if isinstance(g,dict)]
if existing and GROUP_ID not in {str(x) for x in existing}:
    raise SystemExit(f'Request type unexpectedly already grouped: {existing}')

payload=dict(before)
payload['groups']=[{'id':int(GROUP_ID),'name':GROUP_NAME}]
ps,pbody=call('PUT',internal,payload)
if ps!=200: raise SystemExit(f'PUT failed {ps}: {pbody}')

after_status,after=call('GET',internal)
pub_status,pub=call('GET',public)
after_groups=[str(g.get('id')) for g in after.get('groups',[]) if isinstance(g,dict)] if isinstance(after,dict) else []
pub_groups=[str(x) for x in pub.get('groupIds',[])] if isinstance(pub,dict) else []
report={'mode':'GUARDED_SINGLE_PORTAL_GROUP_ASSIGNMENT','requestTypeId':REQUEST_TYPE_ID,'requestTypeName':REQUEST_TYPE_NAME,'targetGroupId':GROUP_ID,'targetGroupName':GROUP_NAME,'putStatus':ps,'internalReadbackStatus':after_status,'internalGroups':after_groups,'publicReadbackStatus':pub_status,'publicGroupIds':pub_groups}
OUT.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
if GROUP_ID not in after_groups or GROUP_ID not in pub_groups:
    raise SystemExit('Assignment did not survive both internal and public readback')
