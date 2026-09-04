import Resolver from '@forge/resolver';
import api from '@forge/api';
import { kvs } from '@forge/kvs';
import { handler as legacyHandler } from './index';

type InvocationEvent = {
  call?: { functionKey?: string; payload?: Record<string, unknown>; jobId?: string };
  context?: Record<string, unknown>;
};
type IvantiConnection = { tenantUrl: string; apiKey: string; updatedAt: string };
type StoredIvantiConnection = { tenantUrl: string; updatedAt: string };
const CONNECTION_KEY = 'ivanti-rest-connection-v1';
const API_KEY_SECRET = 'ivanti-rest-api-key-v1';
const IVANTI_FUNCTIONS = new Set(['getIvantiConnection','saveIvantiConnection','testIvantiConnection','discoverIvantiRequestOfferings']);
const ivantiResolver = new Resolver();

function normaliseTenantUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Ivanti tenant URL is required.');
  let parsed: URL;
  try { parsed = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { throw new Error('Enter a valid Ivanti tenant URL.'); }
  if (parsed.protocol !== 'https:') throw new Error('Ivanti tenant URL must use HTTPS.');
  return `${parsed.protocol}//${parsed.host}`;
}
function normaliseApiKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('Ivanti REST API Key Reference ID is required.');
  if (key.length < 16 || key.length > 256) throw new Error('The REST API Key Reference ID does not look valid.');
  return key;
}
function maskKey(key: string): string { return key.length < 10 ? '••••••••' : `${key.slice(0,6)}••••••••${key.slice(-4)}`; }
async function readStoredConnection(): Promise<{metadata?:StoredIvantiConnection;apiKey?:string}> { return { metadata: await kvs.get(CONNECTION_KEY) as StoredIvantiConnection|undefined, apiKey: await kvs.getSecret(API_KEY_SECRET) as string|undefined }; }
async function persistConnection(tenantUrlValue: unknown, apiKeyValue: unknown): Promise<IvantiConnection> {
  const tenantUrl = normaliseTenantUrl(tenantUrlValue); const suppliedKey = String(apiKeyValue ?? '').trim(); const existingKey = await kvs.getSecret(API_KEY_SECRET) as string|undefined; const apiKey = suppliedKey ? normaliseApiKey(suppliedKey) : existingKey;
  if (!apiKey) throw new Error('Ivanti REST API Key Reference ID is required.');
  const updatedAt = new Date().toISOString(); await kvs.set(CONNECTION_KEY,{tenantUrl,updatedAt}); await kvs.setSecret(API_KEY_SECRET,apiKey); return {tenantUrl,apiKey,updatedAt};
}
async function getSavedConnection(): Promise<IvantiConnection> { const {metadata,apiKey}=await readStoredConnection(); if(!metadata?.tenantUrl||!apiKey) throw new Error('No Ivanti connection has been saved yet.'); return {tenantUrl:metadata.tenantUrl,apiKey,updatedAt:metadata.updatedAt}; }
async function ivantiFetch(connection: IvantiConnection,path:string) { const response=await api.fetch(`${connection.tenantUrl}${path}`,{method:'GET',headers:{Accept:'application/json, application/xml, text/xml;q=0.9, */*;q=0.8',Authorization:`rest_api_key=${connection.apiKey}`}}); const text=await response.text(); return {ok:response.ok,status:response.status,statusText:response.statusText,text,contentType:response.headers.get('content-type')||''}; }
function explainHttp(status:number,body:string):string { const compact=body.replace(/\s+/g,' ').trim().slice(0,500); if(status===401)return 'Ivanti rejected the REST API key (401 Unauthorized). Check that the key is active and belongs to this tenant.'; if(status===403)return 'Ivanti accepted the request but the selected user/role is not allowed to access this resource (403 Forbidden).'; if(status===404)return 'The Ivanti API endpoint was not found on this tenant (404).'; return `Ivanti returned HTTP ${status}${compact?`: ${compact}`:''}`; }
function entitySetsFromMetadata(xml:string):string[]{const names=new Set<string>();const regex=/<EntitySet\s+[^>]*Name=["']([^"']+)["']/gi;let match:RegExpExecArray|null;while((match=regex.exec(xml))!==null)names.add(match[1]);return [...names];}
function offeringCandidates(metadata:string):string[]{const discovered=entitySetsFromMetadata(metadata).filter(name=>/request.*offer|offer.*request|servicereq.*template|request.*template/i.test(name));return [...new Set(['ServiceReqTemplates',...discovered,'ServiceReqTemplate','RequestOfferings','RequestOffering','requestofferings','servicereqtemplates','servicerequesttemplates'])];}
function parseJson(text:string):unknown{try{return JSON.parse(text);}catch{return undefined;}}
function extractRecords(body:unknown):Array<Record<string,unknown>>{if(!body||typeof body!=='object')return[];const candidate=body as {value?:unknown;d?:{results?:unknown}};if(Array.isArray(candidate.value))return candidate.value.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object');if(Array.isArray(candidate.d?.results))return candidate.d.results.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object');return[];}
function firstString(record:Record<string,unknown>,names:string[]):string{for(const name of names){const direct=record[name];if(direct!==undefined&&direct!==null&&String(direct).trim())return String(direct).trim();const key=Object.keys(record).find(item=>item.toLowerCase()===name.toLowerCase());if(key&&record[key]!==undefined&&record[key]!==null&&String(record[key]).trim())return String(record[key]).trim();}return'';}

async function testConnection(connection:IvantiConnection){
  const metadata=await ivantiFetch(connection,'/api/odata/$metadata');
  const controlObjects=['Incidents','Employees'];
  const controlAttempts:Array<{entitySet:string;status:number}>=[];
  for(const entitySet of controlObjects){const response=await ivantiFetch(connection,`/api/odata/businessobject/${entitySet}?$top=1`);controlAttempts.push({entitySet,status:response.status});}
  const candidates=offeringCandidates(metadata.ok?metadata.text:''); const attempts:Array<{entitySet:string;status:number}>=[];
  for(const entitySet of candidates){const response=await ivantiFetch(connection,`/api/odata/businessobject/${encodeURIComponent(entitySet)}?$top=1`);if(response.ok){const records=extractRecords(parseJson(response.text));return {ok:true,status:response.status,tenantUrl:connection.tenantUrl,tenantHost:new URL(connection.tenantUrl).hostname,sampleCount:records.length,message:`Connected to Ivanti. Service Request Template access confirmed via ${entitySet}.`,metadataAvailable:metadata.ok,metadataStatus:metadata.status,controlAttempts,entitySet};}attempts.push({entitySet,status:response.status});}
  const summary=attempts.map(a=>`${a.entitySet} (${a.status})`).join(', ');
  const controls=controlAttempts.map(a=>`${a.entitySet} (${a.status})`).join(', ');
  const controlReadable=controlAttempts.some(a=>a.status>=200&&a.status<300);
  const diagnostic=controlReadable?'General OData access works, but Service Request Template objects are blocked or not exposed through this endpoint.':'General OData access is also failing, so this is not specific to Service Request Templates.';
  throw new Error(`Ivanti is reachable, but Service Request Template access could not be confirmed. Metadata: ${metadata.status}. Control objects: ${controls}. Tried: ${summary || 'no candidate objects'}. ${diagnostic}`);
}

ivantiResolver.define('getIvantiConnection',async()=>{const {metadata,apiKey}=await readStoredConnection();return metadata?.tenantUrl&&apiKey?{configured:true,tenantUrl:metadata.tenantUrl,apiKeyMasked:maskKey(apiKey),updatedAt:metadata.updatedAt}:{configured:false,tenantUrl:'',apiKeyMasked:''};});
ivantiResolver.define('saveIvantiConnection',async({payload})=>{const c=await persistConnection(payload?.tenantUrl??payload?.baseUrl,payload?.apiKey);return{configured:true,tenantUrl:c.tenantUrl,apiKeyMasked:maskKey(c.apiKey),updatedAt:c.updatedAt};});
ivantiResolver.define('testIvantiConnection',async({payload})=>{const inline=Boolean(String(payload?.tenantUrl??payload?.baseUrl??'').trim()||String(payload?.apiKey??'').trim());const c=inline?await persistConnection(payload?.tenantUrl??payload?.baseUrl,payload?.apiKey):await getSavedConnection();return testConnection(c);});
ivantiResolver.define('discoverIvantiRequestOfferings',async({payload})=>{const inline=Boolean(String(payload?.tenantUrl??payload?.baseUrl??'').trim()||String(payload?.apiKey??'').trim());const c=inline?await persistConnection(payload?.tenantUrl??payload?.baseUrl,payload?.apiKey):await getSavedConnection();const test=await testConnection(c);const entitySet=String((test as {entitySet?:string}).entitySet||'');if(!entitySet)throw new Error('No readable Service Request Template business object was identified.');const response=await ivantiFetch(c,`/api/odata/businessobject/${encodeURIComponent(entitySet)}?$top=250`);if(!response.ok)throw new Error(explainHttp(response.status,response.text));const records=extractRecords(parseJson(response.text));const offerings=records.map((record,index)=>({id:firstString(record,['RecId','RecID','Id','ID'])||`${entitySet}-${index+1}`,name:firstString(record,['Name','DisplayName','Title','Subject'])||`Request offering ${index+1}`,description:firstString(record,['Description','Details']),status:firstString(record,['Status','State']),service:firstString(record,['Service','ServiceName','Category']),raw:record}));return{ok:true,entitySet,count:offerings.length,offerings,message:`Discovered ${offerings.length} Ivanti service request template${offerings.length===1?'':'s'} from ${entitySet}.`};});
const ivantiHandler=ivantiResolver.getDefinitions();
export const handler=async(event:InvocationEvent,runtimeContext:unknown)=>{const functionKey=event?.call?.functionKey||'';if(IVANTI_FUNCTIONS.has(functionKey))return ivantiHandler(event as never,runtimeContext as never);return legacyHandler(event as never,runtimeContext as never);};
