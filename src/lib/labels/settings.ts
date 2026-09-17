/** One proportional layout; dimensions are millimetres, font size is points. */
export function proportionalLabelSettings(width: number) {
	const scale = width / 45;
	return { autoHeight: true, width, height: 47 * scale, qrSize: 43.5 * scale,
		fontSize: 10 * scale, margin: 10 * scale, gap: 2 * scale };
}
