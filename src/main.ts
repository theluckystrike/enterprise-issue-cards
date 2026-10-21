import { MarkdownRenderChild, Modal, Notice, Plugin, Setting, type RequestUrlResponse } from 'obsidian';
import { cardLines, cacheKey, extractFields, normalizeHost, onFetchError, parseIssueUrl, type CacheEntry, type IssueUrlPart } from './core';
import { DEFAULT_SETTINGS, EnterpriseIssueCardsSettingTab, normalizeSettings, type EnterpriseIssueCardsSettings, type ServerProfile } from './settings';
import { SPONSORS, PRO_UI, bindPro, isPro, onProChange, resetPro } from './pro';
import { createGitHubSponsors } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { requestEnterpriseIssue } from './enterprise-request';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

export async function tokenId(host: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeHost(host)));
	// SecretStorage permits at most 64 characters. A 192-bit host digest keeps the ID bounded.
	return 'eic-server-' + Array.from(new Uint8Array(bytes).slice(0, 24)).map((n) => n.toString(16).padStart(2, '0')).join('');
}
export default class EnterpriseIssueCardsPlugin extends Plugin {
	settings: EnterpriseIssueCardsSettings = { ...DEFAULT_SETTINGS, profiles: [] };
	cache: Record<string, CacheEntry> = {};
	pro: SponsorsManager | null = null;
	// Tests and screenshot QA replace this transport with a local reply. Production uses the audited transport.
	issueRequest: (host: string, url: string, token: string) => PromiseLike<RequestUrlResponse> = requestEnterpriseIssue;
	/** The last read error for each cache key, so each open card of that issue shows it. */
	readonly lastError = new Map<string, string>();
	private pending = new Map<string, Promise<string>>();
	private pausedUntil = new Map<string, number>();
	private cards = new Set<TicketRenderChild>();
	private saving: Promise<void> = Promise.resolve();
	private lastScheduled = Date.now();
	private refreshing = false;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		const data = await this.loadData() as Record<string, unknown> | null;
		this.settings = normalizeSettings(data);
		if (data?.cache && typeof data.cache === 'object') {
			for (const [key, value] of Object.entries(data.cache)) {
				const e = value as Partial<CacheEntry> | null;
				if (e?.key === key && e.fields && typeof e.fetchedAt === 'number') {
					const f = e.fields;
					if (typeof f.title === 'string' && typeof f.state === 'string' && typeof f.author === 'string' && typeof f.body === 'string' && Array.isArray(f.labels) && f.labels.every((l) => typeof l === 'string')) this.cache[key] = e as CacheEntry;
				}
			}
		}
		// Remove the token copy made by the earlier unfinished build. Do not read or reuse it.
		if (data && 'token' in data) await this.saveSettings();
		this.pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		this.pro.init();
		bindPro(this.pro);
		const settingTab = new EnterpriseIssueCardsSettingTab(this.app, this);
		this.addSettingTab(settingTab);
		this.register(onProChange(() => { this.redraw(); settingTab.update(); }));
		this.addCommand({ id: 'open-project-list', name: 'Open local project list (pro)', callback: () => this.openProject() });
		this.registerMarkdownCodeBlockProcessor('ticket', (source, el, ctx) => {
			const child = new TicketRenderChild(el, this, source);
			ctx.addChild(child);
			this.cards.add(child);
			child.register(() => this.cards.delete(child));
			void child.draw();
		});
		this.app.workspace.onLayoutReady(() => {
			void this.pro?.refresh();
			this.registerInterval(window.setInterval(() => {
				void this.pro?.refresh();
				void this.scheduledTick();
			}, 60_000));
		});
	}
	onunload(): void { resetPro(); this.cards.clear(); }
	async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData() as Partial<EnterpriseIssueCardsSettings> | null); }
	async getToken(host = this.settings.host): Promise<string> { return this.app.secretStorage.getSecret(await tokenId(host)) ?? ''; }
	async setToken(value: string, host = this.settings.host): Promise<void> {
		if (!normalizeHost(host) || /[\r\n]/.test(value)) throw new Error('Invalid host or token.');
		this.app.secretStorage.setSecret(await tokenId(host), value.trim());
		new Notice(value.trim() ? 'Token saved in secret storage.' : 'Token removed.');
	}
	saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		this.saving = this.saving.catch(() => undefined).then(() => this.saveData({ ...this.settings, cache: this.cache }));
		return this.saving;
	}
	async clearCache(): Promise<void> { this.cache = {}; this.lastError.clear(); await this.saveSettings(); this.redraw(false); }
	resolve(url: string): ReturnType<typeof parseIssueUrl> {
		let host = this.settings.host;
		try {
			const origin = new URL(url).origin;
			if (isPro() && normalizeHost(host) !== origin) host = this.settings.profiles.find((p) => p.host === origin)?.host ?? host;
		} catch { /* The parser gives the error. */ }
		return parseIssueUrl(url, host);
	}
	private redraw(fetchMissing = false): void { for (const card of this.cards) void card.draw(fetchMissing); }
	/** Redraws only the cards of one issue. A card of another issue can be in a read, and a redraw would drop its result. */
	private redrawKey(key: string): void { for (const card of this.cards) if (card.key === key) void card.draw(false); }
	async fetchIssue(url: string, manual = false): Promise<string> {
		const parsed = this.resolve(url);
		if (!parsed.ok) return parsed.error;
		const part = parsed.part;
		const key = cacheKey(part);
		const pending = this.pending.get(key);
		if (pending) return pending;
		const task = this.fetchOne(url, part, manual);
		this.pending.set(key, task);
		try { return await task; } finally { this.pending.delete(key); }
	}
	private async fetchOne(url: string, part: IssueUrlPart, manual: boolean): Promise<string> {
		const key = cacheKey(part);
		const origin = `https://${part.host}`;
		if (!manual && (this.pausedUntil.get(part.host) ?? 0) > Date.now()) return 'Rate limit: scheduled reads are paused. Use Refresh for a manual retry.';
		let token: string;
		try { token = await this.getToken(origin); } catch { return 'Secret storage could not be read. Open the plugin settings.'; }
		const authorized = this.resolve(url);
		if (!authorized.ok || cacheKey(authorized.part) !== key) return 'Blocked: this server is no longer authorized. No token was sent.';
		if (!token) return 'No access token for this server. Save a read token in the plugin settings.';
		try {
			const res = await this.issueRequest(origin, url, token);
			if (res.status >= 200 && res.status < 300) {
				const json = res.json as unknown;
				if (!json || typeof json !== 'object' || typeof (json as Record<string, unknown>).title !== 'string') return 'The server returned an unsupported issue response.';
				this.cache[key] = { key, fields: extractFields(json as Record<string, unknown>), fetchedAt: Date.now() };
				this.lastError.delete(key);
				await this.saveSettings();
				this.redrawKey(key);
				return '';
			}
			const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
			const rateLimited = res.status === 429 || (res.status === 403 && (headers['x-ratelimit-remaining'] === '0' || !!headers['retry-after']));
			if (rateLimited) this.pausedUntil.set(part.host, Date.now() + Math.max(60 * 60 * 1000, (Number(headers['retry-after']) || 0) * 1000));
			const error = onFetchError(rateLimited ? 429 : res.status, this.cache[key] ?? null);
			this.lastError.set(key, error.message);
			if (!error.keepCache) { delete this.cache[key]; await this.saveSettings(); }
			this.redrawKey(key);
			return error.message;
		} catch {
			const message = 'Network or storage error. The last cached card is kept. Retry by hand with Refresh.';
			this.lastError.set(key, message);
			this.redrawKey(key);
			return message;
		}
	}
	async scheduledTick(now = Date.now()): Promise<void> {
		const ms = this.settings.refreshMinutes * 60_000;
		if (!isPro() || !ms || now - this.lastScheduled < ms) return;
		this.lastScheduled = now;
		await this.refreshSaved();
	}
	async refreshSaved(): Promise<void> {
		if (!isPro() || this.refreshing) return;
		this.refreshing = true;
		try {
			for (const url of this.savedUrls()) {
				if (!isPro()) break;
				await this.fetchIssue(url);
				await new Promise<void>((done) => window.setTimeout(done, 1000));
			}
			this.redraw(false);
		} finally { this.refreshing = false; }
	}
	savedUrls(): string[] { return [...new Set(this.settings.tickets.split('\n').map((s) => s.trim()).filter(Boolean))].slice(0, 50); }
	async saveProfile(profile: ServerProfile, token: string): Promise<boolean> {
		if (!isPro() || !profile.name.trim() || !normalizeHost(profile.host)) return false;
		const host = normalizeHost(profile.host);
		// The settings keep 80 characters of a name. Compare that form, so a long name replaces its profile.
		const name = profile.name.trim().slice(0, 80);
		// An empty token field keeps the stored token of this host. That host can be the primary server.
		if (token.trim()) await this.setToken(token, host);
		this.settings.profiles = [...this.settings.profiles.filter((p) => p.name !== name), { name, host }];
		await this.saveSettings(); this.redraw(false); return true;
	}
	async removeProfile(name: string): Promise<void> {
		if (!isPro()) return;
		this.settings.profiles = this.settings.profiles.filter((p) => p.name !== name);
		await this.saveSettings(); this.redraw(false);
	}
	openProfile(): Modal | undefined { if (!this.requirePro()) return; const modal = new ProfileModal(this); modal.open(); return modal; }
	openProject(): Modal | undefined { if (!this.requirePro()) return; const modal = new ProjectModal(this); modal.open(); return modal; }
	private requirePro(): boolean { if (isPro()) return true; new Notice('This is a pro feature. Sponsor on GitHub, then sign in from the plugin settings.'); return false; }
}

class TicketRenderChild extends MarkdownRenderChild {
	private revision = 0;
	key = '';
	constructor(el: HTMLElement, private plugin: EnterpriseIssueCardsPlugin, private source: string) { super(el); }
	async draw(fetchMissing = true): Promise<void> {
		const revision = ++this.revision;
		const url = (this.source.split('\n').map((s) => s.trim()).find(Boolean) ?? '').replace(/^url:\s*/i, '');
		const parsed = this.plugin.resolve(url);
		if (!parsed.ok) { this.key = ''; this.paint([!this.plugin.settings.host ? 'No server host is set. Open the plugin settings.' : parsed.error]); return; }
		const key = cacheKey(parsed.part);
		this.key = key;
		let message = '';
		if (!this.plugin.cache[key] && fetchMissing) { this.paint(['Fetching…']); message = await this.plugin.fetchIssue(url); }
		if (revision !== this.revision) return;
		this.show(key, url, message);
	}
	private show(key: string, url: string, message: string): void {
		const entry = this.plugin.cache[key];
		message ||= this.plugin.lastError.get(key) ?? '';
		const lines = entry ? [`Cached at ${new Date(entry.fetchedAt).toLocaleString()}`, ...cardLines(entry.fields)] : ['No cached ticket. Select Refresh to read it.'];
		if (message) lines.unshift(message);
		const box = this.paint(lines);
		const button = box.createEl('button', { text: 'Refresh', cls: 'eic-refresh' });
		button.addEventListener('click', () => { void (async () => {
			button.disabled = true;
			const rev = ++this.revision;
			const error = await this.plugin.fetchIssue(url, true);
			// Successful reads redraw this card through the shared cache listener.
			if (rev === this.revision) this.show(key, url, error);
		})(); });
	}
	private paint(lines: string[]): HTMLElement {
		this.containerEl.empty();
		const box = this.containerEl.createDiv('eic-card');
		for (const line of lines) box.createDiv('eic-line').textContent = line;
		return box;
	}
}
class ProfileModal extends Modal {
	constructor(private plugin: EnterpriseIssueCardsPlugin) { super(plugin.app); }
	onOpen(): void {
		this.setTitle(PRO_UI.profileTitle);
		let name = ''; let host = ''; let token = '';
		new Setting(this.contentEl).setName('Name').addText((t) => t.onChange((v) => { name = v; }));
		new Setting(this.contentEl).setName('HTTPS host').addText((t) => t.setPlaceholder('https://git.example.test').onChange((v) => { host = v; }));
		new Setting(this.contentEl).setName('Access token').addText((t) => { t.inputEl.type = 'password'; t.onChange((v) => { token = v; }); });
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Save profile').setCta().onClick(async () => {
			try { if (await this.plugin.saveProfile({ name, host }, token)) this.close(); else new Notice('Pro, a name and a valid HTTPS host are required.'); } catch { new Notice('Profile could not be saved. Check secret storage.'); }
		}));
	}
	onClose(): void { this.contentEl.empty(); }
}
class ProjectModal extends Modal {
	constructor(private plugin: EnterpriseIssueCardsPlugin) { super(plugin.app); }
	onOpen(): void {
		this.setTitle(PRO_UI.projectTitle);
		this.contentEl.addClass('eic-project');
		const urls = this.plugin.savedUrls();
		if (!urls.length) this.contentEl.createEl('p', { text: 'Add issue addresses to the saved ticket list in the plugin settings.' });
		for (const url of urls) {
			const box = this.contentEl.createDiv('eic-card');
			box.createDiv({ text: url });
			const parsed = this.plugin.resolve(url);
			const entry = parsed.ok ? this.plugin.cache[cacheKey(parsed.part)] : null;
			for (const line of entry ? [`Cached at ${new Date(entry.fetchedAt).toLocaleString()}`, ...cardLines(entry.fields)] : [parsed.ok ? 'No cached ticket. Refresh the saved list to read it.' : parsed.error]) box.createDiv('eic-line').textContent = line;
		}
	}
	onClose(): void { this.contentEl.empty(); }
}
