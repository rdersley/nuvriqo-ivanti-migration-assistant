import api, { route } from '@forge/api';

const PROJECT_ID = '12789';
const PROJECT_KEY = 'IT';
const SERVICE_DESK_ID = '2183';
const SERVICE_NAME = 'Vector Access Request';
const FORM_NAME = `${SERVICE_NAME} - Ivanti Migration Form`;
const FIELD_SUFFIX = ' - Vector Access';

type Request = { method?: string; body?: string; headers?: Record<string, string | string[] | undefined> };
type Field = { id: string; name: string; schema?: { custom?: string } };
type Source = { name: string; type: string; required: boolean; description?: string };
// Show the section when any group matches; every check in a group must match.
type Rule = Array<Array<[string, string]>>;
type Bucket = { name: string; questions: string[]; rule?: Rule };

// Customer-input questions from Ivanti offering 8A12298C44EC42309B53935D6F34E11D.
// Keep in step with FIELDS in .github/scripts/vector_access_release.py.
// Required questions inside hidden sections are not enforced, which matches
// the Ivanti "required when visible" expressions.
const SOURCES: Source[] = [
  { name:'New Vector Account',type:'select',required:true },
  { name:'Password reset or Modify?',type:'select',required:true },
  { name:'Business Case',type:'paragraph',required:true,description:'Why is this needed? Please give details' },
  { name:'User Name',type:'user',required:true,description:'Name of user for whom Vector account is needed' },
  { name:'User Email',type:'text',required:true },
  { name:'Vector system',type:'select',required:true },
  { name:'OBR',type:'checkbox',required:false },
  { name:'What type of Vector System',type:'select',required:true },
  { name:'Super Admin',type:'select',required:false,description:'Is Super Admin role required' },
  { name:'Super Admin details',type:'paragraph',required:true,description:'Give some details of why Super Admin is required' },
  { name:'Super Admin from',type:'date',required:true },
  { name:'Super Admin to',type:'date',required:true },
  { name:'User Permissions',type:'select',required:true },
  { name:'Additional requested modifications',type:'paragraph',required:false },
  { name:'Pre approved For Test',type:'checkbox',required:false },
  { name:'SelfCreate Test',type:'checkbox',required:false },
  { name:'Pre approved for UAT',type:'checkbox',required:false },
  { name:'SelfCreate UAT',type:'checkbox',required:false },
  { name:'Pre approved for Prod',type:'checkbox',required:false },
  { name:'SelfCreate Prod',type:'checkbox',required:false },
];

// Ivanti: NewAccount == "Yes" || PwdResOrMod == "Account Modifications"
const NEW_OR_MODIFY: Rule = [[['New Vector Account','Yes']],[['Password reset or Modify?','Account Modifications']]];
const BUCKETS: Bucket[] = [
  { name:'Vector account', questions:['New Vector Account'] },
  { name:'Password reset or modification', questions:['Password reset or Modify?'], rule:[[['New Vector Account','No']]] },
  { name:'Business case', questions:['Business Case'], rule:NEW_OR_MODIFY },
  { name:'User and Vector system', questions:['User Name','User Email','Vector system','OBR','What type of Vector System'] },
  { name:'Super Admin', questions:['Super Admin'], rule:NEW_OR_MODIFY },
  { name:'Super Admin details', questions:['Super Admin details','Super Admin from','Super Admin to'], rule:[[['Super Admin','Yes']]] },
  { name:'User permissions', questions:['User Permissions','Additional requested modifications'], rule:[[['Super Admin','No']]] },
  { name:'Test approvals', questions:['Pre approved For Test','SelfCreate Test'], rule:[[['What type of Vector System','Test']]] },
  { name:'UAT approvals', questions:['Pre approved for UAT','SelfCreate UAT'], rule:[[['What type of Vector System','UAT']]] },
  { name:'Production approvals', questions:['Pre approved for Prod','SelfCreate Prod'], rule:[[['What type of Vector System','Production']]] },
];
const EXPECTED_QUESTIONS = SOURCES.length;
const EXPECTED_CONDITIONS = BUCKETS.filter(b=>b.rule).length;

const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const response=(statusCode:number,value:unknown)=>({statusCode,headers:{'Content-Type':['application/json']},body:JSON.stringify(value)});
async function json<T>(r:any):Promise<T>{const t=await r.text();let b:any;try{b=t?JSON.parse(t):{}}catch{b=t}if(!r.ok)throw new Error(`Jira HTTP ${r.status}: ${typeof b==='string'?b.slice(0,600):JSON.stringify(b).slice(0,600)}`);return b as T}
function header(h:Request['headers'],name:string){const k=Object.keys(h||{}).find(x=>x.toLowerCase()===name.toLowerCase());const v=k?h?.[k]:'';return Array.isArray(v)?String(v[0]||''):String(v||'')}
function kind(f:Field){const c=String(f.schema?.custom||'');if(c.includes('textarea'))return'paragraph';if(c.includes('textfield'))return'text';if(c.includes('datepicker'))return'date';if(c.includes('userpicker'))return'user';if(c.endsWith(':select'))return'select';return''}
function compatible(f:Field,w:string){return kind(f)===(w==='checkbox'?'select':w)}
function qtype(t:string){return({paragraph:'tl',date:'da',select:'cd',checkbox:'cd',user:'us'} as Record<string,string>)[t]||'ts'}
function heading(name:string){return{type:'heading',attrs:{level:2},content:[{type:'text',text:name}]}}
function question(qid:string){return{type:'extension',attrs:{extensionKey:'question',extensionType:'com.thinktilt.proforma',layout:'default',localId:`vector-access-${qid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,parameters:{id:Number(qid)}}}}

async function fields(){const visible=await json<Field[]>(await api.asApp().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}}));const all=new Map(visible.map(x=>[x.id,x]));let start=0;for(let page=0;page<100;page++){const b=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/search?type=custom&startAt=${start}&maxResults=100`,{headers:{Accept:'application/json'}}));const values=b.values||[];for(const f of values)if(f.id)all.set(String(f.id),f);if(!values.length||b.isLast)break;start=Number(b.startAt??start)+Number(b.maxResults??100);if(start>=Number(b.total??Infinity))break}return[...all.values()]}
async function optionId(fieldId:string,wanted:string){const contexts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context?startAt=0&maxResults=100`,{headers:{Accept:'application/json'}}));for(const c of contexts.values||[]){const opts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context/${String(c.id)}/option?startAt=0&maxResults=1000`,{headers:{Accept:'application/json'}}));const m=(opts.values||[]).find((x:any)=>norm(x.value)===norm(wanted));if(m?.id)return String(m.id)}return undefined}
async function readForm(formId:string){return json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{headers:{Accept:'application/json'}}))}
async function writeForm(formId:string,body:unknown,experimental=false){const headers:Record<string,string>={Accept:'application/json','Content-Type':'application/json'};if(experimental)headers['X-ExperimentalApi']='opt-in';await json(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{method:'PUT',headers,body:JSON.stringify(body)}))}

export async function handler(req:Request){try{
  if(String(req.method||'').toUpperCase()!=='POST')return response(405,{ok:false,error:'POST required'});
  const token=String(process.env.VECTOR_ACCESS_RELEASE_TOKEN||'');if(!token||header(req.headers,'authorization')!==`Bearer ${token}`)return response(401,{ok:false,error:'Unauthorized'});
  const project=await json<any>(await api.asApp().requestJira(route`/rest/api/3/project/${PROJECT_KEY}`,{headers:{Accept:'application/json'}}));if(String(project.id)!==PROJECT_ID)throw new Error('IT project guard failed');
  const types=await json<any>(await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true`,{headers:{Accept:'application/json'}}));const rt=(types.values||[]).find((x:any)=>x.name===SERVICE_NAME);if(!rt?.id||!rt?.issueTypeId)throw new Error(`${SERVICE_NAME} request type not found in IT Help`);const requestTypeId=String(rt.id),issueTypeId=String(rt.issueTypeId);

  const catalogue=await fields();const resolved=new Map<string,Field>();for(const s of SOURCES){const matches=catalogue.filter(f=>norm(f.name)===norm(`${s.name}${FIELD_SUFFIX}`)&&compatible(f,s.type));if(matches.length!==1)throw new Error(`Expected one compatible Jira field for ${s.name}, found ${matches.length}`);resolved.set(s.name,matches[0])}
  const questions:Record<string,any>={},qid=new Map<string,string>();SOURCES.forEach((s,i)=>{const id=String(i+1);qid.set(s.name,id);questions[id]={label:s.name,description:s.description||'',type:qtype(s.type),jiraField:resolved.get(s.name)!.id,questionKey:`vector-access-${id}`,validation:{rq:s.required}}});
  const layout:any[]=[],sections:Record<string,any>={};BUCKETS.forEach((b,i)=>{layout.push({version:1,type:'doc',content:[heading(b.name),...b.questions.map(n=>question(qid.get(n)!))]});if(i>0)sections[String(i)]={name:b.name,sectionType:'p'}});
  const settings={language:'en',name:FORM_NAME,primaryLocale:'en-US',submit:{lock:true,pdf:true}};const design={conditions:{},layout,questions,sections,settings};

  const index=await json<any[]>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{headers:{Accept:'application/json'}}));let formId=String(index.find(x=>norm(x.name)===norm(FORM_NAME))?.id||'');let formState='reused';if(!formId){const made=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({design:{conditions:{},layout:[],questions:{},sections:{},settings}})}));formId=String(made.formTemplate?.id||made.id||'');formState='created'}if(!formId)throw new Error('Form ID missing');
  await writeForm(formId,{design});let stored=await readForm(formId);if(Object.keys(stored.design?.questions||{}).length!==EXPECTED_QUESTIONS)throw new Error(`${EXPECTED_QUESTIONS}-question readback failed`);

  const conditions:Record<string,any>={};
  for(const b of BUCKETS.filter(x=>x.rule)){
    const section=Object.entries(stored.design.sections||{}).find(([,v]:any)=>norm(v.name)===norm(b.name));if(!section)throw new Error(`Section ${b.name} was not persisted`);
    const cIds:Record<string,string[]>={};const groups:any[]=[];
    for(const group of b.rule!){const checks:any[]=[];for(const [controller,wanted] of group){const fieldId=resolved.get(controller)!.id;const persisted=Object.entries(stored.design.questions||{}).find(([,q]:any)=>String(q.jiraField)===fieldId);const token=await optionId(fieldId,wanted);if(!persisted||!token)throw new Error(`Condition build failed for ${b.name}: ${controller} = ${wanted}`);const controllerId=String(persisted[0]);cIds[controllerId]=[...new Set([...(cIds[controllerId]||[]),token])];checks.push({fieldId:controllerId,type:'SOME_OF',constraint:[token]})}groups.push({operator:'AND',checks})}
    conditions[String(Object.keys(conditions).length+1)]={i:{co:{cIds},operator:'OR',groups},o:{sIds:[String(section[0])],t:'sh'}};
  }
  const conditioned:Record<string,any>={};for(const [sid,raw] of Object.entries(stored.design.sections||{})){const value={...(raw as any)};value.conditions=Object.entries(conditions).filter(([,c]:any)=>c.o.sIds.map(String).includes(String(sid))).map(([id])=>id);conditioned[sid]=value}
  await writeForm(formId,{design:{...stored.design,sections:conditioned,conditions}},true);stored=await readForm(formId);if(Object.keys(stored.design?.conditions||{}).length!==EXPECTED_CONDITIONS)throw new Error(`${EXPECTED_CONDITIONS}-condition readback failed`);

  await writeForm(formId,{design:stored.design,publish:{jira:{issueCreateIssueTypeIds:[],issueCreateRequestTypeIds:[Number(requestTypeId)],recommendedIssueRequestTypeIds:[],submitOnCreate:true,validateOnCreate:true},portal:{portalRequestTypeIds:[Number(requestTypeId)],submitOnCreate:true,validateOnCreate:true}}});
  const final=await readForm(formId);const portal=(final.publish?.portal?.portalRequestTypeIds||[]).map(String),jira=(final.publish?.jira?.issueCreateRequestTypeIds||[]).map(String);if(!portal.includes(requestTypeId)&&!jira.includes(requestTypeId))throw new Error('Form publication readback failed');
  return response(200,{ok:true,target:{projectKey:PROJECT_KEY,projectId:PROJECT_ID,serviceDeskId:SERVICE_DESK_ID},requestTypeId,issueTypeId,form:{id:formId,status:formState,questions:Object.keys(final.design?.questions||{}).length,required:SOURCES.filter(s=>s.required).length,sections:BUCKETS.length,conditions:Object.keys(final.design?.conditions||{}).length,published:true},qaTicketsCreated:0});
}catch(error){return response(500,{ok:false,error:error instanceof Error?error.message:String(error)})}}
