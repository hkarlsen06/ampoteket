import { expect, test } from 'bun:test';
import { parseStatus, PtouchError, rasterJob, tapePins } from './ptouch';

test('raster job matches the chained sequence that printed on the physical PT-P700', () => {
	const ink = new Uint8Array(112 * 2);
	ink[0] = 1; ink[112 + 111] = 1;
	const job = rasterJob({ width: 112, height: 2, ink }, 18);
	expect(job.slice(0, 6).map(bytes => [...bytes])).toEqual([
		[0x1b, 0x69, 0x61, 0x01],
		[0x1b, 0x69, 0x7a, 0x84, 0x00, 18, 0x00, 2, 0, 0, 0, 0x00, 0x00],
		[0x1b, 0x69, 0x4d, 0x40],
		[0x1b, 0x69, 0x4b, 0x00],
		[0x1b, 0x69, 0x64, 0x0e, 0x00],
		[0x4d, 0x02]
	]);
	// 18 mm tape leaves 8 unprinted pins at each side: dot 0 is pin 8, dot 111 is pin 119.
	const first = new Uint8Array(20); first.set([0x47, 17, 0, 15]); first[18] = 0x01;
	const second = new Uint8Array(20); second.set([0x47, 17, 0, 15]); second[5] = 0x80;
	expect([...job[6]]).toEqual([...first]);
	expect([...job[7]]).toEqual([...second]);
	expect([...job[8]]).toEqual([0x1a]);
	expect(job).toHaveLength(9);
});

test('status maps tape width and printer errors', () => {
	const status = (patch: Record<number, number>) => {
		const bytes = new Uint8Array(32); bytes.set([0x80, 0x20]); bytes[10] = 18;
		for (const [index, value] of Object.entries(patch)) bytes[Number(index)] = value;
		return parseStatus(bytes);
	};
	expect(status({})).toEqual({ tapeMm: 18, type: 0, error: null });
	expect(status({ 18: 0x01 })?.type).toBe(0x01);
	expect(status({ 9: 0x10 })?.error).toBe('cover');
	expect(status({ 8: 0x01 })?.error).toBe('tape');
	expect(status({ 9: 0x04, 18: 0x02 })?.error).toBe('failed');
	expect(parseStatus(new Uint8Array(16))).toBeNull();
	expect(tapePins(24)).toBe(128);
	expect(() => tapePins(0)).toThrow(PtouchError);
});
