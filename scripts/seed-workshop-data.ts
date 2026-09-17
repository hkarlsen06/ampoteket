import type { DemoPart } from './seed-test-data';

/** Unofficial development examples based on IMG_0685/0686/0687 and IMG_0722.
 * Only the 23 price-list entries below use photographed prices. Other prices,
 * all quantities and placements are illustrative groups in the initial physical
 * layout, not an opening-stock import. Unreadable ratings and module variants are
 * deliberately omitted rather than filled in from a similar component.
 */
const listedPrice = 'Unofficial development data. Price from the photographed price list (IMG_0722.PNG); stock and placement are illustrative.';
const examplePrice = 'Unofficial development data. Component based on the shelf photographs; price, stock and placement are illustrative.';

const drawerGroups = new Map<string, number>();
const parts: DemoPart[] = [];

// Photo coordinates only identify parts sharing a drawer. The 1-based group
// index selects an existing drawer from the initial physical layout.
function drawerGroup(cabinet: number, row: number, col: number): number {
	const key = `${cabinet}/${row}/${col}`;
	if (!drawerGroups.has(key)) drawerGroups.set(key, drawerGroups.size + 1);
	return drawerGroups.get(key)!;
}

function add(part: Omit<DemoPart, 'description' | 'bin'>, cabinet: number, row: number, col: number,
	fromPriceList = false) {
	parts.push({ ...part, description: fromPriceList ? listedPrice : examplePrice,
		bin: drawerGroup(cabinet, row, col) });
}

// The two lower-left cabinets follow the photographed E12 rows and decades.
// Exact decimal strings avoid floating-point conversion of electrical values.
const resistorRows = [
	['0.1', '1', '10', '100', '1000', '10000', '100000', '1000000'],
	['0.12', '1.2', '12', '120', '1200', '12000', '120000', '1200000'],
	['0.15', '1.5', '15', '150', '1500', '15000', '150000', '1500000'],
	['0.18', '1.8', '18', '180', '1800', '18000', '180000', '1800000'],
	['0.22', '2.2', '22', '220', '2200', '22000', '220000', '2200000'],
	['0.27', '2.7', '27', '270', '2700', '27000', '270000', '2700000'],
	['0.33', '3.3', '33', '330', '3300', '33000', '330000', '3300000'],
	['0.39', '3.9', '39', '390', '3900', '39000', '390000', '3900000'],
	['0.47', '4.7', '47', '470', '4700', '47000', '470000', '4700000'],
	['0.56', '5.6', '56', '560', '5600', '56000', '560000', '5600000'],
	['0.68', '6.8', '68', '680', '6800', '68000', '680000', '6800000'],
	['0.82', '8.2', '82', '820', '8200', '82000', '820000', '8200000']
] as const;
const resistorStocks = ['84', '150', '42', '260', '115', '68', '190', '36', '92', '210', '54', '130'];
for (const [row, values] of resistorRows.entries()) {
	for (const [column, value] of values.entries()) {
		add({ prefix: 'RES', nameNb: `${value} ohm motstand`, nameEn: `${value} ohm resistor`,
			category: 'Resistors', price: '0.50', stock: resistorStocks[(row + column * 3) % resistorStocks.length],
			attributes: { resistance: value, package: 'Axial' } }, column < 4 ? 7 : 8, row + 1, column % 4 + 1);
	}
}

function capacitor(value: string, capacitance: string, voltage: string | null, stock: string,
	cabinet: number, row: number, col: number, electrolytic = false) {
	const rating = voltage ? ` ${voltage} V` : '';
	add({ prefix: 'CAP', nameNb: `${value}${rating} ${electrolytic ? 'elektrolyttkondensator' : 'kondensator'}`,
		nameEn: `${value}${rating} ${electrolytic ? 'electrolytic capacitor' : 'capacitor'}`, category: 'Capacitors',
		price: electrolytic ? '3' : '1', stock,
		attributes: { capacitance, ...(voltage ? { voltage } : {}), ...(electrolytic ? { polarised: true } : {}) }
	}, cabinet, row, col);
}
capacitor('5 pF', '0.000000000005', '300', '42', 2, 2, 3);
capacitor('10 nF', '0.00000001', '16', '85', 2, 7, 1);
capacitor('22 nF', '0.000000022', '16', '64', 2, 7, 3);
capacitor('22 nF', '0.000000022', '30', '29', 2, 7, 3);
capacitor('47 nF', '0.000000047', '16', '110', 2, 7, 4);
capacitor('68 nF', '0.000000068', '16', '35', 2, 9, 2);
capacitor('68 nF', '0.000000068', '80', '18', 2, 9, 1);
capacitor('100 nF', '0.0000001', '30', '78', 2, 9, 3);
capacitor('0.1 uF', '0.0000001', null, '96', 2, 10, 1);
capacitor('1.5 uF', '0.0000015', null, '16', 2, 11, 1);
capacitor('4.7 uF', '0.0000047', null, '24', 2, 9, 4);
capacitor('100 uF', '0.0001', '16', '48', 1, 6, 2, true);
capacitor('470 uF', '0.00047', '16', '32', 1, 6, 2, true);
capacitor('68 uF', '0.000068', null, '21', 1, 6, 3);

// Complete transcription of the 23 rows in IMG_0722.PNG. The unusually low
// Arduino prices and the two 46 NOK perfboards are intentional: that is what
// the supplied list says. Filament uses grams, not spool prices.
add({ prefix: 'MIS', nameNb: 'PLA-filament', nameEn: 'PLA filament', category: 'Miscellaneous', price: '0.25', stock: '2450.5', unit: 'g', stockStep: '0.1', saleStep: '0.1', attributes: { model: 'PLA' } }, 12, 7, 1, true);
add({ prefix: 'MIS', nameNb: 'PETG-filament', nameEn: 'PETG filament', category: 'Miscellaneous', price: '0.30', stock: '1375.2', unit: 'g', stockStep: '0.1', saleStep: '0.1', attributes: { model: 'PETG' } }, 12, 8, 1, true);
add({ prefix: 'MCU', nameNb: 'Raspberry Pi Pico 2', nameEn: 'Raspberry Pi Pico 2', category: 'Controllers', price: '94', stock: '7', attributes: { model: 'Pico 2' } }, 11, 1, 2, true);
add({ prefix: 'MCU', nameNb: 'Seeed Studio XIAO ESP32C3', nameEn: 'Seeed Studio XIAO ESP32C3', category: 'Controllers', price: '78', stock: '5', attributes: { model: 'XIAO ESP32C3' } }, 11, 1, 1, true);
add({ prefix: 'BRD', nameNb: 'MB102 strømforsyning til koblingsbrett, 3.3 V / 5 V', nameEn: 'MB102 breadboard power module, 3.3 V / 5 V', category: 'Prototyping', price: '8', stock: '18', attributes: { model: 'MB102' } }, 11, 4, 2, true);
add({ prefix: 'SEN', nameNb: 'AS5600 magnetisk enkoder', nameEn: 'AS5600 magnetic encoder', category: 'Sensors', price: '14', stock: '11', attributes: { model: 'AS5600' } }, 11, 1, 3, true);
add({ prefix: 'SEN', nameNb: 'MPU6050 akselerometer', nameEn: 'MPU6050 accelerometer', category: 'Sensors', price: '19', stock: '9', attributes: { model: 'MPU6050' } }, 11, 2, 1, true);
add({ prefix: 'DRV', nameNb: 'TMC2209 stegmotordriver', nameEn: 'TMC2209 stepper motor driver', category: 'Motor drivers', price: '50', stock: '6', attributes: { model: 'TMC2209' } }, 11, 2, 2, true);
add({ prefix: 'DRV', nameNb: 'MX1508 H-bro til DC-motor', nameEn: 'MX1508 H-bridge DC motor driver', category: 'Motor drivers', price: '13', stock: '12', attributes: { model: 'MX1508' } }, 11, 2, 3, true);
add({ prefix: 'SEN', nameNb: 'Barometermodul', nameEn: 'Barometer module', category: 'Sensors', price: '54', stock: '4', attributes: {} }, 5, 10, 3, true);
add({ prefix: 'SEN', nameNb: 'GY-MAX4466 mikrofonmodul', nameEn: 'GY-MAX4466 microphone module', category: 'Sensors', price: '4', stock: '16', attributes: { model: 'GY-MAX4466' } }, 5, 12, 2, true);
add({ prefix: 'SEN', nameNb: 'HC-SR04P ultrasonisk avstandssensor', nameEn: 'HC-SR04P ultrasonic distance sensor', category: 'Sensors', price: '9', stock: '13', attributes: { model: 'HC-SR04P' } }, 5, 10, 4, true);
add({ prefix: 'SEN', nameNb: 'OV7670 kameramodul', nameEn: 'OV7670 camera module', category: 'Sensors', price: '24', stock: '5', attributes: { model: 'OV7670' } }, 11, 3, 2, true);
add({ prefix: 'MCU', nameNb: 'Arduino Uno', nameEn: 'Arduino Uno', category: 'Controllers', price: '14', stock: '8', attributes: { model: 'Arduino Uno' } }, 11, 3, 3, true);
add({ prefix: 'MCU', nameNb: 'Arduino Mega', nameEn: 'Arduino Mega', category: 'Controllers', price: '63', stock: '3', attributes: { model: 'Arduino Mega' } }, 5, 12, 3, true);
add({ prefix: 'MCU', nameNb: 'Arduino Nano', nameEn: 'Arduino Nano', category: 'Controllers', price: '13', stock: '10', attributes: { model: 'Arduino Nano' } }, 5, 12, 2, true);
add({ prefix: 'MCU', nameNb: 'ESP32 utviklingskort, standard', nameEn: 'ESP32 development board, standard', category: 'Controllers', price: '63', stock: '7', attributes: { model: 'ESP32' } }, 5, 12, 4, true);
add({ prefix: 'MOT', nameNb: 'R280 DC-motor', nameEn: 'R280 DC motor', category: 'Motors', price: '50', stock: '4', attributes: { model: 'R280' } }, 11, 3, 1, true);
add({ prefix: 'MOT', nameNb: 'SG90 servomotor', nameEn: 'SG90 servo motor', category: 'Motors', price: '35', stock: '9', attributes: { model: 'SG90' } }, 5, 9, 4, true);
add({ prefix: 'MOT', nameNb: 'NEMA 17 stegmotor', nameEn: 'NEMA 17 stepper motor', category: 'Motors', price: '38', stock: '3', attributes: { model: 'NEMA 17' } }, 12, 3, 1, true);
add({ prefix: 'BRD', nameNb: 'Hullkort 78 × 58 mm', nameEn: 'Perfboard 78 × 58 mm', category: 'Prototyping', price: '46', stock: '8', attributes: { package: '78 × 58 mm' } }, 5, 10, 2, true);
add({ prefix: 'BRD', nameNb: 'Hullkort 25.4 × 25.4 mm', nameEn: 'Perfboard 25.4 × 25.4 mm', category: 'Prototyping', price: '46', stock: '14', attributes: { package: '25.4 × 25.4 mm' } }, 5, 10, 1, true);
add({ prefix: 'BRD', nameNb: 'Hullkort 44.5 × 27.9 mm', nameEn: 'Perfboard 44.5 × 27.9 mm', category: 'Prototyping', price: '33', stock: '11', attributes: { package: '44.5 × 27.9 mm' } }, 5, 10, 1, true);

// Additional clearly labelled shelf contents; prices below are examples.
add({ prefix: 'MCU', nameNb: 'Nano V3.0 USB-C', nameEn: 'Nano V3.0 USB-C', category: 'Controllers', price: '18', stock: '6', attributes: { model: 'Nano V3.0', interface: 'USB-C' } }, 5, 8, 4);
add({ prefix: 'MIS', nameNb: '433 MHz RF-sender med mottaker', nameEn: '433 MHz RF transmitter and receiver', category: 'Miscellaneous', price: '15', stock: '7', attributes: {} }, 5, 9, 1);
add({ prefix: 'MIS', nameNb: '4 × 4 matrisetastatur', nameEn: '4 × 4 matrix keypad', category: 'Miscellaneous', price: '12', stock: '9', attributes: {} }, 5, 9, 2);
add({ prefix: 'MIS', nameNb: 'Holder til SG90-servo', nameEn: 'SG90 servo bracket', category: 'Miscellaneous', price: '5', stock: '15', attributes: { model: 'SG90 bracket' } }, 5, 9, 3);
add({ prefix: 'CON', nameNb: 'Rett stiftlist, hann', nameEn: 'Straight male header strip', category: 'Connectors', price: '3', stock: '42', attributes: {} }, 5, 11, 2);
add({ prefix: 'CON', nameNb: 'Vinklet stiftlist, hann, 90°', nameEn: 'Right-angle male header strip, 90°', category: 'Connectors', price: '4', stock: '24', attributes: {} }, 5, 11, 3);
add({ prefix: 'CON', nameNb: 'Hunnlist', nameEn: 'Female header strip', category: 'Connectors', price: '4', stock: '31', attributes: {} }, 5, 11, 4);
add({ prefix: 'BRD', nameNb: 'Koblingsbrett med 400 punkter', nameEn: '400-point solderless breadboard', category: 'Prototyping', price: '15', stock: '12', attributes: { pins: '400' } }, 11, 4, 1);
add({ prefix: 'CON', nameNb: 'Batteriholder til 9 V-batteri', nameEn: '9 V battery holder', category: 'Connectors', price: '5', stock: '22', attributes: { voltage: '9' } }, 11, 4, 3);
add({ prefix: 'MIS', nameNb: 'RFID RC522-modul', nameEn: 'RFID RC522 module', category: 'Miscellaneous', price: '20', stock: '6', attributes: { model: 'RC522' } }, 11, 5, 1);
add({ prefix: 'MIS', nameNb: 'IR-fjernkontrollmodul', nameEn: 'IR remote control module', category: 'Miscellaneous', price: '15', stock: '8', attributes: { interface: 'IR' } }, 11, 5, 2);
add({ prefix: 'LED', nameNb: 'RGB LED-matrise, 8 × 8', nameEn: 'RGB LED matrix, 8 × 8', category: 'LEDs', price: '35', stock: '3', attributes: { colour: 'RGB' } }, 11, 5, 3);
add({ prefix: 'LED', nameNb: 'LED-matrisemodul', nameEn: 'LED matrix module', category: 'LEDs', price: '18', stock: null, attributes: {} }, 11, 6, 3);

for (const [col, [colour, nb]] of ([['Red', 'Rød'], ['Green', 'Grønn'], ['Blue', 'Blå'], ['Yellow', 'Gul']] as const).entries()) {
	add({ prefix: 'CON', nameNb: `${nb} banankontakt, hunn`, nameEn: `${colour} banana socket`, category: 'Connectors', price: '5', stock: ['18', '12', '16', '9'][col], attributes: { colour } }, 10, 1, col + 1);
}
add({ prefix: 'CON', nameNb: 'Svart banankontakt, hunn', nameEn: 'Black banana socket', category: 'Connectors', price: '5', stock: '21', attributes: { colour: 'Black' } }, 10, 2, 1);
for (const [col, [colour, nb]] of ([['Black', 'Svart'], ['Red', 'Rød'], ['Blue', 'Blå']] as const).entries()) {
	add({ prefix: 'CON', nameNb: `${nb} bananplugg, hann`, nameEn: `${colour} male banana plug`, category: 'Connectors', price: '6', stock: ['24', '19', '13'][col], attributes: { colour } }, 10, 2, col + 2);
}

add({ prefix: 'MIS', nameNb: 'TL072 operasjonsforsterker', nameEn: 'TL072 operational amplifier', category: 'Miscellaneous', price: '5', stock: '18', attributes: { model: 'TL072' } }, 3, 6, 4);
add({ prefix: 'MIS', nameNb: 'MC75451 periferidriver', nameEn: 'MC75451 dual peripheral driver', category: 'Miscellaneous', price: '6', stock: '12', attributes: { model: 'MC75451' } }, 4, 12, 4);
add({ prefix: 'CON', nameNb: 'IC-sokkel, assortert', nameEn: 'IC socket, assorted', category: 'Connectors', price: '3', stock: '27', attributes: {} }, 3, 1, 2);
add({ prefix: 'MIS', nameNb: 'NAND-logikkrets, assortert', nameEn: 'NAND logic IC, assorted', category: 'Miscellaneous', price: '4', stock: '16', attributes: {} }, 3, 1, 1);
add({ prefix: 'MIS', nameNb: 'NOR-logikkrets, assortert', nameEn: 'NOR logic IC, assorted', category: 'Miscellaneous', price: '4', stock: '14', attributes: {} }, 3, 2, 2);
add({ prefix: 'MIS', nameNb: 'Spenningsregulator, assortert', nameEn: 'Voltage regulator, assorted', category: 'Miscellaneous', price: '5', stock: null, attributes: {} }, 3, 6, 2);

for (const [index, model] of ['BC550C', 'BC560C', 'BC308B', 'BC327', 'BC337'].entries()) {
	add({ prefix: 'BJT', nameNb: `${model} transistor`, nameEn: `${model} transistor`, category: 'Bipolar transistors', price: '2', stock: ['32', '26', '14', '38', '45'][index], attributes: { model } }, 9, index < 2 ? 1 : 3, index < 2 ? 3 : 4, false);
}
add({ prefix: 'DIO', nameNb: '1N4148 signaldiode', nameEn: '1N4148 signal diode', category: 'Diodes', price: '1', stock: '120', attributes: { model: '1N4148' } }, 9, 9, 1);
for (const [index, [colour, nb]] of ([['Red', 'Rød'], ['Green', 'Grønn'], ['Blue', 'Blå'], ['Yellow', 'Gul'], ['White', 'Hvit']] as const).entries()) {
	add({ prefix: 'LED', nameNb: `${nb} LED`, nameEn: `${colour} LED`, category: 'LEDs', price: '1.50', stock: ['64', '52', '38', '29', '0'][index], attributes: { colour, polarised: true } }, 9, index < 3 ? 5 : 4, index < 3 ? 1 : 3, false);
}
add({ prefix: 'MIS', nameNb: 'Sikring 630 mA', nameEn: '630 mA fuse', category: 'Miscellaneous', price: '3', stock: '24', attributes: {} }, 4, 1, 1, false);
add({ prefix: 'MIS', nameNb: 'Sikring 800 mA', nameEn: '800 mA fuse', category: 'Miscellaneous', price: '3', stock: '17', attributes: {} }, 4, 1, 1);
add({ prefix: 'MIS', nameNb: 'Glassikring 6.3 × 32 mm, assortert', nameEn: '6.3 × 32 mm glass fuse, assorted', category: 'Miscellaneous', price: '4', stock: '0', attributes: { package: '6.3 × 32 mm' } }, 4, 1, 3);

export const WORKSHOP_PARTS: readonly DemoPart[] = parts;
