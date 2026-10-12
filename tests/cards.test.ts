import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import EnterpriseIssueCardsPlugin from '../src/main';
import { resetPro } from '../src/pro';
import manifest from '../manifest.json';

type Processor = (source: string, el: HTMLElement, ctx: { addChild: (c: unknown) => void }) => void;
const urlA = 'https://git.example.test/team/repo/issues/1';
const urlB = 'https://git.example.test/team/repo/issues/2';

async function setup() {
	const app = App.createConfigured__({ files: {} });
	const secrets = new Map<string, string>();
	Object.defineProperty(app, 'secretStorage', { value: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => { secrets.set(id, v); } }, configurable: true });
	const p = new EnterpriseIssueCardsPlugin(app as never, manifest as never);
	p.saveData = vi.fn(async () => undefined);
	p.loadData = vi.fn(async () => ({ host: 'https://git.example.test' }));
	let processor!: Processor;
	p.registerMarkdownCodeBlockProcessor = vi.fn((_lang: string, fn: Processor) => { processor = fn; }) as never;
	await p.onload();
	await p.setToken('private-token');
	const card = (source: string) => { const el = document.createElement('div'); processor(source, el, { addChild: () => undefined }); return el; };
	return { p, card };
}
afterEach(() => { resetPro(); });

describe('ticket cards on one note', () => {
	it('keeps the access error on a card when another card loads first', async () => {
		const { p, card } = await setup();
		let failA!: () => void;
		p.issueRequest = vi.fn((_h: string, url: string) => url === urlA
			? new Promise((r) => { failA = () => r({ status: 401, headers: {}, json: {} } as never); })
			: Promise.resolve({ status: 200, headers: {}, json: { title: 'B title', state: 'open', labels: [], user: { login: 'ada' }, body: 'b' } } as never));
		const a = card(urlA);
		const b = card(urlB);
		await vi.waitFor(() => expect(b.textContent).toContain('B title'));
		await vi.waitFor(() => expect(failA).toBeTypeOf('function'));
		failA();
		await vi.waitFor(() => expect(a.textContent).toContain('Access error'));
	});

	it('removes a deleted issue from every open card of that issue', async () => {
		const { p, card } = await setup();
		p.cache['git.example.test/team/repo#1'] = { key: 'git.example.test/team/repo#1', fields: { title: 'Old title', state: 'open', labels: [], author: 'ada', body: '' }, fetchedAt: 1 };
		const a = card(urlA);
		const b = card(urlA);
		await vi.waitFor(() => expect(b.textContent).toContain('Old title'));
		p.issueRequest = vi.fn(async () => ({ status: 404, headers: {}, json: {} }) as never);
		a.querySelector('button')!.click();
		await vi.waitFor(() => expect(a.textContent).toContain('no issue at this URL'));
		await vi.waitFor(() => expect(b.textContent).not.toContain('Old title'));
	});

	it('removes the plaintext token of the earlier build on load and does not use it', async () => {
		const app = App.createConfigured__({ files: {} });
		const get = vi.fn(() => null);
		Object.defineProperty(app, 'secretStorage', { value: { getSecret: get, setSecret: vi.fn() }, configurable: true });
		const p = new EnterpriseIssueCardsPlugin(app as never, manifest as never);
		p.saveData = vi.fn(async () => undefined);
		p.loadData = vi.fn(async () => ({ host: 'https://git.example.test', token: 'old-plain-token' }));
		await p.onload();
		expect(p.saveData).toHaveBeenCalledOnce();
		expect(JSON.stringify(vi.mocked(p.saveData).mock.calls)).not.toContain('old-plain-token');
		expect(await p.getToken()).toBe('');
	});
});
