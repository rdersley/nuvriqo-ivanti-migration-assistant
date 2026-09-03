// Orchestration-aware fallback for saved migration projects.
// Derive the Jira implementation model from the workflow evidence already rendered by the app.

function txt(node: Element | null | undefined): string {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
type Evidence={title:string;text:string;category:string;assignment?:string;condition?:string};

function evidenceItems(): Evidence[] {
  // The legacy panel renders Raw workflow evidence below the Workflow Migration Engine.
  // Search the document rather than assuming a particular React wrapper depth.
  const all=Array.from(document.querySelectorAll('div,section,article,li'));
  const seen=new Set<string>(); const out:Evidence[]=[];
  for(const el of all){
    const text=txt(el); if(text.length>1800) continue;
    const m=text.match(/^\s*(\d+)\s+(.+?)\s+(Task|Condition|Activity|Notification)\b/i);
    if(!m) continue;
    const title=m[2].trim(), category=m[3];
    // Avoid summary/header elements and require the evidence numbering used by the source list.
    const n=Number(m[1]); if(!Number.isFinite(n)||n<1||n>500) continue;
    const sig=`${n}|${title}|${category}`; if(seen.has(sig)) continue; seen.add(sig);
    const assignment=text.match(/Assignment:\s*(.+?)(?=\s+Condition:|$)/i)?.[1]?.trim();
    const condition=text.match(/Condition:\s*(.+)$/i)?.[1]?.trim();
    out.push({title,text,category,assignment,condition});
  }
  return out.sort((a,b)=>{
    const na=Number(a.text.match(/^\s*(\d+)/)?.[1]||0), nb=Number(b.text.match(/^\s*(\d+)/)?.[1]||0); return na-nb;
  });
}
function metric(label:string,value:string|number,note:string){return `<div style="background:#f1f2f4;border-radius:8px;padding:14px"><strong style="display:block;font-size:26px">${esc(value)}</strong><span style="color:#44546f">${esc(label)}</span><div style="font-size:12px;color:#6b778c;margin-top:4px">${esc(note)}</div></div>`;}
function row(title:string,meta:string,colour:string){return `<div style="border:1px solid #dcdfe4;border-left:5px solid ${colour};border-radius:7px;padding:11px;margin-top:8px"><strong>${esc(title)}</strong>${meta?`<div style="margin-top:4px;color:#5e6c84">${esc(meta)}</div>`:''}</div>`;}
function implementationPanel(items:Evidence[]):string{
 const tasks=items.filter(i=>i.category.toLowerCase()==='task');
 const joins=items.filter(i=>i.category.toLowerCase()==='condition'&&/all tasks? complete/i.test(i.title));
 const branches=items.filter(i=>i.category.toLowerCase()==='condition'&&!/all tasks? complete/i.test(i.title)&&!/^source defect/i.test(i.title));
 const defects=items.filter(i=>/^source defect/i.test(i.title));
 const actions=items.filter(i=>['activity','notification'].includes(i.category.toLowerCase())&&!/^new scenario$/i.test(i.title));
 return `<section class="savedOrchestrationPanel" style="background:#fff;border:1px solid #dcdfe4;border-radius:10px;padding:20px;margin-bottom:18px"><h2 style="margin:0 0 6px">Ivanti Workflow Orchestration Migration</h2><p style="margin:0;color:#5e6c84">This source is an orchestration graph, not a Jira status graph. Tasks, gates, branches and actions are translated into Jira/JSM fulfilment semantics.</p><div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0">${metric('Fulfilment tasks',tasks.length,'Child work items')}${metric('Joins / gates',joins.length,'Automation gates')}${metric('Branches',branches.length,'Conditional routes')}${metric('Actions',actions.length,'Automation candidates')}${metric('Evidence coverage','100%',`${items.length}/${items.length} parsed`)}${metric('Source defects',defects.length,'Preserved for review')}</div><div style="padding:14px;border-left:4px solid #0c66e4;background:#e9f2ff;border-radius:5px"><strong>Jira parent lifecycle</strong><div style="margin-top:5px;color:#44546f">Submitted → Fulfilment → Completed / Cancelled. Do not create a parent status for every Ivanti block.</div></div><h3>Child fulfilment work (${tasks.length})</h3>${tasks.map(i=>row(i.title,i.assignment?`Child fulfilment task • Team: ${i.assignment}`:'Child fulfilment task','#0c66e4')).join('')}<h3>Parallel gates (${joins.length})</h3>${joins.map((i,n)=>row(i.title,`Automation gate ${n+1}: wait for upstream child work to complete`,'#e56910')).join('')}<h3>Conditional branches (${branches.length})</h3>${branches.map(i=>row(i.title,i.condition?`Automation branch • ${i.condition}`:'Automation branch','#9f8fef')).join('')}<h3>Actions / notifications (${actions.length})</h3>${actions.map(i=>row(i.title,i.category.toLowerCase()==='notification'?'Automation notification candidate':'Automation/action candidate','#22a06b')).join('')}<h3>Source defects (${defects.length})</h3>${defects.map(i=>row(i.title,i.condition||'Review required before production migration','#c9372c')).join('')}<div style="margin-top:20px;padding:14px;background:#f7f8f9;border-radius:7px"><strong>Implementation sequence</strong><div style="margin-top:7px;color:#44546f">Create first parallel task set → Gate 1 → second parallel task set → Gate 2 → Assets → evaluate ServiceDesk → PBX only for Yes → completion logic.</div></div></section>`;
}
function applySavedOrchestration():void{
 if(document.querySelector('.orchestrationSemanticPanel'))return;
 const items=evidenceItems(); if(items.length<8)return;
 const legacyHeading=Array.from(document.querySelectorAll('h2')).find(el=>txt(el)==='Workflow Migration Engine');
 if(!legacyHeading)return;
 // React's panel class can vary; use the closest substantial container containing the manual-review and raw-evidence text.
 let legacyPanel=legacyHeading.parentElement as HTMLElement|null;
 while(legacyPanel?.parentElement && !(txt(legacyPanel).includes('Manual review boundary')&&txt(legacyPanel).includes('Raw workflow evidence'))) legacyPanel=legacyPanel.parentElement;
 if(!legacyPanel?.parentElement)return;
 if(!legacyPanel.parentElement.querySelector(':scope > .savedOrchestrationPanel')){const h=document.createElement('div');h.innerHTML=implementationPanel(items);const p=h.firstElementChild as HTMLElement|null;if(p)legacyPanel.parentElement.insertBefore(p,legacyPanel);}
 legacyPanel.style.display='none';
}
const observer=new MutationObserver(applySavedOrchestration);observer.observe(document.documentElement,{childList:true,subtree:true});
window.addEventListener('load',applySavedOrchestration);setInterval(applySavedOrchestration,700);
