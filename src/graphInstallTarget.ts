import api, { route } from '@forge/api';

type JiraResponseLike = { ok:boolean; status:number; text():Promise<string> };

async function jiraJson<T>(response:JiraResponseLike):Promise<T>{
  const text=await response.text();
  let body:any=undefined;
  if(text){try{body=JSON.parse(text)}catch{body=text}}
  if(!response.ok)throw new Error(`Jira ${response.status}: ${typeof body==='string'?body.slice(0,400):JSON.stringify(body).slice(0,400)}`);
  return body as T;
}

const norm=(value:unknown)=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

export async function resolveGraphInstallTarget(projectId:string,serviceName:string){
  if(!projectId)throw new Error('Choose a target Jira project first.');
  if(!serviceName)throw new Error('Service name is required.');
  const response=await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`,{headers:{Accept:'application/json'}});
  const project=await jiraJson<{id?:string;key?:string;name?:string;issueTypes?:Array<{id?:string;name?:string;subtask?:boolean}>}>(response);
  const issueTypes=(project.issueTypes||[]).filter((item)=>!item.subtask);
  const wanted=norm(serviceName);
  let match=issueTypes.find((item)=>norm(item.name)===wanted);
  if(!match){
    const candidates=issueTypes.filter((item)=>{
      const name=norm(item.name);
      return name.includes(wanted)||wanted.includes(name);
    });
    if(candidates.length===1)match=candidates[0];
  }
  if(!match?.id){
    throw new Error(`Could not safely identify a Jira issue type for "${serviceName}" in ${project.name||project.key||projectId}. Create/reuse the service issue type first.`);
  }
  return {projectId:String(project.id||projectId),projectKey:String(project.key||''),projectName:String(project.name||''),issueTypeId:String(match.id),issueTypeName:String(match.name||'')};
}
