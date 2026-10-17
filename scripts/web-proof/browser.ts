/** Browser probe for shared modules, not product UI. No credentials in its URL. */
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { authStorageKeys, ConvexAuthSession } from '../../src/lib/convex-auth';
import { errorCode } from '../../src/lib/convex';
import { lookupCatalogProduct, readCatalogPage, readCompleteCatalog } from '../../src/lib/catalog';

const config = await (await fetch('/proof/config')).json() as { url: string };
const client = new ConvexClient(config.url);
const auth = new ConvexAuthSession(config.url, new ConvexHttpClient(config.url, { logger: false }));
auth.load();
client.setAuth(auth.fetchAccessToken);
auth.subscribe(() => client.setAuth(auth.fetchAccessToken));
/** STAFF_REQUIRED reads as "no rows", the way RLS answered before. */
async function staffOnly<T>(read: () => Promise<T>, empty: T): Promise<T> {
	try { return await read(); } catch (error) { if (errorCode(error) === 'STAFF_REQUIRED') return empty; throw error; }
}
const probe = {
	async login(email: string, password: string) {
		await auth.signIn(email, password);
		return this.membership();
	},
	async membership() {
		return (await client.query(api.members.me, {}))?.membership ?? null;
	},
	/** A refresh spends the refresh token and stores a new one (a JWT minted in the same second may be identical). */
	async refresh() {
		const key = authStorageKeys(config.url).refresh;
		const before = localStorage.getItem(key);
		const token = await auth.fetchAccessToken({ forceRefreshToken: true });
		const after = localStorage.getItem(key);
		return before !== null && token !== null && after !== null && after !== before;
	},
	async logout() {
		await auth.signOut(client);
		return auth.token === null;
	},
	async catalog() { return readCompleteCatalog(client); },
	async catalogPage(limit?: number) { return readCatalogPage(client, limit ? { limit } : {}); },
	async product(code: string) { return lookupCatalogProduct(client, code); },
	async updatePrice(id: string, revision: string, price: string) {
		return staffOnly(async () => {
			const current = await client.query(api.products.get, { id });
			if (!current || current.metadata_revision !== revision) return [];
			const { metadata_revision, created_at, ...payload } = current;
			const saved = await client.mutation(api.products.save, { revision, payload: { ...payload, sale_unit_price_nok: price } });
			return [{ id: saved.id, sale_unit_price_nok: saved.sale_unit_price_nok, metadata_revision: saved.metadata_revision }];
		}, []);
	},
	async staffProducts() {
		return staffOnly(async () => (await client.query(api.products.list, {})).map((p) => ({ id: p.id })), []);
	}
};
(window as unknown as { proof: typeof probe }).proof = probe;
