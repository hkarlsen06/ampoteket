<script lang="ts">
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { productName } from '#lib/catalog.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { codeText, formGrid, formLayout, formStatus, lede, nameWrap, pageHeader, pageHeading, section, sectionHeading, sheetBody } from '#lib/ui.js';
	import { controlStyles } from '#lib/components/ui/control.js';
	import { cn } from '#lib/utils.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as RadioGroup from '#lib/components/ui/radio-group/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import DisclosureTrigger from '#lib/DisclosureTrigger.svelte';
	import AdminStatistics from '#lib/AdminStatistics.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import CategoryGraphic from '#lib/CategoryGraphic.svelte';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';

	import { untrack, onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { getI18n, categoryLabel, messagesFor } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { gridCell, gridRange, formatDecimal, formatCountedAt, nameMeasurement, tidyNameMeasurements, unitLabel } from '#lib/format.js';
	import { compareDecimals, normalizeDecimal } from '#lib/decimal.js';
	import { uuidPattern } from '#lib/api.js';
	import { translateName } from '#lib/name-translation.js';
	import type { StaffSession } from '#lib/admin-api.js';
	import CountForm from '#lib/CountForm.svelte';
	import StockBadge from '#lib/StockBadge.svelte';
	import ProductAttributes from '#lib/ProductAttributes.svelte';
	import LabelPrintButton, { queueLabelPrint } from '#lib/LabelPrintButton.svelte';
	import { choosePrinter, printerSupported } from '#lib/labels/ptouch.js';
	import { clearCountCommand, readCountCommand, runCountCommand, saveCountCommand, updateCountStorage, validCountQuantity, type CountCommand } from '#lib/admin-counts.js';
	import ProductSpecificationRecovery from '#lib/ProductSpecificationRecovery.svelte';
	import { parseAttribute, ProductSpecificationsError, type ProductAttributeDraft } from '#lib/admin-products.js';
	import ShelfPlacementPicker from '#lib/ShelfPlacementPicker.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { readOutstandingByProduct } from '#lib/admin-orders.js';
	import { draftFields, readDraft, writeDraft } from '#lib/drafts.js';
	import { clearProductCommand, definitiveProductFailure, executeProductCommand, sameProduct, generateCategoryProductCode, generateProductCode, isProductCodeCollision, parseProductWrite, persistProductCommand, ProductFieldError, productCategoryOptions, readProduct, readProductCommand, readProductReferences, readProductStock, StaleProductError, type AdminProduct, type ProductCommand, type ProductFamily, type ProductReferences, type ProductStock, type ProductWrite } from '#lib/admin-products.js';
	// `oncreated` embeds a new-product editor in another page's sheet: no page heading, title,
	// label printing or opening stock (an order's receipt brings the stock), and the created
	// product goes to the caller instead of opening its own route. `busy` lets that sheet stay open while saving.
	let { id, oncreated, busy = $bindable(false) }: { id: string; oncreated?: (product: AdminProduct) => void; busy?: boolean } = $props();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminProducts);
	let product = $state<AdminProduct | null>(null); let references = $state<ProductReferences | null>(null); let stock = $state<ProductStock | null>(null);
	// Quantity still expected from open supplier orders; null when none or unreadable.
	let onOrder = $state<string | null>(null);
	const blank: ProductWrite = { id: '', code: '', name_nb: '', name_en: '', description: null, category_id: null, bin_id: null, location_note: null, unit_code: 'pcs', stock_step: '1', sale_step: '1', sale_unit_price_nok: '0', minimum_stock: '0', datasheet_url: null, purchase_url: null, is_active: true };
	let draft = $state<ProductWrite>({ ...blank });
	let staged = $state<ProductAttributeDraft[]>([]);
	let attributesEditor = $state<{ prepare: () => boolean; commit: () => Promise<boolean>; suggest: (code: string, value: string) => void }>();
	let pending = $state<ProductCommand | null>(null); let storageReady = $state(false);
	let loading = $state(true); let loadFailed = $state(false); let outcome = $state('idle'); let current = $state<AdminProduct | null>(null);
	let invalidField = $state<keyof ProductWrite | null>(null); let reviewFailed = $state(false);
	let moveOpen = $state(false);
	let placementOpen = $state(false);
	// Description and links are rarely filled in, so they stay folded until one has a value.
	let detailsOpen = $state(false);
	// The note field stays hidden until staff say the product has no drawer.
	let offShelf = $state(false);
	const showNote = $derived(!draft.bin_id && (offShelf || Boolean(draft.location_note)));
	async function revealNote() {
		offShelf = true; await tick();
		document.getElementById('product-location-note')?.focus({ preventScroll: true });
	}
	// A new product's stock is its first count, posted right after creation; empty means
	// not counted. Its label can print as the editor opens on the product's route.
	let openingStock = $state(''); let openingInvalid = $state(false);
	let printAfterSave = $state(true); let canPrint = $state(false);
	const openingCount = (step: string) => openingStock.trim() ? validCountQuantity(openingStock, step, i18n.locale) : null;
	let proposedPlacement = $state<{ from: string | null; to: string } | null>(null);
	let placementTrigger: HTMLElement | null = null;
	let stockLoading = $state(false); let stockGeneration = 0;
	let alive = true; let restoringCreation = $state(false);
	const ownPending = $derived(Boolean(pending && (pending.payload.id === id || (id === 'new' && pending.revision === null))));
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	const blocked = $derived(busy || Boolean(pending));
	const ready = $derived(Boolean(references && (product || id === 'new' || ownPending || restoringCreation)));
	const bins = $derived(references?.shelf.bins ?? []);
	const categories = $derived(productCategoryOptions(references?.categories ?? []));
	const legacyCategory = $derived(references?.categories.find(category => category.id === (product ? product.category_id : draft.category_id) && !categories.some(option => option.id === category.id)));
	const keepUncategorized = $derived(Boolean((product && product.category_id === null) || (ownPending && pending?.payload.category_id === null)));
	const productCode = $derived(product?.code ?? (ownPending ? pending?.payload.code : null));
	const attributeProductId = $derived(ownPending && pending?.revision === null ? null : product?.id ?? null);
	// Red at or below zero, yellow above zero but under the saved minimum. The number's
	// colour repeats StockBadge's state; yellow is a filled chip because it fails contrast as text.
	const stockLevel = $derived(!stock || !product ? null : compareDecimals(stock.quantity, '0') <= 0 ? 'out' : compareDecimals(stock.quantity, product.minimum_stock) < 0 ? 'low' : 'ok');
	// Names, specifications and the rest follow the category, so a new product chooses
	// it first on the category cards and the form grows in below; a saved
	// uncategorized product keeps its form. Saved products change it in a compact select.
	const namesLocked = $derived(!draft.category_id && !keepUncategorized);
	const categoryCards = $derived(!product && !legacyCategory && !keepUncategorized);
	const family = $derived(categories.find(category => category.id === draft.category_id)?.prefix ?? null);
	const productCategory = $derived(categories.find(category => category.id === draft.category_id)?.name ?? references?.categories.find(category => category.id === draft.category_id)?.name ?? null);
	$effect(() => {
		const code = productCode;
		if (!code) return;
		admin.productBreadcrumb = { routeId: id, code };
		return () => { if (admin.productBreadcrumb?.routeId === id) admin.productBreadcrumb = null; };
	});
	const fieldIds: Partial<Record<keyof ProductWrite, string>> = {
		name_nb: 'product-name-nb', name_en: 'product-name-en', stock_step: 'product-stock-step',
		sale_step: 'product-sale-step', sale_unit_price_nok: 'product-price', minimum_stock: 'product-minimum-stock', bin_id: 'product-placement-trigger', location_note: 'product-location-note', datasheet_url: 'product-datasheet', purchase_url: 'product-purchase'
	};
	function errorMessage(field: keyof ProductWrite): string {
		return field === 'stock_step' ? m.invalidStockStep : field === 'sale_step' ? m.invalidSaleStep
			: field === 'sale_unit_price_nok' ? m.invalidPrice : field === 'minimum_stock' ? m.invalidMinimumStock
				: field === 'datasheet_url' || field === 'purchase_url' ? m.invalidLink : m.invalid;
	}
	function binLabel(binId: string | null): string {
		const bin = bins.find(b => b.id === binId); const cabinet = references?.shelf.cabinets.find(c => c.id === bin?.cabinet_id);
		return bin && cabinet ? m.location(gridCell(cabinet.outer_row, cabinet.outer_col), gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span)) : m.unplaced;
	}
	function selectPlacement(binId: string, event: MouseEvent | KeyboardEvent) {
		if (blocked) return;
		const from = draft.bin_id ?? product?.bin_id ?? null;
		if (!from || from === binId) { draft.bin_id = binId; placementOpen = false; return; }
		proposedPlacement = { from, to: binId };
		placementTrigger = event.currentTarget as HTMLElement;
		moveOpen = true;
	}
	function confirmPlacement() {
		if (blocked || admin.status !== 'ready' || !proposedPlacement) return;
		draft.bin_id = proposedPlacement.to;
		moveOpen = false;
		placementOpen = false;
	}
	onMount(() => {
		canPrint = printerSupported() && !oncreated;
		try { pending = readProductCommand(sessionStorage); restoringCreation = Boolean(pending && pending.revision === null && pending.payload.id === id); const probe = 'ampoteket:product-probe'; sessionStorage.setItem(probe, '1'); if (sessionStorage.getItem(probe) !== '1') throw new Error(); sessionStorage.removeItem(probe); storageReady = true; }
		catch { storageReady = false; }
		void load(); return () => { alive = false; if (id !== 'new') queueLabelPrint(null); };
	});
	async function refreshStock() {
		if (!product || admin.status !== 'ready') return;
		const generation = ++stockGeneration; stockLoading = true;
		try {
			const session = admin.credentials();
			// Read together so the on-order badge never pops in after the balance.
			const [next, outstanding] = await Promise.all([readProductStock(session, product.id), readOutstandingByProduct(session).catch(() => null)]);
			if (alive && generation === stockGeneration && admin.session?.user.id === session.userId) { stock = next; onOrder = outstanding?.get(product.id) ?? null; } }
		catch (error) { if (alive && generation === stockGeneration) stock = null; await admin.permissionFailure(error); }
		finally { if (alive && generation === stockGeneration) stockLoading = false; }
	}
	// The app owns freshness (design-system.md §4.2): the recorded balance
	// re-reads on return to the tab; the draft fields are never touched.
	let revalidateQueued = $state(false);
	function revalidateStock() { revalidateQueued = document.visibilityState === 'visible'; }
	$effect(() => {
		if (revalidateQueued && admin.status === 'ready' && !(stockLoading || busy)) {
			revalidateQueued = false;
			untrack(() => { void refreshStock(); });
		}
	});
	async function load() {
		if (admin.status !== 'ready') return;
		loading = true; loadFailed = false;
		try {
			const session = admin.credentials();
			if (id !== 'new' && !uuidPattern.test(id)) { product = null; return; }
			const [refs, item] = await Promise.all([readProductReferences(session), id === 'new' ? Promise.resolve(null) : readProduct(session, id)]);
			if (!alive || session.userId !== admin.session?.user.id) return;
			references = refs; product = item;
			// Unsaved input returns only onto the revision it was typed against.
			if (pending && ownPending && !wrongIdentity) { draft = { ...pending.payload }; staged = pending.attributes ?? []; openingStock = pending.opening ?? ''; }
			else {
				if (item) draft = { ...item };
				// Unsaved input returns only onto the revision it was typed against.
				const saved = readDraft(session.userId, `product:${id}`) as { revision?: unknown; fields?: unknown; staged?: unknown; opening?: unknown } | null;
				if (saved && saved.revision === (item?.metadata_revision ?? null)) {
					if (!item && typeof saved.opening === 'string') openingStock = saved.opening;
					draft = { ...draft, ...draftFields(blank, saved.fields) };
					if (!item && Array.isArray(saved.staged)) try {
						staged = saved.staged.map(row => { const { product_id, ...value } = parseAttribute({ ...row, product_id: blankId }); return value; });
					} catch { /* A malformed row leaves the specifications unrestored. */ }
				}
			}
			draftLoaded = true;
			detailsOpen = Boolean(draft.description || draft.datasheet_url || draft.purchase_url);
			if (product) void refreshStock();
		} catch (error) { if (alive) loadFailed = true; await admin.permissionFailure(error); }
		finally { if (alive) loading = false; }
	}
	// Unsaved input outlives a reload, Back or sign-in round trip (drafts.ts); a
	// pending command owns the form until it resolves, and a draft is left alone meanwhile.
	let draftLoaded = $state(false);
	const blankId = '00000000-0000-4000-8000-000000000000';
	const writeKeys = Object.keys(blank) as (keyof ProductWrite)[];
	const writeFields = (value: ProductWrite) => JSON.stringify(writeKeys.map(key => value[key]));
	$effect(() => {
		if (!draftLoaded || pending) return;
		const dirty = (writeFields(draft) !== writeFields(product ?? blank) || (!product && (staged.length > 0 || openingStock !== '')));
		writeDraft(admin.session?.user.id, `product:${product?.id ?? id}`, dirty
			? { revision: product?.metadata_revision ?? null, fields: $state.snapshot(draft), ...(product ? {} : { staged: $state.snapshot(staged), opening: openingStock }) } : null);
	});
	async function review() {
		if (busy || !product) return; busy = true; reviewFailed = false;
		try { current = await readProduct(admin.credentials(), product.id); if (!current) outcome = 'missing'; }
		catch (error) { reviewFailed = true; await admin.permissionFailure(error); } finally { busy = false; }
	}
	function useRevision() { if (!current || busy) return; product = current; current = null; outcome = 'idle'; }
	async function save(event?: SubmitEvent) {
		event?.preventDefault(); if (busy || moveOpen || admin.status !== 'ready' || !storageReady || wrongIdentity || (pending && !ownPending) || outcome === 'stale') return;
		// Enter can submit without a change event; tidy the names as leaving them would.
		if (!pending) nameFields.forEach(({ field }) => tidyName(field));
		if (attributesEditor && (product || !pending) && !attributesEditor.prepare()) return;
		busy = true; outcome = 'idle'; invalidField = null; openingInvalid = false;
		const existing = Boolean(product);
		try {
			const session = admin.credentials();
			if (!pending) {
				let payload: ProductWrite;
				try {
					const decimals = { stock_step: '', sale_step: '', sale_unit_price_nok: '', minimum_stock: '' };
					for (const field of ['stock_step', 'sale_step', 'sale_unit_price_nok', 'minimum_stock'] as const) {
						try { decimals[field] = normalizeDecimal(draft[field], i18n.locale); }
						catch { throw new ProductFieldError(field); }
					}
					payload = parseProductWrite({ ...draft, ...decimals,
						id: product?.id ?? (restoringCreation ? draft.id : crypto.randomUUID()),
						code: product?.code ?? generateCategoryProductCode(draft.category_id, references?.categories ?? [], restoringCreation ? draft.code : undefined),
						name_nb: draft.name_nb.trim(), name_en: draft.name_en.trim(), description: draft.description?.trim() || null,
						category_id: draft.category_id || null, bin_id: draft.bin_id || null, location_note: draft.bin_id ? null : draft.location_note?.trim() || null, datasheet_url: draft.datasheet_url?.trim() || null, purchase_url: draft.purchase_url?.trim() || null
					});
				} catch (error) {
					outcome = 'invalid';
					if (error instanceof ProductFieldError) {
						invalidField = error.field;
						if (error.field === 'datasheet_url' || error.field === 'purchase_url') detailsOpen = true;
						void tick().then(() => {
							const id = fieldIds[error.field];
							const element = id ? document.getElementById(id) : null;
							(element instanceof HTMLFieldSetElement ? element.querySelector<HTMLElement>('button[tabindex="0"]') : element)?.focus();
						});
					}
					return;
				}
				let opening: string | null = null;
				if (!product && !oncreated) {
					try { opening = openingCount(payload.stock_step); }
					catch { outcome = 'invalid'; openingInvalid = true; void tick().then(() => document.getElementById('product-opening-stock')?.focus()); return; }
					if (opening !== null && readCountCommand(localStorage)) { outcome = 'countPending'; return; }
				}
				// Specification-only edits leave the product revision untouched.
				if (!product || !sameProduct(product, payload)) {
					const command: ProductCommand = { userId: session.userId, payload, revision: product?.metadata_revision ?? null, ...(!product && staged.length ? { attributes: staged.map(value => ({ ...value })) } : {}), ...(opening === null ? {} : { opening }) };
					persistProductCommand(sessionStorage, command); pending = command;
				}
			}
			// Picking the printer needs this click, so it comes before the first request.
			let printLabel = false;
			if (id === 'new' && printAfterSave && canPrint) try { await choosePrinter(); printLabel = true; } catch { /* Cancelled: the product page keeps Print. */ }
			// The creation command carries the opening stock, whichever route resumes it.
			const opening = pending?.revision === null ? pending.opening ?? null : null;
			if (pending) await saveMetadata(session);
			if (existing && attributesEditor && !(await attributesEditor.commit())) { outcome = 'specificationsNotSaved'; return; }
			if (!alive || session.userId !== admin.session?.user.id) return;
			outcome = 'saved';
			if (product && opening !== null) {
				const stored = await countOpeningStock(session, product.id, opening);
				if (!alive || session.userId !== admin.session?.user.id) return;
				// Unstored, the count is lost: stay, so the count button is at hand.
				if (!stored) { outcome = 'openingNotCounted'; void refreshStock(); return; }
			}
			if (id === 'new' && product && oncreated) oncreated(product);
			else if (id === 'new' && product) {
				if (printLabel) queueLabelPrint({ productId: product.id, userId: session.userId });
				void goto(i18n.href(`/admin/products/${product.id}`), { replace: true });
			} else void refreshStock();
		} catch (error) {
			if (error instanceof ProductSpecificationsError) outcome = 'specificationsIncomplete';
			else if (pending && (error instanceof StaleProductError || definitiveProductFailure(error))) { clearProductCommand(sessionStorage, pending); pending = null; outcome = error instanceof StaleProductError ? 'stale' : 'failed'; }
			else outcome = pending ? 'unknown' : 'storage';
			await admin.permissionFailure(error instanceof ProductSpecificationsError ? error.cause : error);
		} finally { if (alive) busy = false; }
	}
	// A new product holds 0 at revision 0, so its first count needs no read. Once stored,
	// a failed count is the count dialog's to retry (CountForm); false means it was never stored.
	async function countOpeningStock(session: StaffSession, productId: string, quantity: string): Promise<boolean> {
		const command: CountCommand = { kind: 'count', userId: session.userId, requestId: crypto.randomUUID(), productId, batchId: null, revision: '0', expected: '0', quantity, note: null };
		let frozen: CountCommand;
		try { frozen = await updateCountStorage(storage => saveCountCommand(storage, command)); }
		catch { return false; }
		try {
			await runCountCommand(session, frozen);
			await updateCountStorage(storage => clearCountCommand(storage, frozen));
		} catch (error) { await admin.permissionFailure(error); }
		return true;
	}
	async function saveMetadata(session: StaffSession) {
		let result: AdminProduct | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			const original = readProductCommand(sessionStorage);
			if (!original || JSON.stringify(original) !== JSON.stringify(pending) || original.userId !== session.userId) throw new Error('Product command changed');
			try { result = await executeProductCommand(session, original); break; }
			catch (error) {
				if (original.revision !== null || !isProductCodeCollision(error) || attempt === 3) throw error;
				// A database code collision is a definite rollback. Check the original ID
				// before changing only its candidate code; network failures never enter here.
				if (await readProduct(session, original.payload.id)) throw new StaleProductError();
				const replacement = { ...original, payload: { ...original.payload, code: generateProductCode(original.payload.code.slice(0, 3) as ProductFamily) } };
				clearProductCommand(sessionStorage, original); persistProductCommand(sessionStorage, replacement); pending = replacement;
			}
		}
		if (!result || !pending) throw new Error('Missing product acknowledgement');
		clearProductCommand(sessionStorage, pending);
		if (pending.revision === null) for (const name of ['product:new', 'product:new:specifications']) writeDraft(session.userId, name, null);
		if (!alive || session.userId !== admin.session?.user.id) return;
		pending = null; product = result; draft = { ...result }; staged = [];
	}
	// The value that names a resistor or capacitor; shorthand like "4p7" in a name uses its unit.
	const nameSpecifications: Partial<Record<ProductFamily, { code: string; unit: string }>> = { RES: { code: 'resistance', unit: 'ohm' }, CAP: { code: 'capacitance', unit: 'F' } };
	// Component names start with the category's singular label («Kondensator · keramisk 4,7 pF»).
	// The editor locks that part; it is stored in the name like the rest, so every
	// reader (cart, checkout snapshot, labels) keeps using the full name as saved.
	const prefixedFamilies: ProductFamily[] = ['RES', 'CAP', 'DIO', 'LED', 'BJT', 'MOS'];
	const nameFields = [{ field: 'name_nb', locale: 'nb' }, { field: 'name_en', locale: 'en' }] as const;
	type NameField = typeof nameFields[number]['field'];
	const nameLocale = (field: NameField) => field === 'name_nb' ? 'nb' : 'en';
	function namePrefix(categoryId: string | null, locale: 'nb' | 'en'): string {
		const type = categories.find(category => category.id === categoryId);
		return type && prefixedFamilies.includes(type.prefix) ? `${categoryLabel(type.name, locale)} · ` : '';
	}
	/** The locked prefix, unless an older name does not start with it; that name stays whole. */
	function lockedPrefix(field: NameField): string {
		const prefix = namePrefix(draft.category_id, nameLocale(field));
		return prefix && (!draft[field] || draft[field].startsWith(prefix)) ? prefix : '';
	}
	function setNameRest(field: NameField, rest: string) { draft[field] = rest ? lockedPrefix(field) + rest : ''; }
	// Typing one name drafts the other while it is empty or still holds the last
	// draft; once staff change it, it is theirs and is never overwritten.
	const drafted: Partial<Record<NameField, string>> = {};
	function typeName(field: NameField, rest: string) {
		setNameRest(field, rest);
		const other: NameField = field === 'name_nb' ? 'name_en' : 'name_nb';
		const current = draft[other].slice(lockedPrefix(other).length);
		if (current && current !== drafted[other]) return;
		drafted[other] = translateName(rest, nameLocale(field), nameLocale(other));
		setNameRest(other, drafted[other]);
	}
	function setCategory(categoryId: string | null) {
		const rests = nameFields.map(({ field }) => draft[field].slice(lockedPrefix(field).length));
		draft.category_id = categoryId;
		nameFields.forEach(({ field, locale }, index) => draft[field] = rests[index] ? namePrefix(categoryId, locale) + rests[index] : '');
	}
	function tidyName(field: NameField) {
		const locale = nameLocale(field); const specification = family ? nameSpecifications[family] : undefined;
		const rest = tidyNameMeasurements(draft[field].slice(lockedPrefix(field).length).trim(), specification?.unit ?? null, locale);
		typeName(field, rest);
		const value = specification && nameMeasurement(rest, specification.unit, locale);
		if (value) attributesEditor?.suggest(specification.code, value);
	}
	function categoryName(categoryId: string | null): string {
		const standard = categories.find(category => category.id === categoryId);
		const saved = references?.categories.find(category => category.id === categoryId);
		return standard ? m.typeNames[standard.prefix] : saved ? categoryLabel(saved.name, i18n.locale) : m.noCategory;
	}
	function comparable(row: ProductWrite) {
		return [[m.nameNb, row.name_nb], [m.nameEn, row.name_en], [m.description, row.description ?? '–'], [m.category, categoryName(row.category_id)], [m.placement, binLabel(row.bin_id)], [m.locationNote, row.location_note ?? '–'], [m.saleStep, row.sale_step], [m.price, row.sale_unit_price_nok], [m.minimumStock, row.minimum_stock], [m.datasheet, row.datasheet_url ?? '–'], [m.purchaseUrl, row.purchase_url ?? '–'], [m.stateFilter, row.is_active ? m.active : m.inactive]];
	}
</script>
<svelte:head>{#if !oncreated}<title>{productCode ? `${productCode} | ${m.title}` : m.title}</title>{/if}</svelte:head>
<svelte:window onfocus={revalidateStock} ononline={revalidateStock} />
<svelte:document onvisibilitychange={revalidateStock} />
{#if !oncreated}
<div class={[pageHeader, 'product-editor-heading grid-cols-[minmax(0,1fr)_auto] items-center']}>
	<div class="row-span-2 grid min-w-0 justify-items-start gap-1">
		<h1 class={pageHeading}>{productCode ?? (id === 'new' ? m.newProduct : m.editProduct)}</h1>
		{#if product}<p class={[lede, nameWrap]}>{productName(product, i18n.locale)}</p>{/if}
		{#if product?.is_active}<Button variant="link" size="sm" href={i18n.href(`/p/${product.code}`)}>{m.publicProduct}<Icon icon={ArrowUpRightIcon} data-icon="inline-end" /></Button>{/if}
	</div>
	<div class="w-16 justify-self-center lg:w-20"><CategoryGraphic category={productCategory} /></div>
	{#if product && references}<LabelPrintButton {product} {references} />{/if}
</div>
{/if}
{#if pending && (!ownPending || wrongIdentity)}
	<div class="mb-6 grid justify-items-start gap-1">
		<Alert.Message appearance="inline" variant={wrongIdentity ? 'destructive' : 'default'} role="status">{wrongIdentity ? m.wrongIdentity : m.pending}</Alert.Message>
		{#if !wrongIdentity}<Button variant="link" href={i18n.href(`/admin/products/${pending.payload.id}`)}>{m.resume}</Button>{/if}
	</div>
{/if}
{#if loading}
	<span class="sr-only" role="status">{m.loading}</span>
	<div class="min-h-128 space-y-5" aria-busy="true"><Skeleton class="h-12 w-48" /><Skeleton class="h-24 w-full" /><Skeleton class="h-40 w-full" /></div>
{:else if loadFailed}
	<div class="grid min-h-128 content-start justify-items-start gap-2"><Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button variant="outline" onclick={load}>{m.retry}</Button></div>
{:else if !ready}<p>{m.missing}</p>
{:else if references && !wrongIdentity}
	{#if product}
		<div class="product-stock mb-6 flex min-h-20 flex-wrap items-center justify-between gap-4">
			<div class="min-w-0 grow basis-56 text-sm" aria-live="polite">
				{#if stock}
					<p class="text-muted-foreground">{m.inventory}</p>
					<p class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class={['font-mono text-2xl font-semibold', stockLevel === 'out' ? 'text-destructive' : stockLevel === 'low' ? 'rounded-md bg-warning px-1.5 text-on-warning' : 'text-foreground']}>{formatDecimal(stock.quantity, i18n.locale)} {unitLabel(product.unit_code, i18n.locale, stock.quantity)}</span>
						<StockBadge quantity={stock.quantity} unit={unitLabel(product.unit_code, i18n.locale)} minimum={product.minimum_stock} showQuantity={false} />
					</p>
					<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">{stock.last_counted_at ? `${m.lastCount}: ${formatCountedAt(stock.last_counted_at, i18n.locale)}` : m.neverCounted}{#if onOrder}<Badge variant="outline">{m.onOrder(`${formatDecimal(onOrder, i18n.locale)} ${unitLabel(product.unit_code, i18n.locale, onOrder)}`)}</Badge>{/if}</p>
				{:else if stockLoading}<span class="sr-only" role="status">{m.loading}</span><Skeleton class="h-16 w-40" />
				{:else}<div class="grid justify-items-start gap-2"><Alert.Message appearance="inline" variant="destructive" role="status">{m.inventoryUnavailable}</Alert.Message><Button variant="outline" size="sm" onclick={refreshStock}>{m.retry}</Button></div>{/if}
			</div>
			<div class="grid shrink-0 justify-items-start gap-1 md:justify-items-end"><CountForm modal {product} onsaved={refreshStock} /><Button variant="link" size="sm" href={i18n.href(`/admin/stock?product=${product.id}`)}>{m.stockLedger}</Button></div>
		</div>
	{/if}
	<Tabs.Root value="details">
		{#if product}
			<Tabs.List aria-label={product.code}>
				<Tabs.Trigger value="details">{i18n.m.adminStatistics.details}</Tabs.Trigger>
				<Tabs.Trigger value="statistics">{i18n.m.adminStatistics.heading}</Tabs.Trigger>
			</Tabs.List>
		{/if}
		<Tabs.Content value="details">
			<form id="product-form" class={formLayout} onsubmit={save}>
				<section class="space-y-4" aria-labelledby="product-identity-title">
					<h2 class={sectionHeading} id="product-identity-title">{m.identity}</h2>
					<div class={formGrid}>
						{#if categoryCards}
							<Field.Set class="col-span-full">
								<Field.Legend id="product-category-label" variant="label">{m.category} <span aria-hidden="true" class="text-destructive">*</span></Field.Legend>
								<RadioGroup.Root value={draft.category_id ?? ''} onValueChange={value => setCategory(value || null)} aria-labelledby="product-category-label" required disabled={blocked} class="grid-cols-2 md:grid-cols-4 lg:grid-cols-5">
									{#each categories as category (category.id)}
										{@const optionId = `product-category-${category.prefix.toLowerCase()}`}
										<Field.Label for={optionId}>
											<Field.Field orientation="horizontal" class="relative h-full flex-col items-stretch gap-1">
												<RadioGroup.Item id={optionId} value={category.id} class="absolute top-2 left-2 z-10" />
												<div class="mx-auto w-20"><CategoryGraphic category={category.name} /></div>
												<span class={[nameWrap, 'text-center text-sm']}>{m.typeNames[category.prefix]}</span>
											</Field.Field>
										</Field.Label>
									{/each}
								</RadioGroup.Root>
							</Field.Set>
						{:else}
							<Field.Field class="col-span-2">
								<Field.Label for="product-category" required={!keepUncategorized}>{m.category}</Field.Label>
								<NativeSelect.Root id="product-category" bind:value={() => draft.category_id ?? '', value => setCategory(value || null)} disabled={blocked} required={!keepUncategorized}>
									<option value="" disabled={!keepUncategorized}>{keepUncategorized ? m.noCategory : m.chooseCategory}</option>
									{#if legacyCategory}<option value={legacyCategory.id}>{categoryLabel(legacyCategory.name, i18n.locale)}</option>{/if}
									{#each categories as category (category.id)}<option value={category.id}>{m.typeNames[category.prefix]}</option>{/each}
								</NativeSelect.Root>
							</Field.Field>
						{/if}
						{#if !namesLocked}
							{#each nameFields as { field, locale } (field)}
								{@const id = `product-${field.replace('_', '-')}`}
								{@const prefix = lockedPrefix(field)}
								<Field.Field class={field === 'name_nb' ? 'col-span-2 col-start-1' : 'col-span-2'}>
									<Field.Label for={id} required>{field === 'name_nb' ? m.nameNb : m.nameEn}</Field.Label>
									<InputGroup.Root>
										{#if prefix}<InputGroup.Addon align="inline-start"><InputGroup.Text id={`${id}-prefix`} class="text-foreground">{prefix}</InputGroup.Text></InputGroup.Addon>{/if}
										<InputGroup.Input {id} placeholder={family ? messagesFor(locale).adminProducts.nameExamples[family] : undefined} required maxlength={200 - prefix.length}
											bind:value={() => draft[field].slice(prefix.length), rest => typeName(field, rest)} onchange={() => tidyName(field)}
											aria-invalid={invalidField === field} aria-describedby={[prefix && `${id}-prefix`, invalidField === field && `${id}-error`, 'product-name-hint'].filter(Boolean).join(' ')} disabled={blocked} />
									</InputGroup.Root>
									{#if invalidField === field}<Field.Error id={`${id}-error`}>{m.invalidName}</Field.Error>{/if}
								</Field.Field>
							{/each}
							<Field.Description id="product-name-hint" class="col-span-full">{m.nameHint}</Field.Description>
						{/if}
					</div>
				</section>
				{#if !namesLocked}
					{#if ownPending && pending?.attributes !== undefined}
						<ProductSpecificationRecovery command={pending} bind:definitions={references.definitions} family={family} disabled={busy}
							onreviewed={(command) => { pending = command; draft = { ...command.payload }; staged = command.attributes ?? []; void save(); }} />
					{:else}
						{#key attributeProductId}<ProductAttributes bind:this={attributesEditor} productId={attributeProductId} drafts={!(ownPending && pending?.revision === null)} bind:staged bind:definitions={references.definitions} family={family} disabled={blocked} />{/key}
					{/if}
					<section class={section({ spacing: 'divided' })} aria-labelledby="product-placement-section-title">
						<Separator />
						<h2 class={sectionHeading} id="product-placement-section-title">{m.placementHeading}</h2>
						<div class={formGrid}>
							<Field.Field class="col-span-2">
								<Field.Label id="product-placement-label" for="product-placement-trigger">{m.placement}</Field.Label>
								<Dialog.Root bind:open={placementOpen}>
									<Dialog.Trigger disabled={blocked}>
										{#snippet child({ props })}<button {...props} type="button" id="product-placement-trigger" class={cn(controlStyles, 'relative min-h-12 py-2 pr-9 pl-3 text-left', invalidField === 'bin_id' && 'border-destructive ring-3 ring-destructive/20')} aria-labelledby="product-placement-label product-placement-trigger" aria-describedby={invalidField === 'bin_id' ? 'product-placement-error' : undefined}>{draft.bin_id ? binLabel(draft.bin_id) : m.chooseDrawer}<Icon icon={CaretDownIcon} class="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" /></button>{/snippet}
									</Dialog.Trigger>
									<Dialog.Content variant="sheet" preventScroll={false} aria-describedby={undefined} class="placement-sheet">
										<Dialog.Header layout="bar">
											<Dialog.Title id="placement-sheet-title">{m.placement}</Dialog.Title>
											<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{m.closeDrawer}</span></Button>{/snippet}</Dialog.Close>
										</Dialog.Header>
										<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named sheet body supports native keyboard scrolling.) -->
										<div class={['placement-sheet-body', sheetBody]} role="region" aria-labelledby="placement-sheet-title" tabindex="0">
											<AdminAccessGate>
											<Field.Set id="product-placement" class="gap-3" aria-invalid={invalidField === 'bin_id'} aria-describedby={invalidField === 'bin_id' ? 'product-placement-error' : undefined}>
												<Field.Legend id="placement-title" class="sr-only">{m.placement}</Field.Legend>
												<p class="flex flex-wrap items-center gap-x-4 gap-y-1" aria-live="polite"><strong>{binLabel(draft.bin_id)}</strong>{#if draft.bin_id}<Button variant="ghost" disabled={blocked} onclick={() => draft.bin_id = null}>{m.clearPlacement}</Button>{/if}</p>
												<ShelfPlacementPicker topology={references.shelf} selected={draft.bin_id} disabled={blocked} onselect={selectPlacement} />
												<p class="text-sm"><a href={i18n.href('/admin/shelf')}>{m.manageShelf}</a></p>
											</Field.Set>
											</AdminAccessGate>
										</div>
										<AlertDialog.Root bind:open={moveOpen}>
											<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); (placementOpen ? placementTrigger : document.getElementById('product-placement-trigger'))?.focus({ preventScroll: true }); }}>
												<AlertDialog.Header>
													<AlertDialog.Title>{m.moveTitle}</AlertDialog.Title>
													<AlertDialog.Description aria-label={m.moveTitle}>{proposedPlacement ? m.moveDescription(binLabel(proposedPlacement.from), binLabel(proposedPlacement.to)) : ''}</AlertDialog.Description>
												</AlertDialog.Header>
												<AlertDialog.Footer>
													<AlertDialog.Cancel>{m.cancelMove}</AlertDialog.Cancel>
													<AlertDialog.Action disabled={blocked || admin.status !== 'ready'} onclick={confirmPlacement}>{m.confirmMove}</AlertDialog.Action>
												</AlertDialog.Footer>
											</AlertDialog.Content>
										</AlertDialog.Root>
									</Dialog.Content>
								</Dialog.Root>
								{#if invalidField === 'bin_id'}<Field.Error id="product-placement-error">{errorMessage('bin_id')}</Field.Error>{/if}
							</Field.Field>
							<!-- Its own cell: beside the drawer field from 48rem, below it on phones. -->
							{#if !draft.bin_id && !showNote}<Button variant="link" class="col-span-2 -mt-2 justify-self-start px-0" disabled={blocked} onclick={revealNote}>{m.notInDrawer}</Button>{/if}
							{#if showNote}
								<Field.Field class="col-span-full"><Field.Label for="product-location-note">{m.locationNote}</Field.Label><Input id="product-location-note" maxlength={200} bind:value={draft.location_note} aria-invalid={invalidField === 'location_note'} aria-describedby={invalidField === 'location_note' ? 'product-location-note-error product-location-note-hint' : 'product-location-note-hint'} disabled={blocked} /><Field.Description id="product-location-note-hint">{m.locationNoteHint}</Field.Description>{#if invalidField === 'location_note'}<Field.Error id="product-location-note-error">{m.invalid}</Field.Error>{/if}</Field.Field>
							{/if}
						</div>
					</section>
					<section class={section({ spacing: 'divided' })} aria-labelledby="product-sale-title">
						<Separator />
						<h2 class={sectionHeading} id="product-sale-title">{m.saleAndStock}</h2>
						<div class={formGrid}>
							<Field.Field><Field.Label for="product-select-4">{m.unit}</Field.Label><NativeSelect.Root id="product-select-4" bind:value={draft.unit_code} disabled={blocked || Boolean(product)}>{#each references.units as unit (unit.code)}<option value={unit.code}>{unitLabel(unit.code, i18n.locale)}</option>{/each}</NativeSelect.Root></Field.Field>
							<Field.Field><Field.Label for="product-stock-step" required={!product}>{m.stockStep} <span class="sr-only">({unitLabel(draft.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id="product-stock-step" aria-invalid={invalidField === 'stock_step'} aria-describedby={invalidField === 'stock_step' ? 'product-stock-step-error' : undefined} type="text" inputmode="decimal" required bind:value={draft.stock_step} disabled={blocked || Boolean(product)} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(draft.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{#if invalidField === 'stock_step'}<Field.Error id="product-stock-step-error">{errorMessage('stock_step')}</Field.Error>{/if}</Field.Field>
							<Field.Field><Field.Label for="product-sale-step" required>{m.saleStep} <span class="sr-only">({unitLabel(draft.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id="product-sale-step" aria-invalid={invalidField === 'sale_step'} aria-describedby={invalidField === 'sale_step' ? 'product-sale-step-error' : undefined} type="text" inputmode="decimal" required bind:value={draft.sale_step} disabled={blocked} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(draft.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{#if invalidField === 'sale_step'}<Field.Error id="product-sale-step-error">{errorMessage('sale_step')}</Field.Error>{/if}</Field.Field>
							<Field.Field><Field.Label for="product-price" required>{m.price} <span class="sr-only">(NOK)</span></Field.Label><InputGroup.Root><InputGroup.Input id="product-price" aria-invalid={invalidField === 'sale_unit_price_nok'} aria-describedby={invalidField === 'sale_unit_price_nok' ? 'product-price-error' : undefined} type="text" inputmode="decimal" required bind:value={draft.sale_unit_price_nok} disabled={blocked} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>NOK</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{#if invalidField === 'sale_unit_price_nok'}<Field.Error id="product-price-error">{errorMessage('sale_unit_price_nok')}</Field.Error>{/if}</Field.Field>
							<Field.Field><Field.Label for="product-minimum-stock" required>{m.minimumStock} <span class="sr-only">({unitLabel(draft.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id="product-minimum-stock" aria-invalid={invalidField === 'minimum_stock'} aria-describedby={invalidField === 'minimum_stock' ? 'product-minimum-stock-error product-minimum-stock-hint' : 'product-minimum-stock-hint'} type="text" inputmode="decimal" required bind:value={draft.minimum_stock} disabled={blocked} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(draft.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{#if invalidField === 'minimum_stock'}<Field.Error id="product-minimum-stock-error">{errorMessage('minimum_stock')}</Field.Error>{/if}</Field.Field>
							<Field.Description id="product-minimum-stock-hint" class="col-span-full">{m.minimumStockHint}</Field.Description>
							{#if !product}<Field.Description class="col-span-full">{m.immutable}</Field.Description>{/if}
							{#if !product && !oncreated}
								<Field.Field><Field.Label for="product-opening-stock">{m.openingStock} <span class="sr-only">({unitLabel(draft.unit_code, i18n.locale)})</span></Field.Label><InputGroup.Root><InputGroup.Input id="product-opening-stock" aria-invalid={openingInvalid} aria-describedby={openingInvalid ? 'product-opening-stock-error product-opening-stock-hint' : 'product-opening-stock-hint'} type="text" inputmode="decimal" autocomplete="off" bind:value={openingStock} disabled={blocked} /><InputGroup.Addon align="inline-end" aria-hidden="true"><InputGroup.Text>{unitLabel(draft.unit_code, i18n.locale)}</InputGroup.Text></InputGroup.Addon></InputGroup.Root>{#if openingInvalid}<Field.Error id="product-opening-stock-error">{i18n.m.adminCounts.invalidQuantity(draft.stock_step)}</Field.Error>{/if}</Field.Field>
								<Field.Description id="product-opening-stock-hint" class="col-span-full">{m.openingStockHint}</Field.Description>
							{/if}
						</div>
					</section>
					<Collapsible.Root bind:open={detailsOpen} class={section({ spacing: 'divided' })}>
						<Separator />
						<DisclosureTrigger>{m.descriptionAndLinks}</DisclosureTrigger>
						<Collapsible.Content class={formGrid}>
							<Field.Field class="col-span-full"><Field.Label for="product-description">{m.description}</Field.Label><Textarea id="product-description" rows={3} bind:value={draft.description} disabled={blocked} /></Field.Field>
							<Field.Field class="col-span-full"><Field.Label for="product-datasheet">{m.datasheet}</Field.Label><Input id="product-datasheet" aria-invalid={invalidField === 'datasheet_url'} aria-describedby={invalidField === 'datasheet_url' ? 'product-datasheet-error' : undefined} type="url" autocapitalize="none" enterkeyhint="go" bind:value={draft.datasheet_url} disabled={blocked} />{#if invalidField === 'datasheet_url'}<Field.Error id="product-datasheet-error">{errorMessage('datasheet_url')}</Field.Error>{/if}</Field.Field>
							<Field.Field class="col-span-full"><Field.Label for="product-purchase">{m.purchaseUrl}</Field.Label><Input id="product-purchase" aria-invalid={invalidField === 'purchase_url'} aria-describedby={invalidField === 'purchase_url' ? 'product-purchase-error' : undefined} type="url" autocapitalize="none" enterkeyhint="go" bind:value={draft.purchase_url} disabled={blocked} />{#if invalidField === 'purchase_url'}<Field.Error id="product-purchase-error">{errorMessage('purchase_url')}</Field.Error>{/if}</Field.Field>
						</Collapsible.Content>
					</Collapsible.Root>
					<Field.Field orientation="horizontal" class="min-h-12"><Switch id="product-active" bind:checked={draft.is_active} disabled={blocked} aria-describedby="product-active-hint" /><Field.Content><Field.Label for="product-active">{m.activeLabel}</Field.Label><Field.Description id="product-active-hint">{m.activeHint}</Field.Description></Field.Content></Field.Field>
					{#if id === 'new' && !product && canPrint}<Field.Field orientation="horizontal"><Checkbox id="product-print-label" bind:checked={printAfterSave} disabled={blocked} /><Field.Label for="product-print-label" class="cursor-pointer">{m.printLabelName}</Field.Label></Field.Field>{/if}
					<Button type="submit" class="justify-self-start" disabled={busy || !storageReady || Boolean(pending && !ownPending) || outcome === 'stale'}><ButtonLabel pending={busy} pendingLabel={m.working} label={ownPending ? m.retrySave : m.save} reserveLabels={[m.retrySave, m.save]} /></Button>
				{/if}
			</form>
			<div class={formStatus} aria-live="polite">
				{#if !storageReady}<Alert.Message appearance="inline" role={undefined} variant="destructive">{m.storage}</Alert.Message>
				{:else if outcome !== 'idle'}<Alert.Message appearance="inline" role={undefined} variant={outcome === 'saved' ? 'default' : 'destructive'}>{outcome === 'saved' ? m.saved : outcome === 'specificationsIncomplete' ? m.specificationsIncomplete : outcome === 'specificationsNotSaved' ? m.specificationsNotSaved : outcome === 'invalid' ? m.invalid : outcome === 'stale' ? m.stale : outcome === 'countPending' ? i18n.m.adminCounts.pendingElsewhere : outcome === 'openingNotCounted' ? m.openingNotCounted : outcome === 'unknown' ? m.unknown : outcome === 'storage' ? m.storage : m.failed}</Alert.Message>{/if}
			</div>
			{#if outcome === 'stale'}{#if reviewFailed}<Alert.Message appearance="inline" role="status" variant="destructive" class="mb-2">{m.unavailable}</Alert.Message>{/if}<Button variant="outline" disabled={busy} onclick={review}>{m.review}</Button>{/if}
			{#if current}
				<section class={section({ spacing: 'divided' })}><Separator /><h2 class={sectionHeading}>{m.currentValues}</h2><dl class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{#each comparable(current) as [label, value] (label)}<div class="min-w-0"><dt class="text-muted-foreground">{label}</dt><dd class="mt-1 break-words">{value}</dd></div>{/each}</dl><Button variant="outline" disabled={busy} onclick={useRevision}>{m.reviewed}</Button></section>
			{/if}
		</Tabs.Content>
		{#if product}
			<Tabs.Content value="statistics">
				<h2 class={sectionHeading}>{productName(product, i18n.locale)}</h2>
				<p class={[codeText, 'mb-4 text-muted-foreground']}>{product.code}</p>
				<AdminStatistics productId={product.id} unit={unitLabel(product.unit_code, i18n.locale)} />
			</Tabs.Content>
		{/if}
	</Tabs.Root>
{/if}
