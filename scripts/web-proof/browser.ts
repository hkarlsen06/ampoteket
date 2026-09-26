/** Browser probe for shared modules, not product UI. No credentials in its URL. */
import { createBrowserAdminAuth, readAdminMembership } from '../../src/lib/admin-auth';
import { readCatalogPage, readCompleteCatalog, lookupCatalogProduct } from '../../src/lib/catalog';
import { requestApiJson } from '../../src/lib/api';

const config = await (await fetch('/proof/config')).json();
const auth = await createBrowserAdminAuth(config);
async function session() {
	const { data, error } = await auth.getSession();
	if (error || !data.session) throw new Error('Proof session missing');
	return data.session;
}
const probe = {
	async login(email: string, password: string) {
		const { error } = await auth.signInWithPassword({ email, password });
		if (error) throw new Error(`Proof sign-in failed (${error.status ?? 'network'}, ${error.code?.replace(/[^a-zA-Z0-9_]/g, '') ?? 'no-code'}): ${error.message.replaceAll(password, '[redacted]').replaceAll(config.publishableKey, '[redacted]').slice(0, 300)}`);
		return this.membership();
	},
	async membership() {
		const current = await session();
		return readAdminMembership(config, current.access_token, current.user.id);
	},
	async refresh() {
		const before = await session();
		const { data, error } = await auth.refreshSession();
		if (error || !data.session) throw new Error('Proof refresh failed');
		return data.session.user.id === before.user.id && data.session.refresh_token !== before.refresh_token;
	},
	async logout() {
		const { error } = await auth.signOut();
		if (error) throw new Error('Proof sign-out failed');
		return (await auth.getSession()).data.session === null;
	},
	async catalog() { return readCompleteCatalog(config); },
	async catalogPage() { return readCatalogPage(config); },
	async product(code: string) { return lookupCatalogProduct(config, code); },
	async updatePrice(id: string, revision: string, price: string) {
		const current = await session();
		return requestApiJson(`${config.url}/rest/v1/amp_products?id=eq.${id}&metadata_revision=eq.${revision}&select=id,sale_unit_price_nok,metadata_revision`, {
			method: 'PATCH', headers: { apikey: config.publishableKey, Authorization: `Bearer ${current.access_token}`,
				'Content-Type': 'application/json', Prefer: 'return=representation' },
			body: JSON.stringify({ sale_unit_price_nok: price }), cache: 'no-store'
		});
	},
	async staffProducts() {
		const current = await session();
		return requestApiJson(`${config.url}/rest/v1/amp_products?select=id`, {
			headers: { apikey: config.publishableKey, Authorization: `Bearer ${current.access_token}` }, cache: 'no-store'
		});
	}
};
(window as unknown as { proof: typeof probe }).proof = probe;
