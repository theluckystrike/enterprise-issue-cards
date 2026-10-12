// Audited user-host transport. tools/network-gate.mjs checks this source and its call shape.
import { requestUrl } from 'obsidian';
import { buildApiPath, normalizeHost, parseIssueUrl } from './core';

export function requestEnterpriseIssue(host: string, issueUrl: string, token: string) {
	const origin = normalizeHost(host);
	const parsed = parseIssueUrl(issueUrl, origin);
	if (!origin || !parsed.ok || !token || /[\r\n]/.test(token)) throw new Error('Blocked Enterprise issue request. Check the host, issue URL and token.');
	const checked = {
		enterpriseIssueUrl: origin + buildApiPath(parsed.part),
		enterpriseIssueHeaders: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
	};
	return requestUrl({ url: checked.enterpriseIssueUrl, method: 'GET', headers: checked.enterpriseIssueHeaders, throw: false });
}
