import { expect, test } from 'bun:test';
import { osloInstant, osloLocal, possibleOsloOffsets } from './oslo-time';

test('Oslo wall time rejects the DST gap and distinguishes both fall occurrences', () => {
	expect(possibleOsloOffsets('2026-03-29T02:30')).toEqual([]);
	expect(() => osloInstant('2026-03-29T02:30')).toThrow('INVALID_OSLO_TIME');
	expect(possibleOsloOffsets('2026-10-25T02:30')).toEqual(['+01:00', '+02:00']);
	expect(() => osloInstant('2026-10-25T02:30')).toThrow('AMBIGUOUS_OSLO_TIME');
	expect(osloInstant('2026-10-25T02:30', '+02:00')).toBe('2026-10-25T00:30:00.000Z');
	expect(osloInstant('2026-10-25T02:30', '+01:00')).toBe('2026-10-25T01:30:00.000Z');
	expect(osloLocal(new Date('2026-09-22T12:30:00Z'))).toBe('2026-09-22T14:30');
});
