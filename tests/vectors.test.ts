import { describe, expect, it } from 'vitest';
import vectors from './vectors/enterprise-issue-cards.json';
import { runGoldenCase } from './golden-runner';

interface Case {
	name: string;
	args: [string, unknown, unknown];
	expected: unknown;
}

describe('golden vectors (packages/spec/vectors/enterprise-issue-cards.json)', () => {
	const cases = vectors.cases as Case[];
	it('has at least 20 cases', () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});
	for (const c of cases) {
		it(c.name, async () => {
			expect(await runGoldenCase(...c.args)).toEqual(c.expected);
		});
	}
});
