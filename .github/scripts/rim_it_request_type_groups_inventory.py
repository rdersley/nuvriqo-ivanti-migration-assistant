#!/usr/bin/env python3
import base64,json,os,sys,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'it-request-type-groups'; OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/'); email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode(); HEAD={'Authorization':f'Basic {auth}','Accept':'application/json'}
DESK='2183'; PROJECT='IT'
def get(path):
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD)
 try:
  with urllib.request.urlopen(r,timeout=40) as x:
   raw=x.read().decode('utf-8','replace')
   try:b=json.loads(raw) if raw else {}
   except:b=raw
   return x.status,b
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:b=json.loads(raw) if raw else {}
  except:b=raw
  return e.code,b
ps,p=get('/rest/api/3/project/IT')
if ps!=200 or str((p or {}).get('id'))!='12789':
 print(json.dumps({'status':'blocked','reason':'IT target guard failed','http':ps,'project':p},indent=2)); sys.exit(2)
gs,g=get(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttypegroup?start=0&limit=100')
rs,r=get(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
summary={'mode':'READ_ONLY_IT_REQUEST_TYPE_GROUP_INVENTORY','projectKey':PROJECT,'serviceDeskId':DESK,'groupsStatus':gs,'groups':g,'requestTypesStatus':rs,'requestTypes':r}
(OUT/'result.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({'groupsStatus':gs,'groups':(g.get('values',[]) if isinstance(g,dict) else g),'requestTypeCount':len(r.get('values',[])) if isinstance(r,dict) else None},indent=2))
if gs!=200 or rs!=200: sys.exit(2)
