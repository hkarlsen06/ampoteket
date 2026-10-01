/**
 * Unsaved form input (and a few view choices), kept per staff user so an
 * accidental reload, Back, closed sheet or sign-in round trip gives it back.
 * Only typing lives here: a submitted write belongs to its command journal, and
 * the form drops its draft once that write is acknowledged. Storage is a
 * convenience; when it is full or blocked the form keeps working from memory.
 */
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const draftKey = (userId: string, name: string) => `ampoteket:draft:v1:${userId}:${name}`;
// Resolved inside each try: a blocked browser throws on the storage getter itself.
const resolve = (storage: DraftStorage | 'session' | undefined) => storage === 'session' ? sessionStorage : storage ?? localStorage;

/** `'session'` keeps the draft for the tab only. */
export function readDraft(userId: string | undefined, name: string, storage?: DraftStorage | 'session'): unknown {
	if (!userId) return null;
	try { const raw = resolve(storage).getItem(draftKey(userId, name)); return raw === null ? null : JSON.parse(raw); }
	catch { return null; }
}

/** Saves `value`, or removes the draft when it is null. */
export function writeDraft(userId: string | undefined, name: string, value: unknown, storage?: DraftStorage | 'session') {
	if (!userId) return;
	try {
		if (value === null) resolve(storage).removeItem(draftKey(userId, name));
		else resolve(storage).setItem(draftKey(userId, name), JSON.stringify(value));
	} catch { /* Full or blocked storage leaves the draft in memory only. */ }
}

/** The fields of `saved` typed like `shape`; a field that is null in `shape` takes a string or null. */
export function draftFields<T extends object>(shape: T, saved: unknown): Partial<T> {
	const fields: Partial<T> = {};
	if (!saved || typeof saved !== 'object') return fields;
	for (const name of Object.keys(shape) as (keyof T)[]) {
		const value = (saved as T)[name], expected = shape[name];
		if (expected === null ? value === null || typeof value === 'string' : value !== null && typeof value === typeof expected) fields[name] = value;
	}
	return fields;
}
