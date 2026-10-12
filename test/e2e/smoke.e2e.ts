import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';
const URL = 'https://git.example.test/team/repo/issues/42';
const KEY = 'git.example.test/team/repo#42';
interface P {
 settings: { host: string; profiles: {name: string; host: string}[]; tickets: string; refreshMinutes: number };
 cache: Record<string, {key: string; fields: {title: string; state: string; labels: string[]; author: string; body: string}; fetchedAt: number}>;
 issueRequest: unknown; demoCalls: number; demoStatus: number;
 setToken(token: string, host?: string): Promise<void>; saveSettings(): Promise<void>;
 saveProfile(profile: {name: string; host: string}, token: string): Promise<boolean>;
 openProject(): void;
 pro: {opts: {http: unknown}; refreshNow(): Promise<void>; signOut(): void};
}
async function setup(host = 'https://git.example.test', cached = false) {
 await browser.executeObsidian(async ({app}, id, server, seed, key) => {
  const p = (app as unknown as {plugins: {plugins: Record<string,P>}}).plugins.plugins[id];
  p.pro.signOut(); p.settings = {host: server, profiles: [], tickets: '', refreshMinutes: 0}; p.cache = {}; p.demoCalls = 0; p.demoStatus = 200;
  p.issueRequest = async () => { p.demoCalls++; return {status: p.demoStatus, headers: {}, json: {title: 'Fresh ticket', state: 'open', labels: [{name:'bug'},{name:'auth'}], user: {login:'ada'}, body:'line one\nline two\n![image](https://outside.test/p.png)\n<script>window.__eicExecuted=true</script>'}}; };
  if(server) await p.setToken('fake-enterprise-token');
  if(seed) p.cache[key] = {key, fields: {title:'Cached ticket', state:'closed', labels:['release'], author:'lee', body:'Saved body'}, fetchedAt:100};
  await p.saveSettings();
 }, pluginId, host, cached, KEY);
}
async function setPro(on: boolean) {
 await browser.executeObsidian(async ({app}, id, enabled) => {
  const p = (app as unknown as {plugins: {plugins: Record<string,P>}}).plugins.plugins[id];
  if(!enabled) {p.pro.signOut(); return;}
  p.pro.opts.http = async () => ({status:200, json:{data:{viewer:{login:'demo-reader'}, user:{sponsorshipForViewerAsSponsor:{isActive:true,isOneTimePayment:false,tier:{name:'$5 a month',monthlyPriceInCents:500}}}}}});
  app.secretStorage.setSecret(`${id}-github-token`, 'gho_'+'0'.repeat(36)); await p.pro.refreshNow();
 },pluginId,on);
}
let serial=0;
async function openCard(url=URL) {
 const file=`EIC test ${++serial}.md`;
 await obsidianPage.write(file, '# Team release\n\nRelease notes stay beside the issue.\n\n```ticket\nurl: '+url+'\n```\n');
 await obsidianPage.openFile(file);
 await browser.executeObsidian(async ({app}, path) => { await app.workspace.getMostRecentLeaf()?.setViewState({type:'markdown',state:{file:path,mode:'preview'}}); }, file);
}
async function text() {return browser.execute(()=>document.querySelector('.workspace-leaf.mod-active .markdown-preview-view .eic-card')?.textContent??'');}
async function waitText(s:string) {await browser.waitUntil(async()=>(await text()).includes(s),{timeout:20000,interval:100,timeoutMsg:'Expected card text '+s});}
async function calls() {return browser.executeObsidian(({app},id)=>(app as unknown as {plugins:{plugins:Record<string,P>}}).plugins.plugins[id].demoCalls,pluginId);}
describe(`${pluginId} real-app behavior`,function(){
 before(async function(){const version=await browser.executeObsidian(({obsidian})=>obsidian.apiVersion);console.info('Verified Obsidian API version '+version);await browser.execute(()=>{document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');});});
 it('reloads without errors',async function(){expect(await reloadPlugin(pluginId)).toEqual({enabled:true,reloaded:true,errors:[]});});
 it('shows unset-host error without a request',async function(){await setup('');await openCard();await waitText('No server host');expect(await calls()).toBe(0);});
 it('blocks another host before a request',async function(){await setup();await openCard('https://elsewhere.test/team/repo/issues/42');await waitText('Blocked');expect(await calls()).toBe(0);});
 it('fetches five fields and keeps body text inert',async function(){
  await setup();await openCard();await waitText('Fresh ticket');const t=await text();
  for(const field of ['State: open','Labels: bug, auth','Author: ada','line one','line two','<script>']) expect(t).toContain(field);
  expect(await browser.execute(()=>({images:document.querySelectorAll('.eic-card img').length,scripts:document.querySelectorAll('.eic-card script').length,executed:(window as unknown as {__eicExecuted?:boolean}).__eicExecuted??false}))).toEqual({images:0,scripts:0,executed:false});expect(await calls()).toBe(1);
 });
 it('renders cached data and refreshes with the card button',async function(){await setup('https://git.example.test',true);await openCard();await waitText('Cached ticket');expect(await calls()).toBe(0);await browser.$('.workspace-leaf.mod-active .markdown-preview-view .eic-refresh').click();await waitText('Fresh ticket');expect(await calls()).toBe(1);});
 it('shows an access error and preserves the cached time',async function(){
  await setup('https://git.example.test',true);await openCard();await waitText('Cached ticket');
  await browser.executeObsidian(({app},id)=>{(app as unknown as {plugins:{plugins:Record<string,P>}}).plugins.plugins[id].demoStatus=401;},pluginId);
  await browser.$('.workspace-leaf.mod-active .markdown-preview-view .eic-refresh').click();await waitText('Access error');expect(await text()).toContain('Cached ticket');
  expect(await browser.executeObsidian(({app},id,key)=>(app as unknown as {plugins:{plugins:Record<string,P>}}).plugins.plugins[id].cache[key].fetchedAt,pluginId,KEY)).toBe(100);expect(await calls()).toBe(1);
 });
 it('uses a Pro server profile then blocks it after sign-out',async function(){
  await setup();await setPro(true);
  expect(await browser.executeObsidian(async({app},id)=>(app as unknown as {plugins:{plugins:Record<string,P>}}).plugins.plugins[id].saveProfile({name:'Support',host:'https://support.example.test'},'fake-support-token'),pluginId)).toBe(true);
  await openCard('https://support.example.test/team/repo/issues/42');await waitText('Fresh ticket');await setPro(false);await waitText('Blocked');await openCard();await waitText('Fresh ticket');
 });
 it('updates Pro controls after a sponsorship check without reopening settings',async function(){
  await setup();
  await browser.executeObsidian(({app},id)=>{const settings=(app as unknown as {setting:{open():void;openTabById(id:string):void}}).setting;settings.open();settings.openTabById(id);},pluginId);
  const disabled=()=>browser.execute(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.vertical-tab-content button')).find(b=>b.textContent?.trim()==='Add profile')?.disabled??null);
  try {
  await browser.waitUntil(async()=>await disabled()===true,{timeout:10000});
  await setPro(true);await browser.waitUntil(async()=>await disabled()===false,{timeout:10000});
  await setPro(false);await browser.waitUntil(async()=>await disabled()===true,{timeout:10000});
  } finally {await browser.executeObsidian(({app})=>(app as unknown as {setting:{close():void}}).setting.close());}
 });
 it('opens the Pro local project list without reading the server',async function(){
  await setup('https://git.example.test',true);await setPro(true);
  await browser.executeObsidian(({app},id,url)=>{const p=(app as unknown as {plugins:{plugins:Record<string,P>}}).plugins.plugins[id];p.settings.tickets=url;p.openProject();},pluginId,URL);
  await browser.waitUntil(async()=>(await browser.$('.eic-project').getText()).includes('Cached ticket'),{timeout:10000});expect(await calls()).toBe(0);await browser.keys('Escape');await setPro(false);
 });
});
