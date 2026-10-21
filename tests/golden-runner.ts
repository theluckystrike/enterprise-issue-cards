import { vi } from 'vitest';
import { Modal } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import EnterpriseIssueCardsPlugin, { tokenId } from '../src/main';
import { runCase } from '../src/core';
import { bindPro, resetPro, SPONSORS } from '../src/pro';
import { SponsorsManager } from '../src/license/index';
import manifest from '../manifest.json';
const URL = 'https://git.example.test/team/repo/issues/42';
const KEY = 'git.example.test/team/repo#42';
const entry = {key: KEY, fields: {title:'Ticket', state:'open', labels:['bug'], author:'ada', body:'Body'}, fetchedAt:100};
async function fixture() {
 const app = App.createConfigured__({files:{}});
 const secrets = new Map<string,string>();
 Object.defineProperty(app,'secretStorage',{value:{getSecret:(id:string)=>secrets.get(id)??null,setSecret:(id:string,v:string)=>{secrets.set(id,v);}},configurable:true});
 app.workspace.onLayoutReady = vi.fn();
 const p = new EnterpriseIssueCardsPlugin(app as never,manifest as never);
 p.settings.host='https://git.example.test';await p.setToken('fake-token');p.cache[KEY]=structuredClone(entry);
 p.loadData=vi.fn(async()=>null);p.saveData=vi.fn(async()=>undefined);
 p.issueRequest=vi.fn(async()=>({status:200,headers:{},json:{title:'Updated',body:null}}) as never);
 return {p,secrets};
}
function pro(on:boolean) {
 const m=new SponsorsManager({config:SPONSORS,http:async()=>({status:200,json:null}),tokens:{get:()=>null,set:()=>undefined,clear:()=>undefined},store:{load:()=>null,save:()=>undefined}});
 vi.spyOn(m,'isPro').mockReturnValue(on);bindPro(m);
}
export async function runGoldenCase(op:string,a:unknown,b:unknown):Promise<unknown> {
 if(op!=='scenario') return runCase(op,a,b);
 const {p,secrets}=await fixture();
 try {
  switch(a) {
   case 'concurrent': {await Promise.all([p.fetchIssue(URL),p.fetchIssue(URL)]);return {requests:vi.mocked(p.issueRequest).mock.calls.length,title:p.cache[KEY].fields.title};}
   case 'secret': {await p.saveSettings();return {secret:secrets.get(await tokenId(p.settings.host)),savedHasToken:JSON.stringify(vi.mocked(p.saveData).mock.calls).includes('fake-token')};}
   case 'secretFailure': {p.app.secretStorage.setSecret=()=>{throw new Error('unavailable');};let failed=false;try{await p.setToken('replacement');}catch{failed=true;}return {failed,saves:vi.mocked(p.saveData).mock.calls.length};}
   case 'rate403': {p.issueRequest=vi.fn(async()=>({status:403,headers:{'x-ratelimit-remaining':'0'}}) as never);const msg=await p.fetchIssue(URL);await p.fetchIssue(URL);return {rate:msg.startsWith('Rate limit'),requests:vi.mocked(p.issueRequest).mock.calls.length,fetchedAt:p.cache[KEY].fetchedAt};}
   case 'freeGuard': {pro(false);p.settings.tickets=URL;p.settings.refreshMinutes=10;await p.refreshSaved();await p.scheduledTick(Date.now()+700000);return {saved:await p.saveProfile({name:'Other',host:'https://other.test'},'other-token'),requests:vi.mocked(p.issueRequest).mock.calls.length};}
   case 'profile': {pro(true);const saved=await p.saveProfile({name:'Other',host:'https://other.test'},'other-token');return {saved,authorized:p.resolve('https://other.test/o/r/issues/1').ok,separate:secrets.get(await tokenId('https://other.test'))==='other-token',savedHasToken:JSON.stringify(vi.mocked(p.saveData).mock.calls).includes('other-token')};}
   case 'proOff': {pro(true);await p.saveProfile({name:'Other',host:'https://other.test'},'other-token');pro(false);return {primary:p.resolve(URL).ok,other:p.resolve('https://other.test/o/r/issues/1').ok};}
   case 'duplicates': {p.settings.tickets=URL+'\n'+URL;return p.savedUrls();}
   case 'beforeSchedule': {pro(true);p.settings.refreshMinutes=10;p.settings.tickets=URL;await p.scheduledTick(Date.now()+100);return {requests:vi.mocked(p.issueRequest).mock.calls.length};}
   case 'project': {const open=vi.spyOn(Modal.prototype,'open').mockImplementation(function(this: Modal){document.body.appendChild(this.contentEl);void this.onOpen();});pro(true);p.settings.tickets=URL;p.openProject();const el=document.querySelector('.eic-project');const result={hasTitle:el?.textContent?.includes('Ticket')??false,hasTime:el?.textContent?.includes('Cached at')??false,requests:vi.mocked(p.issueRequest).mock.calls.length};el?.remove();open.mockRestore();return result;}
   case 'removeProfile': {pro(true);await p.saveProfile({name:'Other',host:'https://other.test'},'other-token');await p.removeProfile('Other');return {authorized:p.resolve('https://other.test/o/r/issues/1').ok};}
   case 'notFound': {p.issueRequest=vi.fn(async()=>({status:404,headers:{}}) as never);return {missing:(await p.fetchIssue(URL)).includes('no issue'),cached:!!p.cache[KEY]};}
   case 'clearCache': {await p.clearCache();return {entries:Object.keys(p.cache).length,secret:await p.getToken(),requests:vi.mocked(p.issueRequest).mock.calls.length};}
   case 'migration': {p.loadData=vi.fn(async()=>({host:p.settings.host,token:'legacy-secret',cache:{}}));const save=vi.mocked(p.saveData);await p.onload();return {legacySaved:JSON.stringify(save.mock.calls).includes('legacy-secret'),legacyUsed:(await p.getToken())==='legacy-secret',savedTokenField:(save.mock.calls[0][0] as Record<string,unknown>).token!==undefined};}
   default:throw new Error('Unknown golden scenario '+String(a));
  }
 }finally{resetPro();}
}
