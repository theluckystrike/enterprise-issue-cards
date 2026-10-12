import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
const request = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async (original) => ({ ...await original<typeof import('obsidian')>(), requestUrl: request }));
import EnterpriseIssueCardsPlugin, { tokenId } from '../src/main';
import { requestEnterpriseIssue } from '../src/enterprise-request';
import { bindPro, resetPro } from '../src/pro';
import { SponsorsManager } from '../src/license/index';
import { SPONSORS } from '../src/pro';
import manifest from '../manifest.json';
const url = 'https://git.example.test/team/repo/issues/42';
const key = 'git.example.test/team/repo#42';
const fields = { title: 'Fix login', state: 'open', labels: ['bug'], author: 'ada', body: 'one\ntwo' };
async function plugin() {
	const app = App.createConfigured__({ files: {} });
	const secrets = new Map<string, string>();
	Object.defineProperty(app, 'secretStorage', { value: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } }, configurable: true });
	const p = new EnterpriseIssueCardsPlugin(app as never, manifest as never);
	p.settings.host = 'https://git.example.test';
	p.saveData = vi.fn(async () => undefined);
	p.loadData = vi.fn(async () => null);
	await p.setToken('private-token');
	return { p, secrets };
}
function pro(on: boolean) {
	const manager = new SponsorsManager({ config: SPONSORS, http: async () => ({ status: 200, json: null }), tokens: { get: () => null, set: () => undefined, clear: () => undefined }, store: { load: () => null, save: () => undefined } });
	vi.spyOn(manager, 'isPro').mockReturnValue(on);
	bindPro(manager);
}
afterEach(() => { request.mockReset(); resetPro(); vi.useRealTimers(); });
describe('Enterprise transport', () => {
	it('sends a GET to the selected Enterprise endpoint with its token', async () => {
		request.mockResolvedValue({ status: 200 });
		await requestEnterpriseIssue('https://git.example.test/', url, 'private-token');
		expect(request).toHaveBeenCalledWith({ url: 'https://git.example.test/api/v3/repos/team/repo/issues/42', method: 'GET', headers: { Authorization: 'Bearer private-token', Accept: 'application/vnd.github+json' }, throw: false });
	});
	it.each(['https://evil.example.test/team/repo/issues/42', 'http://git.example.test/team/repo/issues/42', 'https://user:pass@git.example.test/team/repo/issues/42', 'https://git.example.test/team/repo%2Fescape/issues/42'])('blocks unsafe target %s before a request', (target) => {
		expect(() => requestEnterpriseIssue('https://git.example.test', target, 'private-token')).toThrow();
		expect(request).not.toHaveBeenCalled();
	});
	it('rejects absent tokens, header injection and invalid port', () => {
		for (const token of ['', 'a\r\nb']) expect(() => requestEnterpriseIssue('https://git.example.test', url, token)).toThrow();
		expect(() => requestEnterpriseIssue('https://git.example.test:99999', url, 'a')).toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});
describe('secret, request and cache behavior', () => {
	it('uses bounded SecretStorage IDs for long hosts and separates servers', async () => {
		const long = 'https://' + 'a'.repeat(63) + '.internal.example.test:8443';
		const id = await tokenId(long);
		expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
		expect(id).not.toBe(await tokenId('https://other.example.test'));
		expect(await tokenId('https://GIT.Example.Test/')).toBe(await tokenId('https://git.example.test'));
	});
	it('stores host tokens only in SecretStorage and saves explicit nonsecret fields', async () => {
		const { p, secrets } = await plugin();
		await p.saveSettings();
		expect(secrets.get(await tokenId(p.settings.host))).toBe('private-token');
		expect(JSON.stringify(vi.mocked(p.saveData).mock.calls)).not.toContain('private-token');
		expect(vi.mocked(p.saveData).mock.calls[0][0]).not.toHaveProperty('token');
		await p.setToken(''); expect(await p.getToken()).toBe('');
	});
	it('does not fall back to data.json if SecretStorage fails', async () => {
		const { p } = await plugin();
		p.app.secretStorage.setSecret = () => { throw new Error('unavailable'); };
		await expect(p.setToken('new-secret')).rejects.toThrow();
		expect(p.saveData).not.toHaveBeenCalled();
	});
	it('rechecks the authorized host after an asynchronous secret read', async () => {
		const { p } = await plugin();
		let release!: (token: string) => void;
		vi.spyOn(p, 'getToken').mockReturnValue(new Promise((resolve) => { release = resolve; }));
		p.issueRequest = vi.fn();
		const task = p.fetchIssue(url);
		p.settings.host = 'https://other.example.test';
		release('private-token');
		expect(await task).toContain('no longer authorized');
		expect(p.issueRequest).not.toHaveBeenCalled();
	});

	it('coalesces two reads of one issue and saves the five fields', async () => {
		const { p } = await plugin();
		let done!: (x: never) => void;
		const reply = new Promise<never>((r) => { done = r; });
		p.issueRequest = vi.fn(() => reply);
		const a = p.fetchIssue(url); const b = p.fetchIssue(url);
		await vi.waitFor(() => expect(p.issueRequest).toHaveBeenCalledOnce());
		done({ status: 200, headers: {}, json: { title: fields.title, state: fields.state, labels: fields.labels, user: { login: fields.author }, body: fields.body } } as never);
		expect(await a).toBe(''); expect(await b).toBe(''); expect(p.cache[key].fields).toEqual(fields);
	});
	it.each([401, 403, 429, 503])('keeps the cached fetch time and returns a safe error on %i', async (status) => {
		const { p } = await plugin(); p.cache[key] = { key, fields, fetchedAt: 100 };
		p.issueRequest = vi.fn(async () => ({ status, headers: {}, json: {} }) as never);
		const message = await p.fetchIssue(url, true);
		expect(message).not.toContain('private-token'); expect(message).not.toBe(''); expect(p.cache[key].fetchedAt).toBe(100);
		expect(p.issueRequest).toHaveBeenCalledOnce();
	});
	it('maps a rate-limit 403 and pauses automatic requests without a retry loop', async () => {
		const { p } = await plugin();
		p.issueRequest = vi.fn(async () => ({ status: 403, headers: { 'X-RateLimit-Remaining': '0' }, json: {} }) as never);
		expect(await p.fetchIssue(url)).toContain('Rate limit');
		expect(await p.fetchIssue(url)).toContain('paused'); expect(p.issueRequest).toHaveBeenCalledOnce();
		await p.fetchIssue(url, true); expect(p.issueRequest).toHaveBeenCalledTimes(2);
	});
	it('keeps the cached entry when the network fails and permits a manual retry', async () => {
		const { p } = await plugin(); p.cache[key] = { key, fields, fetchedAt: 100 };
		p.issueRequest = vi.fn(async () => { throw new Error('private-token'); });
		expect(await p.fetchIssue(url, true)).toContain('last cached'); expect(p.cache[key].fetchedAt).toBe(100);
		await p.fetchIssue(url, true); expect(p.issueRequest).toHaveBeenCalledTimes(2);
	});
	it('does not send a token when a URL does not match an authorized profile', async () => {
		const { p } = await plugin(); p.issueRequest = vi.fn();
		expect(await p.fetchIssue('https://elsewhere.test/o/r/issues/1')).toContain('Blocked'); expect(p.issueRequest).not.toHaveBeenCalled();
	});
});
describe('Pro guards', () => {
	it('refreshes the settings controls when the sponsorship state changes', async () => {
		const { p } = await plugin();
		const update = vi.fn();
		p.addSettingTab = vi.fn((tab) => { tab.update = update; });
		await p.onload();
		update.mockClear();
		p.pro!.signOut();
		expect(update).toHaveBeenCalledOnce();
	});
	it('blocks saved-list refresh, schedule and profile save without a sponsorship', async () => {
		pro(false); const { p } = await plugin(); p.issueRequest = vi.fn(); p.settings.tickets = url; p.settings.refreshMinutes = 10;
		await p.refreshSaved(); await p.scheduledTick(Date.now() + 700_000);
		expect(await p.saveProfile({ name: 'Other', host: 'https://elsewhere.test' }, 'a')).toBe(false);
		expect(p.issueRequest).not.toHaveBeenCalled();
	});
	it('saves named profiles with a separate secret and rejects them after Pro turns off', async () => {
		pro(true); const { p, secrets } = await plugin();
		expect(await p.saveProfile({ name: 'Other', host: 'https://elsewhere.test' }, 'other-secret')).toBe(true);
		expect(secrets.get(await tokenId('https://elsewhere.test'))).toBe('other-secret');
		expect(p.resolve('https://elsewhere.test/o/r/issues/1').ok).toBe(true);
		pro(false); expect(p.resolve('https://elsewhere.test/o/r/issues/1').ok).toBe(false);
		expect(p.resolve(url).ok).toBe(true);
	});
	it('runs the saved list at the configured schedule and deduplicates URLs', async () => {
		vi.useFakeTimers(); pro(true); const { p } = await plugin(); vi.spyOn(p, 'getToken').mockResolvedValue('private-token'); p.settings.tickets = `${url}\n${url}`; p.settings.refreshMinutes = 10;
		p.issueRequest = vi.fn(async () => ({ status: 200, headers: {}, json: { title: 'scheduled' } }) as never);
		await p.scheduledTick(Date.now() + 599_000); expect(p.issueRequest).not.toHaveBeenCalled();
		const task = p.scheduledTick(Date.now() + 600_001); await vi.runAllTimersAsync(); await task;
		expect(p.issueRequest).toHaveBeenCalledOnce(); expect(p.cache[key].fields.title).toBe('scheduled');
	});
});
