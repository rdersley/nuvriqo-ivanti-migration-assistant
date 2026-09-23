#!/usr/bin/env python3
import base64, json, os, urllib.parse, urllib.request
from pathlib import Path

SITE=os.environ['RIM_FORGE_SITE'].rstrip('/')
EMAIL=os.environ['FORGE_EMAIL']
TOKEN=os.environ['FORGE_API_TOKEN']
PROJECT='IT'
SERVICE_DESK='2183'
OUT=Path('migration-output/it-live-inventory')
OUT.mkdir(parents=True,exist_ok=True)

def get(path):
    req=urllib.request.Request(SITE+path,headers={
        'Authorization':'Basic '+base64.b64encode(f'{EMAIL}:{TOKEN}'.encode()).decode(),
        'Accept':'application/json'
    })
    with urllib.request.urlopen(req,timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))

project=get('/rest/api/3/project/'+PROJECT)
request_types=get(f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
groups=get(f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK}/requesttypegroup')
fields=get('/rest/api/3/field')

wanted={
'AWS Account management','Bitbucket Cloud Support','Domain Password Reset','Employee Move','Leaver','New Application Access Request','New IT Software Request','New Service Request','New Vector System Provisioning','Production Vector System Decommissioning','Suspend Temporary Access','Test Vector System Decommissioning','UAT Vector System Decommissioning','cBase Leaver'}
selected=[r for r in request_types.get('values',[]) if r.get('name') in wanted]
summary={
    'project':{'id':project.get('id'),'key':project.get('key'),'name':project.get('name')},
    'serviceDeskId':SERVICE_DESK,
    'targetRequestTypeCount':len(selected),
    'requestTypes':[{
        'id':r.get('id'),'name':r.get('name'),'issueTypeId':r.get('issueTypeId'),'groupIds':r.get('groupIds'),'portalId':r.get('portalId')
    } for r in selected],
    'groups':groups.get('values',groups if isinstance(groups,list) else []),
    'fieldCount':len(fields) if isinstance(fields,list) else None
}
(OUT/'inventory.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({'project':summary['project'],'targetRequestTypeCount':len(selected),'groups':len(summary['groups']),'fieldCount':summary['fieldCount']},indent=2))
if project.get('key')!='IT' or str(project.get('id'))!='12789':
    raise SystemExit('Hard target guard failed')
if len(selected)!=14:
    raise SystemExit(f'Expected 14 migrated request types, got {len(selected)}')
