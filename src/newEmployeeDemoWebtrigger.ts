import api, { route } from '@forge/api';
import { saveExecutableGraph, type ExecutableGraphPlan } from './orchestrationGraphEngine';

const PROJECT_ID = '12789';
const PROJECT_KEY = 'IT';
const SERVICE_DESK_ID = '2183';
const SERVICE_NAME = 'New Employee Setup';
const FORM_NAME = `${SERVICE_NAME} - Ivanti Migration Form`;

type Request = { method?: string; body?: string; headers?: Record<string, string | string[] | undefined> };
type Field = { id: string; name: string; schema?: { custom?: string } };
type Source = { name: string; type: string; required: boolean; section: string; description?: string; condition?: [string, string] };

const SOURCES: Source[] = [
  { name:'First Name',type:'text',required:true,section:'New Employee Information' },
  { name:'Last Name',type:'text',required:true,section:'New Employee Information' },
  { name:'Department',type:'text',required:true,section:'New Employee Information',description:'Migrated from the Ivanti department lookup.' },
  { name:'SubDepartment',type:'text',required:false,section:'New Employee Information',description:'Migrated from the Ivanti subdepartment lookup.' },
  { name:'Hiring Manager',type:'user',required:true,section:'New Employee Information' },
  { name:'Hiring Manager email',type:'text',required:true,section:'New Employee Information' },
  { name:'Title',type:'text',required:true,section:'New Employee Information' },
  { name:'Employment Type',type:'select',required:true,section:'New Employee Information' },
  { name:'Is user in ServiceDesk',type:'select',required:true,section:'New Employee Information' },
  { name:'Start Date',type:'date',required:true,section:'New Employee Information',description:'Minimum two weeks lead time required' },
  { name:'Location',type:'text',required:false,section:'Facility Detail',description:'Migrated from the Ivanti location lookup.' },
  { name:'Computer Required?',type:'checkbox',required:false,section:'Equipment Details',description:'Does the new employee need a computer?' },
  { name:'Computer Type',type:'select',required:true,section:'Equipment Details',condition:['Computer Required?','Yes'] },
  { name:'Docking station',type:'checkbox',required:false,section:'Equipment Details' },
  { name:'Primary Monitor',type:'select',required:false,section:'Equipment Details' },
  { name:'Second Monitor Requested?',type:'checkbox',required:false,section:'Equipment Details',condition:['Computer Required?','Yes'] },
  { name:'Secondary Monitor',type:'select',required:true,section:'Equipment Details',condition:['Second Monitor Requested?','Yes'] },
  { name:'Keyboard and Mouse',type:'checkbox',required:false,section:'Equipment Details',condition:['Computer Required?','Yes'] },
  { name:'Mobile Phone Required?',type:'checkbox',required:false,section:'Equipment Details' },
  { name:'Mobile Phone',type:'select',required:false,section:'Equipment Details',condition:['Mobile Phone Required?','Yes'] },
  { name:'Test Devices',type:'checkbox',required:false,section:'Equipment Details' },
  { name:'Additional information',type:'paragraph',required:false,section:'Equipment Details' },
  { name:'Is equipment shipping required?',type:'checkbox',required:false,section:'Equipment Details',condition:['Computer Required?','Yes'] },
  { name:'Employee private email address',type:'text',required:true,section:'Equipment Details',description:'For shipping purposes' },
  { name:'Employee phone number',type:'text',required:true,section:'Equipment Details',condition:['Is equipment shipping required?','Yes'],description:'For shipping purposes' },
  { name:'Employee address',type:'paragraph',required:true,section:'Equipment Details',condition:['Is equipment shipping required?','Yes'],description:'For shipping purposes' },
];

const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const response=(statusCode:number,value:unknown)=>({statusCode,headers:{'Content-Type':['application/json']},body:JSON.stringify(value)});
async function json<T>(r:any):Promise<T>{const t=await r.text();let b:any;try{b=t?JSON.parse(t):{}}catch{b=t}if(!r.ok)throw new Error(`Jira HTTP ${r.status}: ${typeof b==='string'?b.slice(0,600):JSON.stringify(b).slice(0,600)}`);return b as T}
function header(h:Request['headers'],name:string){const k=Object.keys(h||{}).find(x=>x.toLowerCase()===name.toLowerCase());const v=k?h?.[k]:'';return Array.isArray(v)?String(v[0]||''):String(v||'')}
function kind(f:Field){const c=String(f.schema?.custom||'');if(c.includes('textarea'))return'paragraph';if(c.includes('textfield'))return'text';if(c.includes('datepicker'))return'date';if(c.includes('userpicker'))return'user';if(c.endsWith(':select'))return'select';return''}
function compatible(f:Field,w:string){return kind(f)===(w==='checkbox'?'select':w)}
function qtype(t:string){return({paragraph:'tl',date:'da',select:'cd',checkbox:'cd',user:'us'} as Record<string,string>)[t]||'ts'}
function heading(name:string){return{type:'heading',attrs:{level:2},content:[{type:'text',text:name}]}}
function question(qid:string){return{type:'extension',attrs:{extensionKey:'question',extensionType:'com.thinktilt.proforma',layout:'default',localId:`new-employee-${qid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,parameters:{id:Number(qid)}}}}

async function fields(){const visible=await json<Field[]>(await api.asApp().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}}));const all=new Map(visible.map(x=>[x.id,x]));let start=0;for(let page=0;page<100;page++){const b=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/search?type=custom&startAt=${start}&maxResults=100`,{headers:{Accept:'application/json'}}));const values=b.values||[];for(const f of values)if(f.id)all.set(String(f.id),f);if(!values.length||b.isLast)break;start=Number(b.startAt??start)+Number(b.maxResults??100);if(start>=Number(b.total??Infinity))break}return[...all.values()]}
async function optionId(fieldId:string,wanted:string){const contexts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context?startAt=0&maxResults=100`,{headers:{Accept:'application/json'}}));for(const c of contexts.values||[]){const opts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context/${String(c.id)}/option?startAt=0&maxResults=1000`,{headers:{Accept:'application/json'}}));const m=(opts.values||[]).find((x:any)=>norm(x.value)===norm(wanted));if(m?.id)return String(m.id)}return undefined}

function graph(issueTypeId:string,requestTypeId:string):ExecutableGraphPlan{
  const task=(id:string,title:string,summary:string,team:string)=>({id,sourceType:'new-employee-v52',kind:'task' as const,title,summary,details:`Source-backed New Employee Setup fulfilment task: ${title}.`,team,dueDays:7,outcomes:['completed','cancelled','timedout']});
  const nodes:any[]=[
    {id:'start',sourceType:'new-employee-v52',kind:'start',title:'New Employee Setup',outcomes:['ok']},
    {id:'prepare',sourceType:'new-employee-v52',kind:'action',title:'Prepare request',outcomes:['ok']},
    task('ad','Active Directory','Configure Active directory','First Line Support'),
    task('o365','Office 365','Configure Office 365 Account','First Line Support'),
    {id:'notify',sourceType:'new-employee-v52',kind:'action',title:'Send Notification to Hiring Manager',outcomes:['ok']},
    {id:'join1',sourceType:'new-employee-v52',kind:'gate',title:'All Tasks Complete',outcomes:['ok']},
    task('vpn','Firewall/ VPN access/ Cisco VPN','Configure Firewall/ VPN access/ Cisco VPN','First Line Support'),
    task('jira','Jira','Setup Jira Account','Change Management'),
    task('slack','Slack','Set up new user in Slack','First Line Support'),
    task('harvest','Harvest','Set up new user in Harvest','First Line Support'),
    {id:'join2',sourceType:'new-employee-v52',kind:'gate',title:'All tasks completed',outcomes:['ok']},
    task('assets','Assets','Prepare equipment for new starter','First Line Support'),
    {id:'service-desk',sourceType:'new-employee-v52',kind:'decision',title:'Check if Servicedesk',condition:'Is user in ServiceDesk equals Yes',outcomes:['true','false']},
    task('pbx','PBX','Setup new User on PBX','First Line Support'),
    {id:'complete',sourceType:'new-employee-v52',kind:'action',title:'Standard Service Request Workflow Completion',outcomes:['ok']},
    {id:'stop',sourceType:'new-employee-v52',kind:'stop',title:'New Employee Setup complete',outcomes:[]},
  ];
  const e=(sourceId:string,outcome:string,targetId:string)=>({sourceId,sourceTitle:nodes.find(n=>n.id===sourceId).title,outcome,targetId,targetTitle:nodes.find(n=>n.id===targetId).title});
  const transitions=[e('start','ok','prepare'),e('prepare','ok','ad'),e('prepare','ok','o365'),e('prepare','ok','notify'),e('ad','completed','join1'),e('o365','completed','join1'),e('notify','ok','join1'),e('join1','ok','vpn'),e('join1','ok','jira'),e('join1','ok','slack'),e('join1','ok','harvest'),e('vpn','completed','join2'),e('jira','completed','join2'),e('slack','completed','join2'),e('harvest','completed','join2'),e('join2','ok','assets'),e('assets','completed','service-desk'),{...e('service-desk','true','pbx'),condition:'Is user in ServiceDesk equals Yes'},{...e('service-desk','false','complete'),condition:'Is user in ServiceDesk not equals Yes'},e('pbx','completed','complete'),e('complete','ok','stop')];
  return{version:2,serviceId:requestTypeId,serviceName:SERVICE_NAME,projectId:PROJECT_ID,issueTypeId,workflowName:'New Employee Setup — Ivanti v52 exact fulfilment',workflowVersion:'52',entryNodeIds:['start'],nodes,transitions,defects:["Source quickaction 4B5508C7BAEB4D4EB476F69AE7A152F6 has an unconnected ok exit and is excluded from execution."]}
}

export async function handler(req:Request){try{
  if(String(req.method||'').toUpperCase()!=='POST')return response(405,{ok:false,error:'POST required'});
  const token=String(process.env.NEW_EMPLOYEE_DEMO_TOKEN||'');if(!token||header(req.headers,'authorization')!==`Bearer ${token}`)return response(401,{ok:false,error:'Unauthorized'});
  const project=await json<any>(await api.asApp().requestJira(route`/rest/api/3/project/${PROJECT_KEY}`,{headers:{Accept:'application/json'}}));if(String(project.id)!==PROJECT_ID)throw new Error('IT project guard failed');
  const types=await json<any>(await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true`,{headers:{Accept:'application/json'}}));const rt=(types.values||[]).find((x:any)=>x.name===SERVICE_NAME);if(!rt?.id||!rt?.issueTypeId)throw new Error('New Employee request type not found in IT Help');const requestTypeId=String(rt.id),issueTypeId=String(rt.issueTypeId);
  const catalogue=await fields();const byName=new Map<string,Field[]>();for(const f of catalogue){const k=norm(f.name);byName.set(k,[...(byName.get(k)||[]),f])}const resolved=new Map<string,Field>();for(const s of SOURCES){for(const n of [s.name,`${s.name} - Ivanti`,`${s.name} - New Employee`]){const matches=(byName.get(norm(n))||[]).filter(f=>compatible(f,s.type));if(matches.length===1){resolved.set(s.name,matches[0]);break}}if(!resolved.has(s.name))throw new Error(`No compatible Jira field for ${s.name}`)}
  const questions:Record<string,any>={},qid=new Map<string,string>();SOURCES.forEach((s,i)=>{const id=String(i+1);qid.set(s.name,id);questions[id]={label:s.name,description:s.description||'',type:qtype(s.type),jiraField:resolved.get(s.name)!.id,questionKey:`new-employee-${id}`,validation:{rq:s.required}}});
  const buckets:any[]=['New Employee Information','Facility Detail','Equipment Details'].map(name=>({name,qids:SOURCES.filter(s=>s.section===name&&!s.condition).map(s=>qid.get(s.name)!)}));for(const s of SOURCES.filter(x=>x.condition))buckets.push({name:`${s.name} — conditional`,qids:[qid.get(s.name)!]});const layout:any[]=[],sections:Record<string,any>={};buckets.forEach((b,i)=>{layout.push({version:1,type:'doc',content:[heading(b.name),...b.qids.map(question)]});if(i>0)sections[String(i)]={name:b.name,sectionType:'p'}});const settings={language:'en',name:FORM_NAME,primaryLocale:'en-US',submit:{lock:true,pdf:true}};const design={conditions:{},layout,questions,sections,settings};
  const index=await json<any[]>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{headers:{Accept:'application/json'}}));let formId=String(index.find(x=>norm(x.name)===norm(FORM_NAME))?.id||'');let formState='reused';if(!formId){const made=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({design:{conditions:{},layout:[],questions:{},sections:{},settings}})}));formId=String(made.formTemplate?.id||made.id||'');formState='created'}if(!formId)throw new Error('Form ID missing');
  await json(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{method:'PUT',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({design})}));let stored=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{headers:{Accept:'application/json'}}));if(Object.keys(stored.design?.questions||{}).length!==26)throw new Error('26-question readback failed');
  const conditions:Record<string,any>={};for(const s of SOURCES.filter(x=>x.condition)){const [controller,wanted]=s.condition!;const fieldId=resolved.get(controller)!.id;const persisted=Object.entries(stored.design.questions||{}).find(([,q]:any)=>String(q.jiraField)===fieldId);const section=Object.entries(stored.design.sections||{}).find(([,v]:any)=>norm(v.name)===norm(`${s.name} — conditional`));const token=await optionId(fieldId,wanted);if(!persisted||!section||!token)throw new Error(`Condition build failed for ${s.name}`);const id=String(Object.keys(conditions).length+1),controllerId=String(persisted[0]);conditions[id]={i:{co:{cIds:{[controllerId]:[token]}},operator:'OR',groups:[{operator:'AND',checks:[{fieldId:controllerId,type:'SOME_OF',constraint:[token]}]}]},o:{sIds:[String(section[0])],t:'sh'}}}
  const conditioned:Record<string,any>={};for(const [sid,raw] of Object.entries(stored.design.sections||{})){const value={...(raw as any)};value.conditions=Object.entries(conditions).filter(([,c]:any)=>c.o.sIds.map(String).includes(String(sid))).map(([id])=>id);conditioned[sid]=value}let active={...stored.design,sections:conditioned,conditions};await json(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{method:'PUT',headers:{Accept:'application/json','Content-Type':'application/json','X-ExperimentalApi':'opt-in'},body:JSON.stringify({design:active})}));stored=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{headers:{Accept:'application/json'}}));if(Object.keys(stored.design?.conditions||{}).length!==8)throw new Error('8-condition readback failed');active=stored.design;
  await json(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{method:'PUT',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({design:active,publish:{jira:{issueCreateIssueTypeIds:[],issueCreateRequestTypeIds:[Number(requestTypeId)],recommendedIssueRequestTypeIds:[],submitOnCreate:true,validateOnCreate:true},portal:{portalRequestTypeIds:[Number(requestTypeId)],submitOnCreate:true,validateOnCreate:true}}})}));const final=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{headers:{Accept:'application/json'}}));const portal=(final.publish?.portal?.portalRequestTypeIds||[]).map(String),jira=(final.publish?.jira?.issueCreateRequestTypeIds||[]).map(String);if(!portal.includes(requestTypeId)&&!jira.includes(requestTypeId))throw new Error('Form publication readback failed');
  const installed=await saveExecutableGraph(graph(issueTypeId,requestTypeId));return response(200,{ok:true,target:{projectKey:PROJECT_KEY,projectId:PROJECT_ID,serviceDeskId:SERVICE_DESK_ID},requestTypeId,issueTypeId,form:{id:formId,status:formState,questions:26,required:13,sections:3,conditions:8,published:true},orchestration:{installed:true,tasks:8,workflowVersion:installed.workflowVersion,defects:installed.defects},qaTicketsCreated:0});
}catch(error){return response(500,{ok:false,error:error instanceof Error?error.message:String(error)})}}
