/** Synthetic, deterministic fixtures. Never a real workshop stock import.
 * The caller must own a disposable database and SET ampoteket.test_seed to
 * 'disposable-only' before applying the rendered transaction.
 */
type AttributeValue = string | boolean;
export type DemoPart = {
	prefix: string; nameNb: string; nameEn: string; category: string; price: string; stock: string | null;
	attributes: Record<string, AttributeValue>; unit?: 'm' | 'g';
	stockStep?: string; saleStep?: string; bin?: number; description?: string;
};
type SeedDataset = { parts: readonly DemoPart[]; description: string };

export const SEED_AUTH_ID = 'de000001-0000-4000-8000-000000000001';
export const SEED_STAFF_ID = 'de000002-0000-4000-8000-000000000001';
export const DEFAULT_SEED_COUNT = 30;

const definitions = [
	['resistance', 'Resistance', 'number', 'ohm'],
	['capacitance', 'Capacitance', 'number', 'F'],
	['voltage', 'Voltage', 'number', 'V'],
	['power', 'Power', 'number', 'W'],
	['tolerance', 'Tolerance', 'number', '%'],
	['package', 'Package', 'text', null],
	['model', 'Model', 'text', null],
	['colour', 'Colour', 'text', null],
	['pitch', 'Pitch', 'number', 'mm'],
	['pins', 'Pins', 'number', null],
	['polarised', 'Polarised', 'boolean', null],
	['interface', 'Interface', 'text', null],
	['step_angle', 'Step angle', 'number', 'deg']
] as const;

const resistor = (value: string): DemoPart => ({ prefix: 'RES',
	nameNb: `${value} ohm motstand`, nameEn: `${value} ohm resistor`,
	category: 'Resistors', price: '0.50', stock: '120',
	attributes: { resistance: value, power: '0.25', tolerance: '5', package: 'Axial' } });
const capacitor = (nameNb: string, nameEn: string, value: string, voltage: string, polarised = false): DemoPart => ({
	prefix: 'CAP', nameNb, nameEn, category: 'Capacitors', price: '1.25', stock: '45',
	attributes: { capacitance: value, voltage, polarised, package: polarised ? 'Radial electrolytic' : 'Radial ceramic' }
});

export const DEMO_PARTS: readonly DemoPart[] = [
	resistor('220'), resistor('330'), resistor('1000'), resistor('10000'),
	{ ...resistor('10'), nameNb: '10 ohm effektmotstand', nameEn: '10 ohm power resistor', price: '4', attributes: { resistance: '10', power: '5', package: 'Axial' } },
	capacitor('5 pF keramisk kondensator', '5 pF ceramic capacitor', '0.000000000005', '300'),
	capacitor('10 nF keramisk kondensator', '10 nF ceramic capacitor', '0.00000001', '16'),
	capacitor('100 nF keramisk kondensator', '100 nF ceramic capacitor', '0.0000001', '50'),
	capacitor('10 uF elektrolyttkondensator', '10 uF electrolytic capacitor', '0.00001', '25', true),
	capacitor('470 uF elektrolyttkondensator', '470 uF electrolytic capacitor', '0.00047', '16', true),
	{ prefix: 'DIO', nameNb: '1N4148 signaldiode', nameEn: '1N4148 signal diode', category: 'Diodes', price: '1', stock: '0', attributes: { model: '1N4148', package: 'DO-35' } },
	{ prefix: 'DIO', nameNb: '1N4007 likeretterdiode', nameEn: '1N4007 rectifier diode', category: 'Diodes', price: '2', stock: '-3', attributes: { model: '1N4007', package: 'DO-41', voltage: '1000' } },
	...([['Red', 'Rød'], ['Green', 'Grønn'], ['Blue', 'Blå']] as const).map(([colour, colourNb]): DemoPart => ({ prefix: 'LED', nameNb: `${colourNb} 5 mm LED`, nameEn: `${colour} 5 mm LED`, category: 'LEDs', price: '1.50', stock: '60', attributes: { colour, package: '5 mm through-hole', polarised: true } })),
	{ prefix: 'BJT', nameNb: 'BC547 NPN-transistor', nameEn: 'BC547 NPN transistor', category: 'Transistors', price: '2', stock: '25', attributes: { model: 'BC547', package: 'TO-92' } },
	{ prefix: 'MOS', nameNb: 'IRLZ44N MOSFET', nameEn: 'IRLZ44N MOSFET', category: 'Transistors', price: '12', stock: '8', attributes: { model: 'IRLZ44N', package: 'TO-220' } },
	{ prefix: 'MCU', nameNb: 'Arduino Nano USB-C', nameEn: 'Arduino Nano USB-C', category: 'Controllers', price: '75', stock: '9', attributes: { model: 'Arduino Nano', voltage: '5', interface: 'USB-C' } },
	{ prefix: 'MCU', nameNb: 'ESP32 utviklingskort', nameEn: 'ESP32 development board', category: 'Controllers', price: '85', stock: '7', attributes: { model: 'ESP32', voltage: '3.3', interface: 'Wi-Fi / Bluetooth' } },
	{ prefix: 'MCU', nameNb: 'Raspberry Pi Pico 2', nameEn: 'Raspberry Pi Pico 2', category: 'Controllers', price: '70', stock: '6', attributes: { model: 'Pico 2', voltage: '3.3', interface: 'USB' } },
	{ prefix: 'SEN', nameNb: 'HC-SR04P ultralydsensor', nameEn: 'HC-SR04P ultrasonic sensor', category: 'Sensors', price: '25', stock: '12', attributes: { model: 'HC-SR04P', voltage: '5', interface: 'Trigger / echo' } },
	{ prefix: 'SEN', nameNb: 'AS5600 magnetisk enkoder', nameEn: 'AS5600 magnetic encoder', category: 'Sensors', price: '35', stock: '4', attributes: { model: 'AS5600', interface: 'I2C' } },
	{ prefix: 'SEN', nameNb: 'MPU6050 akselerometer og gyroskop', nameEn: 'MPU6050 accelerometer and gyroscope', category: 'Sensors', price: '30', stock: '5', attributes: { model: 'MPU6050', interface: 'I2C' } },
	{ prefix: 'MOT', nameNb: 'SG90 mikroservo', nameEn: 'SG90 micro servo', category: 'Motors', price: '35', stock: '6', attributes: { model: 'SG90', voltage: '5', interface: 'PWM' } },
	{ prefix: 'MOT', nameNb: '28BYJ-48 stegmotor', nameEn: '28BYJ-48 stepper motor', category: 'Motors', price: '45', stock: '3', attributes: { model: '28BYJ-48', voltage: '5', step_angle: '5.625' } },
	{ prefix: 'MOT', nameNb: 'R280 DC-motor', nameEn: 'R280 DC motor', category: 'Motors', price: '20', stock: null, attributes: { model: 'R280', voltage: '6' } },
	{ prefix: 'DRV', nameNb: 'TMC2209 stegmotordriver', nameEn: 'TMC2209 stepper driver', category: 'Motor drivers', price: '55', stock: '4', attributes: { model: 'TMC2209', interface: 'Step / direction / UART' } },
	{ prefix: 'CON', nameNb: 'Rett stiftlist, 10 pinner', nameEn: 'Straight male header, 10 pins', category: 'Connectors', price: '0', stock: '50', attributes: { pins: '10', pitch: '2.54', package: 'Through-hole' } },
	{ prefix: 'BRD', nameNb: 'Koblingsbrett med 400 punkter', nameEn: '400 point solderless breadboard', category: 'Prototyping', price: '30', stock: '8', attributes: { pins: '400', pitch: '2.54' } },
	{ prefix: 'CAB', nameNb: 'Fleksibel rød koblingstråd', nameEn: 'Flexible red hookup wire', category: 'Cable', price: '12.345678', stock: '12.345', unit: 'm', attributes: { colour: 'Red', voltage: '30' } }
];

// Mirror only the initial layout's stable identity ordering so sample groups can
// reference real drawers without inserting a second, illustrative shelf map.
const physicalSeedBins = Array.from({ length: 12 }, (_, index) => {
	const cabinet = index + 1, small = [5, 6, 7].includes(cabinet);
	const rows = cabinet === 9 ? 10 : small ? 8 : 12, cols = small ? 3 : 4;
	return Array.from({ length: rows * cols }, (_, cell) => {
		const row = Math.floor(cell / cols) + 1, col = cell % cols + 1;
		if (cabinet === 9 && ((row === 1 && col > 1) || (row === 2 && col === 4))) return null;
		return `a0000002-0000-4000-8000-${((cabinet - 1) * 1000 + (row - 1) * 10 + col).toString(16).padStart(12, '0')}`;
	}).filter((value): value is string => value !== null);
}).flat();
export function seedBinId(index: number): string {
	if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid seed drawer index');
	return physicalSeedBins[index % physicalSeedBins.length];
}
export function seedProductId(index: number): string {
	return id(3, index + 1);
}
export function seedProductCode(index: number, parts: readonly DemoPart[] = DEMO_PARTS): string {
	return `${parts[index % parts.length].prefix}-${(index + 1).toString(16).toUpperCase().padStart(5, '0')}`;
}
function id(namespace: number, index: number): string {
	return `de${namespace.toString().padStart(6, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
function literal(value: string | boolean | null): string {
	return value === null ? 'NULL' : typeof value === 'boolean' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}
function insert(table: string, columns: string, values: (string | boolean | null)[], conflict = 'id'): string {
	return `INSERT INTO app.${table} (${columns}) VALUES (${values.map(literal).join(',')}) ON CONFLICT (${conflict}) DO NOTHING;`;
}

/** count includes the 30 representative products; extra products repeat their
 * technical families with separate stable codes/names for pagination testing.
 * Existing fixture metadata and later stock movements are never overwritten.
 */
export function generateSeedSql(count = DEFAULT_SEED_COUNT, dataset?: SeedDataset): string {
	if (!Number.isSafeInteger(count) || count < DEFAULT_SEED_COUNT || count > 10000) {
		throw new Error('Seed count must be an integer from 30 to 10000.');
	}
	const parts = dataset?.parts ?? DEMO_PARTS;
	const description = dataset?.description ?? 'Synthetic development fixture; specifications and stock are examples, not workshop records.';
	const sql = [
		'-- Synthetic test data only; apply through scripts/seed-test.sh or an owned disposable harness.',
		'BEGIN;',
		`DO $$ BEGIN IF current_setting('ampoteket.test_seed', true) IS DISTINCT FROM 'disposable-only' THEN RAISE EXCEPTION 'TEST_SEED_REQUIRES_DISPOSABLE_DATABASE'; END IF; END $$;`,
		`INSERT INTO auth.users (id) VALUES ('${SEED_AUTH_ID}') ON CONFLICT (id) DO NOTHING;`,
		insert('staff_members', 'id,auth_user_id,display_name', [SEED_STAFF_ID, SEED_AUTH_ID, 'Synthetic seed fixture (no login)']),
		// Gram sales are a local fixture reference unit, not a production schema change.
		...(parts.some(part => part.unit === 'g') ? [insert('units', 'code,name,symbol,is_discrete', ['g', 'Gram', 'g', false], 'code')] : []),
		`SET LOCAL request.jwt.claims = '{"sub":"${SEED_AUTH_ID}","role":"authenticated"}';`,
		'SET LOCAL ROLE authenticated;',
		'CREATE TEMP TABLE seed_added_products (id uuid PRIMARY KEY) ON COMMIT DROP;'
	];
	const categories = [...new Set(parts.map((part) => part.category))];
	for (const [index, name] of categories.entries()) sql.push(insert('categories', 'id,name', [id(4, index + 1), name]));
	for (const [index, [code, label, valueType, unit]] of definitions.entries()) {
		sql.push(insert('attribute_definitions', 'id,code,label,value_type,canonical_unit', [id(5, index + 1), code, label, valueType, unit]));
	}
	for (let index = 0; index < count; index++) {
		const part = parts[index % parts.length];
		const productId = seedProductId(index);
		const synthetic = index >= parts.length ? ` (syntetisk ${index + 1})` : '';
		const syntheticEn = index >= parts.length ? ` (synthetic ${index + 1})` : '';
		const productInsert = insert('products', 'id,code,name_nb,name_en,description,category_id,bin_id,unit_code,stock_step,sale_step,sale_unit_price_nok,is_active',
			[productId, seedProductCode(index, parts), part.nameNb + synthetic, part.nameEn + syntheticEn, part.description ?? description,
				id(4, categories.indexOf(part.category) + 1), seedBinId(part.bin === undefined ? index % 30 : part.bin - 1), part.unit ?? 'pcs',
				part.stockStep ?? (part.unit === 'm' ? '0.001' : '1'), part.saleStep ?? (part.unit === 'm' ? '0.1' : '1'), part.price, true]);
		sql.push(`WITH added AS (${productInsert.slice(0, -1)} RETURNING id) INSERT INTO pg_temp.seed_added_products SELECT id FROM added;`);
		for (const [code, value] of Object.entries(part.attributes)) {
			const attributeIndex = definitions.findIndex((definition) => definition[0] === code);
			if (attributeIndex < 0) throw new Error(`Unknown fixture attribute ${code}`);
			const valueType = definitions[attributeIndex][2];
			// Only initialise new products: a deliberate later attribute removal stays removed.
			sql.push(`INSERT INTO app.product_attributes (product_id,attribute_id,${valueType}_value)
SELECT ${[productId, id(5, attributeIndex + 1), value].map(literal).join(',')}
WHERE EXISTS (SELECT FROM pg_temp.seed_added_products WHERE id='${productId}') ON CONFLICT (product_id,attribute_id) DO NOTHING;`);
		}
		if (part.stock === '0') {
			sql.push(`SELECT public.amp_record_single_count('${id(8, index + 1)}','${productId}',0,0,'Synthetic opening count: empty drawer');`);
		} else if (part.stock !== null) {
			const items = JSON.stringify([{ product_id: productId, quantity_delta: part.stock }]);
			sql.push(`SELECT public.amp_adjust_stock('${id(8, index + 1)}',${literal(items)}::jsonb,'Synthetic opening balance for disposable tests');`);
		}
	}
	sql.push('COMMIT;', '');
	return sql.join('\n');
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== '--count' || !/^\d+$/.test(args[1]))) {
		throw new Error('Usage: bun scripts/seed-test-data.ts [--count 30..10000] > seed.sql');
	}
	process.stdout.write(generateSeedSql(args.length ? Number(args[1]) : DEFAULT_SEED_COUNT));
}
