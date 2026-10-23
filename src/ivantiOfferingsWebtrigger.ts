import api, { route } from '@forge/api';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SPEC: Spec = require('./ivanti-offerings.json');

const PROJECT_ID = '12789';
const PROJECT_KEY = 'IT';
const SERVICE_DESK_ID = '2183';

type Request = { method?: string; body?: string; headers?: Record<string, string | string[] | undefined> };
type Field = { id: string; name: string; schema?: { custom?: string } };
type Question = { key: string; label: string; type: string; required: boolean; desc?: string; options?: string[]; optionsRef?: string };
// Show the section when the controller question has any of the listed answers.
// Jira Forms only honours one controller per section on the portal.
type Section = { title: string; rule?: { key: string; values: string[] }; questions: Question[] };
type Offering = { name: string; short: string; group: string | null; approval: boolean; description: string; sections: Section[] };
type Spec = { lists: Record<string, string[]>; offerings: Offering[] };

const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const response=(statusCode:number,value:unknown)=>({statusCode,headers:{'Content-Type':['application/json']},body:JSON.stringify(value)});
async function json<T>(r:any):Promise<T>{const t=await r.text();let b:any;try{b=t?JSON.parse(t):{}}catch{b=t}if(!r.ok)throw new Error(`Jira HTTP ${r.status}: ${typeof b==='string'?b.slice(0,600):JSON.stringify(b).slice(0,600)}`);return b as T}
function header(h:Request['headers'],name:string){const k=Object.keys(h||{}).find(x=>x.toLowerCase()===name.toLowerCase());const v=k?h?.[k]:'';return Array.isArray(v)?String(v[0]||''):String(v||'')}
function kind(f:Field){const c=String(f.schema?.custom||'');if(c.includes('textarea'))return'paragraph';if(c.includes('textfield'))return'text';if(c.includes('datepicker'))return'date';if(c.endsWith(':datetime'))return'datetime';if(c.endsWith(':float'))return'number';if(c.includes('userpicker'))return'user';if(c.endsWith(':select'))return'select';return''}
function compatible(f:Field,w:string){return kind(f)===(w==='checkbox'?'select':w)}
function qtype(t:string){return({paragraph:'tl',date:'da',datetime:'dt',number:'no',select:'cd',checkbox:'cd',user:'us',attachment:'at'} as Record<string,string>)[t]||'ts'}
function heading(name:string){return{type:'heading',attrs:{level:2},content:[{type:'text',text:name}]}}
function question(qid:string){return{type:'extension',attrs:{extensionKey:'question',extensionType:'com.thinktilt.proforma',layout:'default',localId:`ivanti-${qid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,parameters:{id:Number(qid)}}}}
const allQuestions=(o:Offering)=>o.sections.flatMap(s=>s.questions);

// Mirrors jira_field_names() in .github/scripts/ivanti_offerings_release.py.
function fieldNames(o:Offering){const seen=new Map<string,number>(),names=new Map<string,string>();for(const q of allQuestions(o)){if(q.type==='attachment')continue;const k=norm(q.label);const n=(seen.get(k)||0)+1;seen.set(k,n);names.set(q.key,`${q.label} - ${o.short}${n>1?` (${n})`:''}`)}return names}

async function fields(){const visible=await json<Field[]>(await api.asApp().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}}));const all=new Map(visible.map(x=>[x.id,x]));let start=0;for(let page=0;page<100;page++){const b=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/search?type=custom&startAt=${start}&maxResults=100`,{headers:{Accept:'application/json'}}));const values=b.values||[];for(const f of values)if(f.id)all.set(String(f.id),f);if(!values.length||b.isLast)break;start=Number(b.startAt??start)+Number(b.maxResults??100);if(start>=Number(b.total??Infinity))break}return[...all.values()]}
async function optionId(fieldId:string,wanted:string){const contexts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context?startAt=0&maxResults=100`,{headers:{Accept:'application/json'}}));for(const c of contexts.values||[]){const opts=await json<any>(await api.asApp().requestJira(route`/rest/api/3/field/${fieldId}/context/${String(c.id)}/option?startAt=0&maxResults=1000`,{headers:{Accept:'application/json'}}));const m=(opts.values||[]).find((x:any)=>norm(x.value)===norm(wanted));if(m?.id)return String(m.id)}return undefined}
async function readForm(formId:string){return json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{headers:{Accept:'application/json'}}))}
async function writeForm(formId:string,body:unknown,experimental=false){const headers:Record<string,string>={Accept:'application/json','Content-Type':'application/json'};if(experimental)headers['X-ExperimentalApi']='opt-in';await json(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`,{method:'PUT',headers,body:JSON.stringify(body)}))}

async function release(o:Offering){
  const formName=`${o.name} - Ivanti Migration Form`;
  const types=await json<any>(await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk/${SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true`,{headers:{Accept:'application/json'}}));const rt=(types.values||[]).find((x:any)=>x.name===o.name);if(!rt?.id)throw new Error(`${o.name} request type not found in IT Help`);const requestTypeId=String(rt.id);

  const names=fieldNames(o);const catalogue=await fields();const resolved=new Map<string,Field>();
  for(const q of allQuestions(o)){if(q.type==='attachment')continue;const matches=catalogue.filter(f=>norm(f.name)===norm(names.get(q.key))&&compatible(f,q.type));if(matches.length!==1)throw new Error(`Expected one compatible Jira field for ${names.get(q.key)}, found ${matches.length}`);resolved.set(q.key,matches[0])}

  const questions:Record<string,any>={},qid=new Map<string,string>();
  allQuestions(o).forEach((q,i)=>{const id=String(i+1);qid.set(q.key,id);const def:any={label:q.label,description:q.desc||'',type:qtype(q.type),questionKey:`ivanti-${id}`,validation:{rq:q.required}};const f=resolved.get(q.key);if(f)def.jiraField=f.id;questions[id]=def});
  const layout:any[]=[],sections:Record<string,any>={};o.sections.forEach((s,i)=>{layout.push({version:1,type:'doc',content:[heading(s.title),...s.questions.map(q=>question(qid.get(q.key)!))]});if(i>0)sections[String(i)]={name:s.title,sectionType:'p'}});
  const settings={language:'en',name:formName,primaryLocale:'en-US',submit:{lock:true,pdf:true}};const design={conditions:{},layout,questions,sections,settings};

  const index=await json<any[]>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{headers:{Accept:'application/json'}}));let formId=String(index.find(x=>norm(x.name)===norm(formName))?.id||'');let formState='reused';if(!formId){const made=await json<any>(await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({design:{conditions:{},layout:[],questions:{},sections:{},settings}})}));formId=String(made.formTemplate?.id||made.id||'');formState='created'}if(!formId)throw new Error('Form ID missing');
  await writeForm(formId,{design});let stored=await readForm(formId);const expectedQuestions=allQuestions(o).length;if(Object.keys(stored.design?.questions||{}).length!==expectedQuestions)throw new Error(`${expectedQuestions}-question readback failed`);

  const conditions:Record<string,any>={};
  for(const s of o.sections.filter(x=>x.rule)){
    const section=Object.entries(stored.design.sections||{}).find(([,v]:any)=>norm(v.name)===norm(s.title));if(!section)throw new Error(`Section ${s.title} was not persisted`);
    const {key,values}=s.rule!;const field=resolved.get(key);const controllerId=qid.get(key);if(!field||!controllerId||!stored.design.questions?.[controllerId])throw new Error(`Condition build failed for ${s.title}: ${key} not on form`);
    const tokens:string[]=[];for(const v of values){const token=await optionId(field.id,v);if(!token)throw new Error(`Condition build failed for ${s.title}: ${key} = ${v}`);tokens.push(token)}
    conditions[String(Object.keys(conditions).length+1)]={i:{co:{cIds:{[controllerId]:tokens}},operator:'OR',groups:[{operator:'AND',checks:[{fieldId:controllerId,type:'SOME_OF',constraint:tokens}]}]},o:{sIds:[String(section[0])],t:'sh'}};
  }
  const expectedConditions=o.sections.filter(x=>x.rule).length;
  if(expectedConditions){const conditioned:Record<string,any>={};for(const [sid,raw] of Object.entries(stored.design.sections||{})){const value={...(raw as any)};value.conditions=Object.entries(conditions).filter(([,c]:any)=>c.o.sIds.map(String).includes(String(sid))).map(([id])=>id);conditioned[sid]=value}
    await writeForm(formId,{design:{...stored.design,sections:conditioned,conditions}},true);stored=await readForm(formId);if(Object.keys(stored.design?.conditions||{}).length!==expectedConditions)throw new Error(`${expectedConditions}-condition readback failed`)}

  await writeForm(formId,{design:stored.design,publish:{jira:{issueCreateIssueTypeIds:[],issueCreateRequestTypeIds:[Number(requestTypeId)],recommendedIssueRequestTypeIds:[],submitOnCreate:true,validateOnCreate:true},portal:{portalRequestTypeIds:[Number(requestTypeId)],submitOnCreate:true,validateOnCreate:true}}});
  const final=await readForm(formId);const portal=(final.publish?.portal?.portalRequestTypeIds||[]).map(String),jira=(final.publish?.jira?.issueCreateRequestTypeIds||[]).map(String);if(!portal.includes(requestTypeId)&&!jira.includes(requestTypeId))throw new Error('Form publication readback failed');
  const questionCount=Object.keys(final.design?.questions||{}).length,conditionCount=Object.keys(final.design?.conditions||{}).length;
  return{name:o.name,ok:questionCount===expectedQuestions&&conditionCount===expectedConditions,requestTypeId,form:{id:formId,status:formState,questions:questionCount,expectedQuestions,conditions:conditionCount,expectedConditions,published:true}};
}

// One offering per call keeps each invocation well inside the Forge time limit.
export async function handler(req:Request){try{
  if(String(req.method||'').toUpperCase()!=='POST')return response(405,{ok:false,error:'POST required'});
  const token=String(process.env.IVANTI_OFFERINGS_RELEASE_TOKEN||'');if(!token||header(req.headers,'authorization')!==`Bearer ${token}`)return response(401,{ok:false,error:'Unauthorized'});
  const project=await json<any>(await api.asApp().requestJira(route`/rest/api/3/project/${PROJECT_KEY}`,{headers:{Accept:'application/json'}}));if(String(project.id)!==PROJECT_ID)throw new Error('IT project guard failed');
  let body:any={};try{body=req.body?JSON.parse(req.body):{}}catch{return response(400,{ok:false,error:'Invalid JSON body'})}
  const offering=SPEC.offerings.find(o=>o.name===body.name);if(!offering)return response(404,{ok:false,error:`Unknown offering ${String(body.name)}`,known:SPEC.offerings.map(o=>o.name)});
  const result=await release(offering);return response(result.ok?200:500,{...result,qaTicketsCreated:0});
}catch(error){return response(500,{ok:false,error:error instanceof Error?error.message:String(error)})}}
