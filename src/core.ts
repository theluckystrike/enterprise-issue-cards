// Pure logic for Enterprise Issue Cards. No Obsidian imports here, so vitest runs this file directly.
// The card renderer writes plain text only (no innerHTML), so issue text stays inert.

export interface IssueUrlPart {
	host: string;
	owner: string;
	repo: string;
	num: number;
}

export type ParseResult = { ok: true; part: IssueUrlPart } | { ok: false; error: string };

export interface Settings {
	host: string;
	tokenRef: string;
}

export const DEFAULT_SETTINGS: Settings = { host: '', tokenRef: 'eic-api-token' };

/** Lowercases the host and strips a trailing slash. Empty when the value is not a usable host. */
export function normalizeHost(raw: string): string {
	const v = raw.trim().toLowerCase().replace(/\/+$/, '');
	try {
		const u = new URL(v);
		return /^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/.test(v) && u.hostname && !u.username && !u.password ? u.origin : '';
	} catch {
		return '';
	}
}

/** The card only accepts one HTTPS host with no base path. HTTP or a path is a clear error before any request. */
export function validateHost(raw: string): string | null {
	const v = raw.trim();
	if (!v) return 'Set the HTTPS host of your GitHub Enterprise Server, for example https://git.example.test';
	if (/^http:\/\//i.test(v)) return 'Only an HTTPS host works here. Use https://git.example.test, not http.';
	const u = v.toLowerCase().replace(/\/+$/, '');
	if (!normalizeHost(u)) {
		return 'Use the root of the server, for example https://git.example.test. A base path is not supported.';
	}
	return null;
}

/** Reads owner, repository and number from an issue URL. A URL on another host is a hard error before any request. */
export function parseIssueUrl(url: string, allowedHost: string): ParseResult {
	const allowed = normalizeHost(allowedHost);
	if (!allowed) return { ok: false, error: 'Set the server host in the plugin settings first.' };
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		return { ok: false, error: 'The ticket block does not hold a valid URL.' };
	}
	if (u.protocol !== 'https:') return { ok: false, error: `Blocked: the ticket URL must use HTTPS. This URL points outside ${allowed}, so no token was sent.` };
	const host = u.host.toLowerCase().replace(/\/+$/, '');
	if (host !== allowed.replace(/^https:\/\//, '')) {
		return { ok: false, error: `Blocked: this URL points to ${host}, but the plugin is set to ${allowed}. No token was sent.` };
	}
	const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/.exec(u.pathname);
	if (u.username || u.password) return { ok: false, error: 'The issue URL must not contain credentials.' };
	if (!m) return { ok: false, error: 'The URL is not an issue URL. Use https://HOST/OWNER/REPO/issues/NUMBER.' };
	const num = Number(m[3]);
	if (!Number.isSafeInteger(num) || num <= 0) return { ok: false, error: 'The issue number is not a positive number.' };
	return { ok: true, part: { host, owner: m[1]!, repo: m[2]!, num } };
}

/** The REST path for one issue on a GitHub Enterprise Server. */
export function buildApiPath(part: IssueUrlPart): string {
	return `/api/v3/repos/${part.owner}/${part.repo}/issues/${part.num}`;
}

/** One cache entry per host, repository and number, so equal numbers never share content. */
export function cacheKey(part: IssueUrlPart): string {
	return `${part.host}/${part.owner}/${part.repo}#${part.num}`;
}

export interface CardFields {
	title: string;
	state: string;
	labels: string[];
	author: string;
	body: string;
}

/** Picks the five fields. A null body becomes an empty-body message. */
export function extractFields(issue: Record<string, unknown>): CardFields {
	const labels = Array.isArray(issue.labels)
		? issue.labels
				.map((l) => {
					if (typeof l === 'string') return l;
					if (typeof l === 'object' && l !== null && 'name' in l) {
						const n = (l as { name: unknown }).name;
						return typeof n === 'string' ? n : '';
					}
					return '';
				})
				.filter((n) => n.length > 0)
		: [];
	const rawBody = typeof issue.body === 'string' ? issue.body : null;
	return {
		title: typeof issue.title === 'string' ? issue.title : '',
		state: typeof issue.state === 'string' ? issue.state : '',
		labels,
		author: typeof (issue.user as Record<string, unknown> | undefined)?.login === 'string' ? String((issue.user as { login: string }).login) : '',
		body: rawBody === null ? '(no body text on this issue)' : rawBody,
	};
}

/** One line of card text. Plain text only; the renderer uses textContent, so scripts and images stay inert. */
export function cardLines(f: CardFields): string[] {
	const out = [`Title: ${f.title}`, `State: ${f.state}`, `Labels: ${f.labels.length > 0 ? f.labels.join(', ') : '(none)'}`, `Author: ${f.author}`];
	out.push(...f.body.split(/\r\n|\r|\n/));
	return out;
}

export interface CacheEntry {
	key: string;
	fields: CardFields;
	fetchedAt: number;
}

/** Dispatcher for the golden vector tests (packages/spec/vectors/enterprise-issue-cards.json). */
export function runCase(op: string, a: unknown, b: unknown): unknown {
	switch (op) {
		case 'parse':
			return parseIssueUrl(String(a), String(b));
		case 'path':
			return buildApiPath(a as IssueUrlPart);
		case 'key':
			return cacheKey(a as IssueUrlPart);
		case 'fields':
			return extractFields(a as Record<string, unknown>);
		case 'lines':
			return cardLines(a as CardFields);
		case 'validate':
			return validateHost(String(a));
		case 'err':
			return onFetchError(Number(a), b === null ? null : (b as CacheEntry));
		default:
			throw new Error(`unknown op ${op}`);
	}
}

/** A rate limit or server error keeps the last good card and never starts a retry loop. */
export function onFetchError(status: number, entry: CacheEntry | null): { keepCache: boolean; message: string } {
	if (status === 401 || status === 403) return { keepCache: true, message: 'Access error: the server rejected the token. Check the token in the plugin settings. The token is not shown here.' };
	if (status === 404) return { keepCache: false, message: 'The server has no issue at this URL. Check the address, or the token may not see private issues.' };
	if (status === 429) return { keepCache: true, message: 'Rate limit: the server asked to slow down. Showing the last cached card. Retry by hand with the Refresh button.' };
	return { keepCache: true, message: `Network or server error (status ${status}). Showing the last cached card. Retry by hand.` };
}
