#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

SITE='https://retailinmotion.atlassian.net'
PROJECT_ID='12789'
SERVICE_DESK_ID='2183'
GROUP_ID='2258'
REQUEST_TYPE_ID='2424'  # AWS Account management
OUT=Path('migration-output/it-request-type-groups/put-noop-probe.json')
OUT.parent.mkdir(parents=True,exist_ok=True)

email=os.environ.get('FORGE_EMAIL','').strip(); token=os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token: raise SystemExit('Missing credentials')
auth=base64.b64encode(f'{email}:{token}'.encode()).decode()
headers={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
path=f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{GROUP_ID}/request-types/{REQUEST_TYPE_ID}'

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

# Safety: obtain the exact current server representation and PUT it back unchanged.
get_status,before=call('GET',path)
if get_status!=200 or not isinstance(before,dict) or int(before.get('id',0))!=2424 or int(before.get('projectId',0))!=12789:
    raise SystemExit(f'Guard failed before no-op PUT: {get_status} {before}')
put_status,put_body=call('PUT',path,before)
get2_status,after=call('GET',path)
report={'mode':'IDEMPOTENT_NOOP_PUT_PROBE','path':path,'beforeStatus':get_status,'putStatus':put_status,'afterStatus':get2_status,'beforeGroups':before.get('groups'),'afterGroups':after.get('groups') if isinstance(after,dict) else None,'putBody':put_body}
OUT.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2,default=str))
if get2_status!=200 or not isinstance(after,dict) or after.get('groups')!=before.get('groups'):
    raise SystemExit('No-op PUT changed group membership; stop immediately')
