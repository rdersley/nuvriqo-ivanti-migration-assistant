#!/usr/bin/env python3
import json, os, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PLAN=ROOT/'migration-output'/'jira-creation-plan.json'
COMPLETION=ROOT/'migration-evidence'/'source-backed-completion-plan.json'
OUT=ROOT/'migration-output'/'it-webtrigger'
OUT.mkdir(parents=True,exist_ok=True)
plan=json.loads(PLAN.read_text(encoding='utf-8'))
completion=json.loads(COMPLETION.read_text(encoding='utf-8'))
services=[]
for svc in plan.get('services',[]):
    if svc.get('error'): continue
    fields=[]
    for f in svc.get('fields',[]):
        fields.append({
            'sourceId': f.get('sourceId',''),
            'sourceName': f.get('sourceName',''),
            'name': f.get('name',''),
            'description': f.get('description',''),
            'jiraType': f.get('jiraType','text'),
            'required': bool(f.get('required')),
            'sequence': int(f.get('sequence') or 0),
            'visibilityExpression': f.get('visibilityExpression',''),
            'options': f.get('options',[]),
        })
    sections=[]
    for s in svc.get('sections',[]):
        sections.append({'name':s.get('name',''),'sequence':int(s.get('sequence') or 0)})
    services.append({'name':svc.get('name',''),'fields':fields,'sections':sections})
if len(services)!=14:
    raise SystemExit(f'Expected exactly 14 services, got {len(services)}')
run_id=os.environ.get('GITHUB_RUN_ID') or f'local-{int(time.time())}'
payload={'runId':f'it-forms-{run_id}','projectKey':'IT','projectId':'12789','services':services,'completionPlan':completion}
(OUT/'payload.json').write_text(json.dumps(payload,separators=(',',':')),encoding='utf-8')
(OUT/'payload.pretty.json').write_text(json.dumps(payload,indent=2),encoding='utf-8')
print(json.dumps({'runId':payload['runId'],'projectKey':'IT','projectId':'12789','services':len(services),'fieldOccurrences':sum(len(s['fields']) for s in services),'sections':sum(len(s['sections']) for s in services)},indent=2))
