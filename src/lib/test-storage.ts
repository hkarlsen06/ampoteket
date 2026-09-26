/** In-memory stand-in for localStorage/sessionStorage in unit tests. */
export function memory() {
	const values = new Map<string, string>();
	return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
