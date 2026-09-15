#!/usr/bin/env python3
import json, re, xml.etree.ElementTree as ET
from pathlib import Path

INPUT=Path('migration-input')
OUT=Path('migration-output/it-source-fidelity/condition-inventory.json')
OUT.parent.mkdir(parents=True,exist_ok=True)

def local(tag): return tag.split('}')[-1]
def child_text(parent,name):
    for c in list(parent):
        if local(c.tag).lower()==name.lower(): return (c.text or '').strip()
    return ''
def descendants(root,name): return [e for e in root.iter() if local(e.tag).lower()==name.lower()]

def refs(expr):
    # Preserve exact expression but also surface RecId-like GUID references and $(...) tokens for analysis.
    guids=re.findall(r'(?i)\b[0-9a-f]{32}\b',expr or '')
    tokens=re.findall(r'\$\((.*?)\)',expr or '')
    return {'guidRefs':list(dict.fromkeys(guids)),'tokens':list(dict.fromkeys(tokens))}

services=[]; total=0
for path in sorted(INPUT.glob('*.rox')):
    root=ET.parse(path).getroot(); templates=descendants(root,'ServiceRequestTemplate')
    if not templates: continue
    t=templates[0]; name=child_text(t,'Name') or path.stem
    params=[]
    allparams={child_text(p,'RecId'): {'name':child_text(p,'DisplayName') or child_text(p,'Name'),'sourceName':child_text(p,'Name'),'sequence':child_text(p,'SequenceNumber')} for p in descendants(t,'ServiceRequestTemplateParameter') if child_text(p,'RecId')}
    for p in descendants(t,'ServiceRequestTemplateParameter'):
        expr=child_text(p,'VisibilityExpression').strip()
        if not expr or expr.lower() in {'$(false)','false'}: continue
        r=refs(expr)
        resolved=[]
        for gid in r['guidRefs']:
            hit=allparams.get(gid) or allparams.get(gid.upper()) or allparams.get(gid.lower())
            if hit: resolved.append({'sourceId':gid,**hit})
        params.append({'sourceId':child_text(p,'RecId'),'name':child_text(p,'DisplayName') or child_text(p,'Name'),'sourceName':child_text(p,'Name'),'sequence':int(child_text(p,'SequenceNumber') or 0),'visibilityExpression':expr,**r,'resolvedGuidControllers':resolved})
    if params:
        total+=len(params); services.append({'service':name,'sourceFile':path.name,'conditionalFields':params})
report={'mode':'READ_ONLY_IVANTI_VISIBILITY_CONDITION_INVENTORY','serviceCountWithConditions':len(services),'conditionalFieldCount':total,'services':services}
OUT.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'serviceCountWithConditions':len(services),'conditionalFieldCount':total},indent=2))
for s in services:
    print(f"{s['service']}: {len(s['conditionalFields'])}")
    for f in s['conditionalFields']:
        print(f"  - {f['name']}: {f['visibilityExpression']}")
