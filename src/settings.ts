import { Notice, PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { normalizeHost, validateHost } from './core';
import { isPro, PRO_UI } from './pro';
import type EnterpriseIssueCardsPlugin from './main';

export interface ServerProfile { name: string; host: string }
export interface EnterpriseIssueCardsSettings {
	host: string;
	profiles: ServerProfile[];
	tickets: string;
	refreshMinutes: number;
}
export const DEFAULT_SETTINGS: EnterpriseIssueCardsSettings = { host: '', profiles: [], tickets: '', refreshMinutes: 0 };
export function normalizeSettings(s: Partial<EnterpriseIssueCardsSettings> | null): EnterpriseIssueCardsSettings {
	return {
		host: typeof s?.host === 'string' ? s.host.trim() : '',
		profiles: Array.isArray(s?.profiles) ? s.profiles.filter((p) => p && typeof p.name === 'string' && typeof p.host === 'string' && normalizeHost(p.host)).slice(0, 20).map((p) => ({ name: p.name.slice(0, 80), host: normalizeHost(p.host) })) : [],
		tickets: typeof s?.tickets === 'string' ? s.tickets.split('\n').slice(0, 50).join('\n') : '',
		refreshMinutes: typeof s?.refreshMinutes === 'number' && Number.isFinite(s.refreshMinutes) && s.refreshMinutes >= 10 ? Math.min(1440, Math.round(s.refreshMinutes)) : 0,
	};
}
export class EnterpriseIssueCardsSettingTab extends PluginSettingTab {
	plugin: EnterpriseIssueCardsPlugin;
	constructor(app: App, plugin: EnterpriseIssueCardsPlugin) { super(app, plugin); this.plugin = plugin; }
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{ name: 'Server host', desc: 'Root HTTPS host of your Enterprise Server. HTTP and base paths are not supported.', control: { type: 'text', key: 'host', placeholder: 'https://git.example.test', validate: (v) => validateHost(String(v)) ?? undefined } },
			{ name: 'Access token', desc: 'Paste a read token for the current server, then select Save token. Kept only in Obsidian secret storage. An empty value removes it.', render: (setting) => {
				let value = '';
				setting.addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('Read token').onChange((v) => { value = v; }); });
				setting.addButton((b) => b.setButtonText('Save token').onClick(async () => {
					try { await this.plugin.setToken(value); value = ''; this.update(); } catch { new Notice('Token could not be saved. Check the server host and secret storage.'); }
				}));
			} },
			{ name: 'Clear cached tickets', desc: 'Remove the stored issue text from this vault. This does not remove tokens.', render: (setting) => { setting.addButton((b) => b.setButtonText('Clear cache').onClick(() => { void this.plugin.clearCache(); })); } },
			{ name: 'Named server profiles (Pro)', desc: 'Keep a name, HTTPS host and separate secret token for another server.', render: (setting) => {
				setting.addButton((b) => b.setButtonText('Add profile').setDisabled(!isPro()).onClick(() => this.plugin.openProfile()));
				for (const p of this.plugin.settings.profiles) setting.addButton((b) => b.setButtonText(`Remove ${p.name}`).setDisabled(!isPro()).onClick(async () => { await this.plugin.removeProfile(p.name); this.update(); }));
			} },
			{ name: 'Saved ticket list (Pro)', desc: 'One issue URL per line, up to 50. Only the configured server and named profiles can be read.', render: (setting) => {
				setting.addTextArea((t) => {
					t.inputEl.addClass('eic-ticket-list');
					t.setValue(this.plugin.settings.tickets).setDisabled(!isPro()).onChange(async (v) => { if (!isPro()) return; this.plugin.settings.tickets = v; await this.plugin.saveSettings(); });
				});
			} },
			{ name: 'Scheduled refresh (Pro)', desc: 'Minutes between saved-list refreshes while Obsidian is open. Use 0 to turn off, or 10 to 1440.', render: (setting) => {
				setting.addText((t) => t.setValue(String(this.plugin.settings.refreshMinutes)).setDisabled(!isPro()).onChange(async (v) => { if (!isPro()) return; this.plugin.settings.refreshMinutes = Number(v); await this.plugin.saveSettings(); }));
				setting.addButton((b) => b.setButtonText('Refresh saved list').setDisabled(!isPro()).onClick(() => { void this.plugin.refreshSaved(); }));
			} },
			{ name: 'Local project list (Pro)', desc: 'Show cached tickets from the saved list without a server request.', render: (setting) => { setting.addButton((b) => b.setButtonText('Open project list').setDisabled(!isPro()).onClick(() => this.plugin.openProject())); } },
		];
	}
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key !== 'host' || typeof value !== 'string') return;
		if (validateHost(value)) return;
		this.plugin.settings.host = normalizeHost(value);
		await this.plugin.saveSettings();
	}
}
