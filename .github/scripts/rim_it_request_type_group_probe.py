#!/usr/bin/env python3
import base64,json,os,sys,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'migration-output'/'it-request-type-group-probe'; OUT.mkdir(parents=True,exist_ok=True)
site=os.environ['RIM_FORGE_SITE'].strip().rstrip('/'); email=os.environ['FORGE_EMAIL']; token=os.environ['FORGE_API_TOKEN']
auth=base64.b64encode(f'{email}:{token}'.encode()).decode(); HEAD={'Authorization':f'Basic {auth}','Accept':'application/json','Content-Type':'application/json'}
DESK='2183'; REQUEST_TYPE_ID='2424'; GROUP_ID='2256'
def req(path,method='GET',body=None):
 data=None if body is None else json.dumps(body).encode()
 r=urllib.request.Request(f'https://{site}{path}',headers=HEAD,method=method,data=data)
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
ps,p=req('/rest/api/3/project/IT')
if ps!=200 or str((p or {}).get('id'))!='12789':
 print(json.dumps({'status':'blocked','reason':'IT target guard failed','http':ps,'project':p},indent=2));sys.exit(2)
bs,before=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype/{REQUEST_TYPE_ID}')
if bs!=200:
 print(json.dumps({'status':'blocked','reason':'cannot read probe request type','http':bs,'body':before},indent=2));sys.exit(2)
payload={
 'requestTypeId':int(REQUEST_TYPE_ID),
 'name':before.get('name','AWS Account management'),
 'description':before.get('description',''),
 'helpText':before.get('helpText',''),
 'groupIds':[GROUP_ID]
}
us,updated=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype','PUT',payload)
rs,after=req(f'/rest/servicedeskapi/servicedesk/{DESK}/requesttype/{REQUEST_TYPE_ID}')
result={'mode':'LIVE_SINGLE_REQUEST_TYPE_GROUP_PROBE','beforeStatus':bs,'before':before,'updateStatus':us,'updateBody':updated,'readBackStatus':rs,'after':after,'groupApplied':GROUP_ID in [str(x) for x in (after.get('groupIds',[]) if isinstance(after,dict) else [])]}
(OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({'updateStatus':us,'readBackStatus':rs,'beforeGroupIds':before.get('groupIds',[]) if isinstance(before,dict) else None,'afterGroupIds':after.get('groupIds',[]) if isinstance(after,dict) else None,'groupApplied':result['groupApplied']},indent=2))
if us not in (200,201) or rs!=200 or not result['groupApplied']: sys.exit(2)
