import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@forge/bridge';
import type { ParsedWorkflow } from './WorkflowXmlImportMount';

type Field = { id:string; name:string; ivantiName?:string; description?:string; jiraType:string; options?:string[]; required?:boolean; selected?:boolean };
type Service = {
  id:string;
  analysis?: { serviceName?:string; description?:string; fields?:Field[]; suggestedWorkflow?:{statuses?:string[]} };
  formSections?: Array<{id:string;name:string;fieldIds:string[]}>;
  proposedConditions?: Array<{id:string;controllerFieldId:string;operator:string;value:string;targetFieldIds:string[]}>;
  ivantiWorkflows?: ParsedWorkflow[];
  build?: { fieldResults?: any[]; formCreated?:boolean; workflowCreated?:boolean; automationGenerated?:boolean };
  updatedAt?:string;
};
type Project = { name?:string; targetProjectId?:string; services?:Service[]; updatedAt?:string };
type RunnerResult = { serviceId:string; serviceName:string; status:'complete'|'partial'|'failed'; steps:Array<{key:string;status:'ok'|'warning'|'failed';message:string}> };

const PROJECT_KEY='ivanti-migration-assistant-project-v3';
const RESULT_KEY='ivanti-migration-assistant-full-run-v1';

function readProject():Project { try { return JSON.parse(localStorage.getItem(PROJECT_KEY)||'{}') as Project; } catch { return {}; } }
function saveProject(project:Project){ localStorage.setItem(PROJECT_KEY,JSON.stringify(project)); window.dispatchEvent(new CustomEvent('ivanti-migration-project-changed',{detail:{project}})); }
function clean(v:unknown){ return String(v??'').replace(/\s+/g,' ').trim(); }

function updateServiceFields(project:Project,serviceId:string,fieldResults:any[]):Project{
  const now=new Date().toISOString();
  return {...project,updatedAt:now,services:(project.services||[]).map(service=>service.id===serviceId?{...service,updatedAt:now,build:{...(service.build||{}),fieldResults}}:service)};
}

function fieldPayload(service:Service){
  return (service.analysis?.fields||[]).filter(f=>f.selected!==false).map(f=>({name:f.name,ivantiName:f.ivantiName||f.name,description:f.description||'',jiraType:f.jiraType,options:f.options||[]}));
}

function mappedFormFields(service:Service,fieldResults:any[]){
  const byName=new Map(fieldResults.filter(r=>r?.id).map(r=>[clean(r.name).toLowerCase(),r]));
  return (service.analysis?.fields||[]).map(f=>({sourceId:f.id,id:(byName.get(clean(f.name).toLowerCase()) as any)?.id,name:f.name,required:Boolean(f.required),jiraType:f.jiraType,options:f.options||[]}));
}

function lifecycle(service:Service):string[]{
  const runtime=(service.ivantiWorkflows||[])[0];
  if(runtime) return ['Submitted','Fulfilment','Completed','Cancelled'];
  const source=service.analysis?.suggestedWorkflow?.statuses||[];
  return source.length>=2?source:['Submitted','Fulfilment','Completed'];
}

export default function FullMigrationRunnerMount(){
  const [target,setTarget]=useState<HTMLElement|null>(null);
  const [project,setProject]=useState<Project>(()=>readProject());
  const [busy,setBusy]=useState(false);
  const [results,setResults]=useState<RunnerResult[]>(()=>{try{return JSON.parse(localStorage.getItem(RESULT_KEY)||'[]');}catch{return[];}});

  useEffect(()=>{
    const refresh=()=>setProject(readProject());
    const find=()=>{const panels=[...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];setTarget(panels.find(p=>p.querySelector('h1')?.textContent?.trim()==='Migration settings')||null);};
    refresh();find(); const obs=new MutationObserver(find);obs.observe(document.body,{childList:true,subtree:true});
    window.addEventListener('ivanti-migration-project-changed',refresh); window.addEventListener('storage',refresh);
    return()=>{obs.disconnect();window.removeEventListener('ivanti-migration-project-changed',refresh);window.removeEventListener('storage',refresh);};
  },[]);

  const ready=useMemo(()=>(project.services||[]).filter(s=>Boolean(s.analysis?.serviceName)&&Boolean((s.ivantiWorkflows||[]).length)),[project]);

  async function run(){
    if(busy||!project.targetProjectId||!ready.length)return;
    if(!window.confirm(`Build the captured Jira components for ${ready.length} mapped service${ready.length===1?'':'s'} in the selected target project?`))return;
    setBusy(true); const runResults:RunnerResult[]=[]; let working=readProject();
    for(const service of ready){
      const steps:RunnerResult['steps']=[]; const name=clean(service.analysis?.serviceName)||service.id;
      try{
        const fields=fieldPayload(service);
        const fieldResults:any[]=fields.length?await invoke('createFields',{fields,projectId:working.targetProjectId}) as any[]:[];
        steps.push({key:'fields',status:'ok',message:`${fieldResults.length} field result(s) returned.`});
        working=updateServiceFields(working,service.id,fieldResults); saveProject(working);

        const structure:any=await invoke('createJiraStructure',{serviceName:name,description:service.analysis?.description||'',statuses:lifecycle(service),createIssueType:true,createWorkflow:true,createWorkflowScheme:true});
        if(!structure?.issueTypeId) throw new Error(structure?.message||'Jira structure did not return an issue type.');
        steps.push({key:'structure',status:'ok',message:`Issue type ${structure.issueTypeId}; workflow ${structure.workflowName||structure.workflowId||'created/reused'}.`});

        const request:any=await invoke('createJsmRequestType',{projectId:working.targetProjectId,issueTypeId:structure.issueTypeId,name,description:service.analysis?.description||`Migrated from Ivanti: ${name}`});
        if(!request?.requestTypeId) throw new Error(request?.message||'JSM request type was not returned.');
        steps.push({key:'request-type',status:'ok',message:`Request type ${request.requestTypeId}.`});

        const form:any=await invoke('createJsmForm',{projectId:working.targetProjectId,requestTypeId:request.requestTypeId,name:`${name} - Ivanti Migration Form`,fields:mappedFormFields(service,fieldResults),sections:service.formSections||[],conditions:service.proposedConditions||[]});
        if(!form?.published) throw new Error(form?.message||'JSM Form was not published.');
        steps.push({key:'form',status:'ok',message:`Form ${form.formId||'created'} published.`});

        const portal:any=await invoke('verifyJsmPortal',{projectId:working.targetProjectId,requestTypeId:request.requestTypeId,issueTypeId:structure.issueTypeId});
        steps.push({key:'portal',status:portal?.visibleInPortal?'ok':'warning',message:portal?.visibleInPortal?'Portal visibility verified.':'Request type created; portal group/visibility still needs review.'});
        steps.push({key:'workflow-activation',status:'warning',message:'Workflow scheme created/reused but not auto-assigned in bulk; multiple service workflows must be consolidated into the target project scheme safely.'});
        runResults.push({serviceId:service.id,serviceName:name,status:steps.some(s=>s.status==='warning')?'partial':'complete',steps});
      }catch(error){steps.push({key:'run',status:'failed',message:error instanceof Error?error.message:String(error)});runResults.push({serviceId:service.id,serviceName:name,status:'failed',steps});}
    }
    localStorage.setItem(RESULT_KEY,JSON.stringify(runResults)); setResults(runResults); setBusy(false);
  }

  if(!target)return null;
  return createPortal(<section style={{marginTop:24,border:'1px solid #dfe1e6',borderRadius:8,padding:20,background:'#fff'}} data-full-migration-runner="true">
    <div style={{fontSize:12,fontWeight:700,letterSpacing:'.08em',color:'#44546f',textTransform:'uppercase'}}>Migration execution</div>
    <h2 style={{margin:'5px 0 4px'}}>Build captured services in Jira</h2>
    <p style={{margin:0,color:'#626f86'}}>Runs the live Jira build for services that have a confirmed Ivanti workflow: fields, issue type/workflow structure, JSM request type, Form and portal verification. It deliberately does not replace the project workflow scheme in bulk until all issue-type mappings can be consolidated safely.</p>
    <div style={{marginTop:14,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}><button disabled={busy||!project.targetProjectId||!ready.length} onClick={()=>void run()}>{busy?'Building captured services…':`Build ${ready.length} captured service${ready.length===1?'':'s'} now`}</button><span style={{fontSize:13,color:'#626f86'}}>{project.targetProjectId?`Target project ${project.targetProjectId}`:'Choose a target project first.'}</span></div>
    {results.length>0&&<div style={{marginTop:14,display:'grid',gap:8}}>{results.map(r=><div key={r.serviceId} style={{padding:10,border:'1px solid #dfe1e6',borderRadius:6}}><strong>{r.serviceName} — {r.status}</strong>{r.steps.map((s,i)=><div key={`${s.key}-${i}`} style={{marginTop:4,fontSize:12,color:s.status==='failed'?'#ae2a19':s.status==='warning'?'#974f0c':'#164b35'}}>{s.key}: {s.message}</div>)}</div>)}</div>}
  </section>,target);
}
