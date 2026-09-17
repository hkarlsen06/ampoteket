import { expect, test } from 'bun:test';
import { salesPlot } from './sales-chart';

test('plots exact quantities as bounded coordinates without rounding source values', () => {
	expect(salesPlot(['0', '0.000001', '0.000002'])).toEqual({ points: [0, 500, 1000], maximum: '0.000002' });
	expect(salesPlot(['9007199254740992', '9007199254740993'])).toEqual({ points: [999, 1000], maximum: '9007199254740993' });
	expect(salesPlot(['0.00', '0'])).toEqual({ points: [0, 0], maximum: '0' });
	expect(salesPlot([])).toEqual({ points: [], maximum: '0' });
	expect(() => salesPlot(['-1'])).toThrow('NEGATIVE_SALES');
	expect(() => salesPlot(['1e3'])).toThrow('INVALID_DECIMAL');
});
