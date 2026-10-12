import { afterEach, describe, expect, it, vi } from 'vitest';

// requestUrl is a global in the obsidian module. Unit tests mock it, so no test touches a real host.
const requestUrlMock = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async (importOriginal) => {
	const mod = await importOriginal<typeof import('obsidian')>();
	return { ...mod, requestUrl: requestUrlMock };
});

import { cardLines, cacheKey, extractFields, onFetchError, parseIssueUrl, validateHost } from '../src/core';

describe('parseIssueUrl', () => {
	it('accepts a URL on the configured host', () => {
		const r = parseIssueUrl('https://git.example.test/team/repo/issues/42', 'https://git.example.test');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.part).toEqual({ host: 'git.example.test', owner: 'team', repo: 'repo', num: 42 });
	});
	it('rejects a different host before any request', () => {
		const r = parseIssueUrl('https://other.example.test/team/repo/issues/1', 'https://git.example.test');
		expect(r.ok).toBe(false);
	});
	it('rejects a pull request URL', () => {
		expect(parseIssueUrl('https://git.example.test/team/repo/pull/9', 'https://git.example.test').ok).toBe(false);
	});
	it('rejects a bad URL', () => {
		expect(parseIssueUrl('not a url', 'https://git.example.test').ok).toBe(false);
	});
});

describe('validateHost', () => {
	it('rejects http with a clear message', () => {
		expect(validateHost('http://git.example.test')).toContain('HTTPS');
	});
	it('rejects a base path', () => {
		expect(validateHost('https://git.example.test/ghe')).toContain('root');
	});
	it('accepts a plain HTTPS host', () => {
		expect(validateHost('https://git.example.test')).toBeNull();
	});
});

describe('extractFields and cardLines', () => {
	it('shows the five fields and keeps body line breaks', () => {
		const f = extractFields({ title: 'T', state: 'open', labels: [{ name: 'a' }, { name: 'b' }], user: { login: 'amy' }, body: 'one\ntwo' });
		const lines = cardLines(f);
		expect(lines.join('\n')).toContain('Title: T');
		expect(lines.join('\n')).toContain('Labels: a, b');
		expect(lines.join('\n')).toContain('Author: amy');
		expect(lines.join('\n')).toContain('one\ntwo');
	});
	it('shows an empty body message when the body is null', () => {
		const f = extractFields({ title: 'T', state: 'open', labels: [], user: { login: 'amy' }, body: null });
		expect(f.body).toContain('no body text');
	});
});

describe('cacheKey', () => {
	it('separates hosts, repositories, and issue numbers', () => {
		expect(cacheKey({ host: 'https://a.test', owner: 'o', repo: 'r', num: 1 })).not.toBe(cacheKey({ host: 'https://b.test', owner: 'o', repo: 'r', num: 1 }));
		expect(cacheKey({ host: 'https://a.test', owner: 'o', repo: 'r', num: 1 })).not.toBe(cacheKey({ host: 'https://a.test', owner: 'o', repo: 'other', num: 1 }));
	});
});

describe('onFetchError', () => {
	it('reports an access error without the token', () => {
		const r = onFetchError(401, null);
		expect(r.keepCache).toBe(true);
		expect(r.message).not.toContain('token123');
	});
	it('keeps the cache on a rate limit', () => {
		expect(onFetchError(429, { key: 'k', fields: extractFields({ title: 'T', state: 'open', labels: [], user: { login: 'a' }, body: '' }), fetchedAt: 5 }).keepCache).toBe(true);
	});
});

describe('requestUrl mock wiring', () => {
	afterEach(() => requestUrlMock.mockReset());

	it('is mocked, so no unit test reaches a real host', async () => {
		requestUrlMock.mockResolvedValue({ status: 200, json: { title: 'x', state: 'open', labels: [], user: { login: 'a' }, body: '' } });
		const mod = await import('obsidian');
		const res = await (mod as unknown as { requestUrl: typeof requestUrlMock }).requestUrl({ url: 'https://git.example.test/api/v3/repos/o/r/issues/1' });
		expect(res.status).toBe(200);
		expect(requestUrlMock).toHaveBeenCalledOnce();
	});
});

describe('extractFields empty body', () => {
	it('shows the empty-body message for an empty or blank body, not only for null', () => {
		for (const body of ['', '  \n ']) expect(extractFields({ title: 'T', state: 'open', labels: [], user: { login: 'a' }, body }).body).toBe('(no body text on this issue)');
	});
});
