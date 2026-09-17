import { describe, expect, test } from 'bun:test';
import { productCodeFromEntry, productCodeFromQr } from './payload';
import { nearestQr, ScanGate, type QrDetection } from './selection';

function detection(value: string, x = 0.5, y = 0.5): QrDetection {
	return { value, corners: [{ x: x - 0.05, y: y - 0.05 }, { x: x + 0.05, y: y - 0.05 },
		{ x: x + 0.05, y: y + 0.05 }, { x: x - 0.05, y: y + 0.05 }] };
}

describe('Product label boundary', () => {
	test('accepts current and legacy single path identifiers and existing general code syntax', () => {
		for (const code of ['RES-A3F09', 'AMP-00123', 'A', '123', 'A'.repeat(40)]) {
			expect(productCodeFromQr(`https://ampoteket.no/p/${code}`)).toBe(code);
			expect(productCodeFromQr(`ampoteket.no/p/${code}`)).toBe(code);
		}
	});
	test('rejects foreign URLs, alternative fields and URL normalization tricks', () => {
		for (const value of [
			'RES-A3F09', 'http://ampoteket.no/p/RES-A3F09', '//ampoteket.no/p/RES-A3F09',
			'ampoteket.no.evil.test/p/RES-A3F09', 'Ampoteket.no/p/RES-A3F09', 'ampoteket.no/p/res-a3f09',
			'ampoteket.no/p/../p/RES-A3F09', 'ampoteket.no/p/RES-A3F09?code=OTHER',
			'https://ampoteket.no.evil.test/p/RES-A3F09', 'https://evil.test/p/RES-A3F09',
			'https://ampoteket.no@evil.test/p/RES-A3F09', 'https://a@ampoteket.no/p/RES-A3F09',
			'https://ampoteket.no:444/p/RES-A3F09', 'https://ampoteket.no/p/RES-A3F09?code=OTHER',
			'https://ampoteket.no/p?code=RES-A3F09&code=OTHER', 'https://ampoteket.no/p/RES-A3F09#price=0',
			'https://ampoteket.no/p/RES-A3F09?', 'https://ampoteket.no/p/RES-A3F09#',
			'https://ampoteket.no/p/../p/RES-A3F09', 'https://ampoteket.no/p/%52ES-A3F09',
			'https://ampoteket.no/p/RES-A3F09/EXTRA', 'https://ampoteket.no/p/res-a3f09',
			'https://ampoteket.no/p/RES_A3F09', 'https://ampoteket.no/p/' + 'A'.repeat(41),
			'https://ampoteket.no\\p\\RES-A3F09', ' https://ampoteket.no/p/RES-A3F09',
			'https://ampoteket.no/\np/RES-A3F09', 'javascript:alert(1)', 'data:text/plain,RES-A3F09'
		]) expect(productCodeFromQr(value)).toBeNull();
	});
	test('manual entry permits a normalized code or either label address, never arbitrary URL', () => {
		expect(productCodeFromEntry(' res-a3f09 ')).toBe('RES-A3F09');
		expect(productCodeFromEntry('https://ampoteket.no/p/RES-A3F09')).toBe('RES-A3F09');
		expect(productCodeFromEntry('ampoteket.no/p/RES-A3F09')).toBe('RES-A3F09');
		expect(productCodeFromEntry('https://evil.test/p/RES-A3F09')).toBeNull();
	});
});

describe('Spatial acceptance and repeat suppression', () => {
	test('chooses by position before payload validation and refuses equally aimed labels', () => {
		const edge = detection('valid', 0.2), centre = detection('foreign');
		expect(nearestQr([edge, centre])).toBe(centre);
		expect(nearestQr([centre, edge])).toBe(centre);
		expect(nearestQr([detection('left', 0.3), detection('right', 0.7)])).toBeNull();
		expect(nearestQr([detection('out-of-crop', 1.1), edge])).toBe(edge);
		expect(nearestQr([{ value: 'bad', corners: [{ x: NaN, y: 0 }] }])).toBeNull();
	});
	test('closes acceptance synchronously before any async caller can race', () => {
		const gate = new ScanGate();
		expect(gate.observe([detection('A')], 0).value).toBe('A');
		expect(gate.accepting).toBe(false);
		expect(gate.observe([detection('B')], 1).value).toBeNull();
		gate.resume();
		expect(gate.observe([detection('A')], 2)).toEqual({ value: null, duplicate: true });
	});
	test('requires observed absence after resuming, never elapsed confirmation time', () => {
		const gate = new ScanGate();
		gate.observe([detection('A')], 0);
		gate.observe([], 100000); // paused observations cannot clear suppression
		gate.resume();
		expect(gate.observe([detection('A')], 100001).duplicate).toBe(true);
		gate.observe([], 100100); gate.observe([], 100220);
		expect(gate.observe([detection('A')], 100300).duplicate).toBe(true);
		gate.observe([], 101000); gate.observe([], 101200); gate.observe([], 101601);
		expect(gate.observe([detection('A')], 101700).value).toBe('A');
	});
	test('permits deliberate same-label rearm, but never opens a paused gate', () => {
		const gate = new ScanGate(); gate.observe([detection('A')], 0);
		gate.rearm(); expect(gate.observe([detection('A')], 1).value).toBeNull();
		gate.resume(); expect(gate.observe([detection('A')], 2).value).toBe('A');
	});
	test('does not skip the blocked central label to add a peripheral product', () => {
		const gate = new ScanGate(); gate.observe([detection('A')], 0); gate.resume();
		expect(gate.observe([detection('B', 0.2), detection('A')], 100).value).toBeNull();
		expect(gate.observe([detection('B'), detection('A', 0.2)], 200).value).toBe('B');
	});
});
