// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			catalog?: { queryString: string; products: import('#lib/catalog.js').CatalogProduct[] };
		}
	}
}

export {};
