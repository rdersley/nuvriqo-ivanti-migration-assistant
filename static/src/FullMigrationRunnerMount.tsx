import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@forge/bridge';
import type { ParsedWorkflow } from './WorkflowXmlImportMount';

type Field = { id:string; name:string; ivantiName?:string; description?:string; jiraType:string; options?:string[]; required?:boolean; selected?:boolean };
type Condition = { id:string; controllerFieldId:string; controllerFieldName?:string; operator:string; value:string; targetFieldIds:string[] };
type Section = { id:string; name:string; fieldIds:string[] };
type Service = {
  id:string;
  analysis?: { serviceName?:string; description?:string; fields?:Field[]; suggestedWorkflow?:{statuses?:string[]} };
  formSections?: Section[];
  proposedConditions?: Condition[];
  ivantiWorkflows?: ParsedWorkflow[];
  build?: { fieldResults?: any[]; formCreated?:boolean; workflowCreated?:boolean; automationGenerated?:boolean };
  updatedAt?:string;
};
type Project = { name?:string; targetProjectId?:string; services?:Service[]; updatedAt?:string };
type RunnerResult = { serviceId:string; serviceName:string; status:'complete'|'partial'|'failed'; steps:Array<{key:string;status:'ok'|'warning'|'failed';message:string}> };
type JiraField = { id:string; name:string };

const PROJECT_KEY='ivanti-migration-assistant-project-v3';
const RESULT_KEY='ivanti-migration-assistant-full-run-v1';

function readProject():Project { try { return JSON.parse(localStorage.getItem(PROJECT_KEY)||'{}') as Project; } catch { return {}; } }
function saveProject(project:Project){ localStorage.setItem(PROJECT_KEY,JSON.stringify(project)); window.dispatchEvent(new CustomEvent('ivanti-migration-project-changed',{detail:{project}})); }
function clean(v:unknown){ return String(v??'').replace(/\s+/g,' ').trim(); }
function fieldPayload(service:Service){ return (service.analysis?.fields||[]).filter(f=>f.selected!==false).map(f=>({name:f.name,ivantiName:f.ivantiName||f.name,description:f.description||'',jiraType:f.jiraType,options:f.options||[]})); }
function lifecycle(service:Service):string[]{ const runtime=(service.ivantiWorkflows||[])[0]; if(runtime) return ['Submitted','Fulfilment','Completed','Cancelled']; const source=service.analysis?.suggestedWorkflow?.statuses||[]; return source.length>=2?source:['Submitted','Fulfilment','Completed']; }
function mergeFieldResults(service:Service, latest:any[], jiraFields:JiraField[]):any[]{
  const byName=new Map<string,any>();
  for(const item of service.build?.fieldResults||[]) if(item?.name) byName.set(clean(item.name).toLowerCase(),item);
  for(const item of latest) if(item?.name) byName.set(clean(item.name).toLowerCase(),item);
  for(const field of service.analysis?.fields||[]){
    const key=clean(field.name).toLowerCase();
    if(byName.get(key)?.id) continue;
    const jira=jiraFields.find(item=>clean(item.name).toLowerCase()===key);
    if(jira) byName.set(key,{name:field.name,ivantiName:field.ivantiName||field.name,status:'reused',id:jira.id,steps:[]});
  }
  return [...byName.values()];
}
function mappedFormFields(service:Service, fieldResults:any[]){
  const byName=new Map(fieldResults.filter(r=>r?.id).map(r=>[clean(r.name).toLowerCase(),r]));
  return (service.analysis?.fields||[]).map(f=>({sourceId:f.id,id:(byName.get(clean(f.name).toLowerCase()) as any)?.id,name:f.name,required:Boolean(f.required),jiraType:f.jiraType,options:f.options||[]}));
}
function updateServiceFields(project:Project,serviceId:string,fieldResults:any[]):Project{
  const now=new Date().toISOString();
  return {...project,updatedAt:now,services:(project.services||[]).map(service=>service.id===serviceId?{...service,updatedAt:now,build:{...(service.build||{}),fieldResults}}:service)};
}
function controllerScore(field:Field|undefined):number{
  if(!field) return -1;
  const name=clean(field.name).toLowerCase();
  const type=clean(field.jiraType).toLowerCase();
  let score=['select','checkbox'].includes(type)?50:0;
  if(/required\??|requested\??/.test(name)) score+=40;
  if(/^(is|does|do|has|needs)\b/.test(name)) score+=25;
  if(/required|requested|shipping|service\s*desk|monitor/.test(name)) score+=15;
  return score;
}
function normaliseConditions(service:Service):Condition[]{
  const fields=service.analysis?.fields||[];
  const byId=new Map(fields.map(f=>[String(f.id),f]));
  return (service.proposedConditions||[]).map((condition,index)=>{
    const originalTargets=(condition.targetFieldIds||[]).map(String);
    const candidates=[condition.controllerFieldId,...originalTargets]
      .map(String)
      .filter((id,pos,all)=>id&&all.indexOf(id)===pos)
      .map(id=>({id,field:byId.get(id)}))
      .filter(item=>item.field)
      .sort((a,b)=>controllerScore(b.field)-controllerScore(a.field));
    const current=byId.get(String(condition.controllerFieldId||''));
    const currentScore=controllerScore(current);
    const best=currentScore>=50?{id:String(condition.controllerFieldId),field:current}:candidates[0];
    const controllerId=best?.id||String(condition.controllerFieldId||'');
    const targets=originalTargets.filter(id=>id!==controllerId);
    return {...condition,id:String(condition.id||`condition-${index+1}`),controllerFieldId:controllerId,controllerFieldName:best?.field?.name||condition.controllerFieldName,targetFieldIds:targets};
  }).filter(condition=>condition.controllerFieldId&&condition.targetFieldIds.length>0);
}
function prepareConditionalSections(rawSections:Section[], conditions:Condition[]):Section[]{
  if(!conditions.length) return rawSections||[];
  const allTargetIds=new Set(conditions.flatMap(c=>c.targetFieldIds.map(String)));
  const controllerIds=new Set(conditions.map(c=>String(c.controllerFieldId)));
  const prepared:Section[]=[];
  const placed=new Set<string>();
  (rawSections||[]).forEach((section,sectionIndex)=>{
    const ids=(section.fieldIds||[]).map(String);
    // Controllers must remain top-level questions. Never place a conditional
    // controller inside any section because Jira Forms can hide the whole
    // section before the customer has a chance to answer that controller.
    const baseIds=ids.filter(id=>!allTargetIds.has(id)&&!controllerIds.has(id));
    if(baseIds.length||sectionIndex===0) prepared.push({...section,id:String(section.id||`section-${sectionIndex+1}`),fieldIds:baseIds});
    conditions.forEach((condition,conditionIndex)=>{
      const targetSet=new Set(condition.targetFieldIds.map(String));
      const matches=ids.filter(id=>targetSet.has(id)&&!controllerIds.has(id));
      if(!matches.length) return;
      matches.forEach(id=>placed.add(id));
      prepared.push({id:`conditional-${conditionIndex+1}-${sectionIndex+1}`,name:`${section.name||`Section ${sectionIndex+1}`} — conditional`,fieldIds:matches});
    });
  });
  conditions.forEach((condition,conditionIndex)=>{
    const missing=condition.targetFieldIds.map(String).filter(id=>!placed.has(id)&&!controllerIds.has(id));
    if(missing.length) prepared.push({id:`conditional-${conditionIndex+1}-unplaced`,name:`Conditional fields ${conditionIndex+1}`,fieldIds:missing});
  });
  return prepared;
}
function validateTopology(service:Service,conditions:Condition[],sections:Section[]):string[]{
  const errors:string[]=[];
  const fieldIds=new Set((service.analysis?.fields||[]).map(f=>String(f.id)));
  const sectionedIds=new Set(sections.flatMap(s=>s.fieldIds.map(String)));
  for(const condition of conditions){
    const controller=String(condition.controllerFieldId);
    if(!fieldIds.has(controller)) errors.push(`Condition ${condition.id}: controller field ${controller} does not exist.`);
    if(condition.targetFieldIds.map(String).includes(controller)) errors.push(`Condition ${condition.id}: controller is also a target field.`);
    if(sectionedIds.has(controller)) errors.push(`Condition ${condition.id}: controller would be inside a section instead of remaining top-level.`);
    if(!condition.targetFieldIds.length) errors.push(`Condition ${condition.id}: no target fields remain after controller repair.`);
  }
  return errors;
}
function conditionStage(form:any):any|undefined{return Array.isArray(form?.stages)?form.stages.find((stage:any)=>stage?.key==='conditions'):undefined;}

export default function FullMigrationRunnerMount(){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  const [project,setProject]=useState<Project>(()=>readProject());
  const [busy,setBusy]=useState(false);
  const [results,setResults]=useState<RunnerResult[]>(()=>{try{return JSON.parse(localStorage.getItem(RESULT_KEY)||'[]');}catch{return[];}});
  useEffect(()=>{const refresh=()=>setProject(readProject());const find=()=>{const panels=[...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];setTarget(panels.find(p=>p.querySelector('h1')?.textContent?.trim()==='Migration wizard')||null);};refresh();find();const obs=new MutationObserver(find);obs.observe(document.body,{childList:true,subtree:true});window.addEventListener('ivanti-migration-project-changed',refresh);window.addEventListener('storage',refresh);return()=>{obs.disconnect();window.removeEventListener('ivanti-migration-project-changed',refresh);window.removeEventListener('storage',refresh);};},[]);
  const ready=useMemo(()=>(project.services||[]).filter(s=>Boolean(s.analysis?.serviceName)&&Boolean((s.ivantiWorkflows||[]).length)),[project]);
  async function run(){
    if(busy||!project.targetProjectId||!ready.length)return;
    if(!window.confirm(`Restore the Ivanti form with top-level conditional controllers and preserve the captured workflow for ${ready.length} mapped service${ready.length===1?'':'s'}?`))return;
    setBusy(true);const runResults:RunnerResult[]=[];let working=readProject();
    for(const service of ready){
      const steps:RunnerResult['steps']=[];const name=clean(service.analysis?.serviceName)||service.id;
      try{
        const fields=fieldPayload(service);const latest:any[]=fields.length?await invoke('createFields',{fields,projectId:working.targetProjectId}) as any[]:[];const jiraFields=(await invoke('getFields')) as JiraField[];const completeFieldResults=mergeFieldResults(service,latest,jiraFields||[]);
        steps.push({key:'fields',status:'ok',message:`Resolved ${completeFieldResults.filter(r=>r?.id).length} Jira field mappings for ${service.analysis?.fields?.length||0} source fields.`});working=updateServiceFields(working,service.id,completeFieldResults);saveProject(working);
        const formFields=mappedFormFields(service,completeFieldResults);const unresolved=formFields.filter(f=>!f.id);if(unresolved.length) throw new Error(`Refusing to publish with missing Jira field mappings: ${unresolved.map(f=>f.name).join(', ')}`);
        const conditions=normaliseConditions(service);const sections=prepareConditionalSections(service.formSections||[],conditions);const topologyErrors=validateTopology(service,conditions,sections);if(topologyErrors.length) throw new Error(`Form topology validation failed: ${topologyErrors.join(' | ')}`);
        steps.push({key:'form-topology',status:'ok',message:`Validated ${conditions.length} conditional rule(s); every controller is top-level and outside all sections.`});
        const structure:any=await invoke('createJiraStructure',{serviceName:name,description:service.analysis?.description||'',statuses:lifecycle(service),createIssueType:true,createWorkflow:true,createWorkflowScheme:true});if(!structure?.issueTypeId) throw new Error(structure?.message||'Jira structure did not return an issue type.');steps.push({key:'structure',status:'ok',message:`Issue type ${structure.issueTypeId}; workflow ${structure.workflowName||structure.workflowId||'created/reused'}.`});
        const request:any=await invoke('createJsmRequestType',{projectId:working.targetProjectId,issueTypeId:structure.issueTypeId,name,description:service.analysis?.description||`Migrated from Ivanti: ${name}`});if(!request?.requestTypeId) throw new Error(request?.message||'JSM request type was not returned.');steps.push({key:'request-type',status:'ok',message:`Request type ${request.requestTypeId} reused/created.`});
        const form:any=await invoke('createJsmForm',{projectId:working.targetProjectId,requestTypeId:request.requestTypeId,name:`${name} - Ivanti Migration Form`,fields:formFields,sections,conditions});if(!form?.published) throw new Error(form?.message||'JSM Form was not published.');const condition=conditionStage(form);if(conditions.length&&(!condition||condition.status!=='verified')) throw new Error(`Form published but conditional logic was not verified: ${condition?.message||'Jira did not return a verified conditions stage.'}`);steps.push({key:'form',status:'ok',message:`Complete ${formFields.length}-field form ${form.formId||'created'} published; conditional logic verified.`});
        const portal:any=await invoke('verifyJsmPortal',{projectId:working.targetProjectId,requestTypeId:request.requestTypeId,issueTypeId:structure.issueTypeId});steps.push({key:'portal',status:portal?.visibleInPortal?'ok':'warning',message:portal?.visibleInPortal?'Portal visibility verified.':'Portal visibility still needs review.'});steps.push({key:'workflow-activation',status:'warning',message:'Workflow scheme remains unassigned until all service workflow mappings are consolidated safely.'});runResults.push({serviceId:service.id,serviceName:name,status:steps.some(s=>s.status==='warning')?'partial':'complete',steps});
      }catch(error){steps.push({key:'run',status:'failed',message:error instanceof Error?error.message:String(error)});runResults.push({serviceId:service.id,serviceName:name,status:'failed',steps});}
    }
    localStorage.setItem(RESULT_KEY,JSON.stringify(runResults));setResults(runResults);setBusy(false);
  }
  if(!target)return null;
  return createPortal(<section style={{marginTop:24,border:'2px solid #0c66e4',borderRadius:8,padding:20,background:'#fff'}} data-full-migration-runner="true"><div style={{fontSize:12,fontWeight:700,letterSpacing:'.08em',color:'#44546f',textTransform:'uppercase'}}>Protected live migration execution</div><h2 style={{margin:'5px 0 4px'}}>Restore Ivanti form + preserve captured workflow</h2><p style={{margin:0,color:'#626f86'}}>Conditional controller questions are kept top-level, outside every section, so Jira cannot hide the question needed to reveal its dependent fields. Workflow capture remains separate from the form topology.</p><div style={{marginTop:14,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}><button disabled={busy||!project.targetProjectId||!ready.length} onClick={()=>void run()}>{busy?'Restoring Ivanti form…':`Restore ${ready.length} captured service${ready.length===1?'':'s'} with top-level controllers`}</button><span style={{fontSize:13,color:'#626f86'}}>{project.targetProjectId?`Target project ${project.targetProjectId}`:'Choose a target project first.'}</span></div>{!ready.length&&<p style={{marginTop:10,color:'#974f0c'}}>No mapped runtime workflow is stored on a service yet. Existing GetInstance capture remains separate from form repair.</p>}{results.length>0&&<div style={{marginTop:14,display:'grid',gap:8}}>{results.map(r=><div key={r.serviceId} style={{padding:10,border:'1px solid #dfe1e6',borderRadius:6}}><strong>{r.serviceName} — {r.status}</strong>{r.steps.map((s,i)=><div key={`${s.key}-${i}`} style={{marginTop:4,fontSize:12,color:s.status==='failed'?'#ae2a19':s.status==='warning'?'#974f0c':'#164b35'}}>{s.key}: {s.message}</div>)}</div>)}</div>}</section>,target);
}
