<script lang="ts">
	import AdminAccessGate from '$lib/AdminAccessGate.svelte';
	import { productName } from '$lib/catalog';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import Icon from '$lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import DisclosureTrigger from '$lib/DisclosureTrigger.svelte';
	import StateBadge from '$lib/StateBadge.svelte';
	import { codeText, formActions, formLayout, formStatus, itemTitle, pageHeader, pageHeading, section, sectionHeading, sheetBody } from '$lib/ui';
	import * as Alert from '$lib/components/ui/alert';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import { Button, ButtonLabel } from '$lib/components/ui/button';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Menubar from '$lib/components/ui/menubar';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Input } from '$lib/components/ui/input';
	import * as Field from '$lib/components/ui/field';
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { getI18n } from '$lib/i18n';
	import { getAdminContext } from '$lib/admin-context.svelte';
	import { gridCell, gridRange } from '$lib/format';
	import ShelfDiagram from '$lib/ShelfDiagram.svelte';
	import ShelfLayoutEditor from '$lib/ShelfLayoutEditor.svelte';
	import ShelfPlacementPicker from '$lib/ShelfPlacementPicker.svelte';
	import { resizeLayout, type LayoutSize } from '$lib/shelf-layout';
	import { cabinetInner } from '$lib/shelf-map';
	import { readAdminShelf, shelfInteger, shelfColumn, readShelfCommand, saveShelfCommand, clearShelfCommand,
		executeShelfCommand, shelfFailure, type AdminShelf, type AdminCabinet, type AdminBin, type ShelfCommand } from '$lib/admin-shelf';
	const fieldId = $props.id();
	const shelfSection = section({ spacing: 'divided', class: 'shelf-section [&_h3]:mt-8' });

	const i18n = getI18n(), admin = getAdminContext();
	const m = $derived(i18n.m.adminShelf);
	let loadFailed = $state(false);
	let shelf = $state<AdminShelf | null>(null), busy = $state(false), storageReady = $state(false), needsRefresh = $state(false);
	let pending = $state<ShelfCommand | null>(null);
	let reviewCommand = $state<ShelfCommand | null>(null);
	let outcome = $state<'idle' | 'saved' | 'stale' | 'occupied' | 'fit' | 'notEmpty' | 'invalid' | 'unknown' | 'failed' | 'saveBeforeSwap'>('idle');
	let cabinetId = $state<string | null>(null), binId = $state<string | null>(null);
	let editor = $state<'cabinet' | 'bin' | null>(null);
	let editorMode = $state<'edit' | 'swap'>('edit');
	let detailsOpen = $state(false);
	let swapSource = $state<AdminBin | null>(null);
	let renameOpen = $state(false), drawerLabel = $state('');
	let confirmation = $state<ShelfCommand | null>(null);
	let confirmationTrigger: HTMLElement | null = null;
	let before = $state<AdminCabinet | AdminBin | null>(null);
	let description = $state(''), row = $state('1'), column = $state('A'), rows = $state('12'), cols = $state('4');
	let parentId = $state(''), swapId = $state('');
	let layoutId = $state(''), layoutBins = $state<AdminBin[]>([]), beforeBins = $state<AdminBin[]>([]);
	let layoutSize = $state<LayoutSize>({ rows: 12, cols: 4 }), layoutVersion = $state(0);
	const selectedDrawer = $derived(layoutBins.find((item) => item.id === binId));
	const inlineEditor = $derived(editor === 'cabinet' && Boolean(before && !before.is_archived) && editorMode === 'edit');
	const draftChanged = $derived(editor === 'cabinet' && Boolean(before && (JSON.stringify(layoutBins) !== JSON.stringify(beforeBins)
		|| layoutSize.rows !== (before as AdminCabinet).inner_rows || layoutSize.cols !== (before as AdminCabinet).inner_cols
		|| description !== (before.label ?? '') || row !== String((before as AdminCabinet).outer_row)
		|| column.toUpperCase() !== gridCell(1, (before as AdminCabinet).outer_col ?? 1).slice(0, -1))));
	const archivedCabinets = $derived(shelf?.cabinets.filter((item) => item.is_archived) ?? []);
	const archivedBins = $derived(shelf?.bins.filter((item) => item.is_archived) ?? []);
	const assignedIds = $derived(new Set(shelf?.products.flatMap((product) => product.bin_id ? [product.bin_id] : []) ?? []));
	const sizeUnreviewed = $derived(editor === 'cabinet' && (rows !== String(layoutSize.rows) || cols !== String(layoutSize.cols)));
	let alive = true;
	let editorTrigger: HTMLElement | null = null;
	let newCabinetButton = $state<HTMLButtonElement | null>(null);
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	const locked = $derived(admin.status !== 'ready' || busy || Boolean(pending) || Boolean(reviewCommand) || !storageReady || needsRefresh || loadFailed || !shelf);
	const currentReview = $derived.by(() => {
		const command = reviewCommand;
		if (!command) return undefined;
		const id = command.kind === 'archive-cabinet' ? command.before.id
			: command.kind === 'cabinet' || command.kind === 'layout' || command.kind === 'bin' ? command.after.id : command.first.id;
		return command.kind === 'archive-cabinet' || command.kind === 'cabinet' || command.kind === 'layout' || command.kind === 'swap-cabinets'
			? shelf?.cabinets.find((item) => item.id === id) : shelf?.bins.find((item) => item.id === id);
	});
	const cabinets = $derived([...(shelf?.live.cabinets ?? [])].sort((a, b) => b.outer_row - a.outer_row || a.outer_col - b.outer_col));
	const cabinet = $derived(cabinets.find((item) => item.id === cabinetId));
	const bins = $derived([...(shelf?.live.bins.filter((item) => item.cabinet_id === cabinetId) ?? [])]
		.sort((a, b) => b.inner_row - a.inner_row || a.inner_col - b.inner_col));
	const bin = $derived(bins.find((item) => item.id === binId));
	const assigned = $derived(shelf?.products.filter((item) => item.bin_id === binId) ?? []);
	const wallRows = $derived(cabinets.reduce((max, item) => Math.max(max, item.outer_row), 1));
	const wallCols = $derived(cabinets.reduce((max, item) => Math.max(max, item.outer_col), 1));
	const blockers = $derived(!before ? 0 : editor === 'cabinet'
		? (shelf?.bins.filter((item) => !item.is_archived && item.cabinet_id === before!.id).length ?? 0)
		: (shelf?.products.filter((item) => item.bin_id === before!.id).length ?? 0));
	const cabinetAssignments = $derived(editor === 'cabinet' && before ? (shelf?.products.filter((product) =>
		product.bin_id && shelf?.bins.some((item) => item.id === product.bin_id && !item.is_archived && item.cabinet_id === before!.id)).length ?? 0) : 0);
	const swapOptions = $derived(editor === 'cabinet' ? cabinets.filter((item) => item.id !== before?.id)
		: (shelf?.live.bins.filter((item) => item.id !== before?.id) ?? []));
	const swapTarget = $derived(swapOptions.find((item) => item.id === swapId));
	// The swap target is picked on the shelf graphic; the edited unit itself is
	// left out of the topology, so its own position shows as the empty slot.
	const swapTopology = $derived.by(() => {
		const live = shelf?.live ?? { cabinets: [], bins: [] };
		if (!before) return live;
		return editor === 'cabinet'
			? { cabinets: live.cabinets.filter((item) => item.id !== before!.id), bins: [] }
			: { cabinets: live.cabinets, bins: live.bins.filter((item) => item.id !== before!.id) };
	});
	const preview = $derived.by(() => {
		try {
			const r = shelfInteger(row), c = shelfColumn(column);
			return editor === 'cabinet' ? m.cabinet(gridCell(r, c))
				: `${cabinetName(parentId)} · ${m.bin(gridRange(r, c, shelfInteger(rows), shelfInteger(cols)))}`;
		} catch { return null; }
	});

	onMount(() => {
		try {
			pending = readShelfCommand(sessionStorage);
			const key = 'ampoteket:admin-shelf:probe'; sessionStorage.setItem(key, '1');
			if (sessionStorage.getItem(key) !== '1') throw new Error();
			sessionStorage.removeItem(key); storageReady = true;
			if (pending) { outcome = 'unknown'; if (pending.userId === admin.session?.user.id) restoreDraft(pending); }
		} catch { storageReady = false; }
		void load();
	});
	onDestroy(() => { alive = false; });
	function cabinetName(id: string | null): string {
		const value = shelf?.cabinets.find((item) => item.id === id);
		return value ? position(value) : m.chooseCabinet;
	}
	function position(value: AdminCabinet | AdminBin): string {
		if (value.is_archived) return m.archivedName('outer_row' in value ? m.cabinetKind : m.binKind, value.label || m.unnamed);
		if ('outer_row' in value) return m.cabinet(gridCell(value.outer_row!, value.outer_col!));
		return `${cabinetName(value.cabinet_id)} · ${m.bin(gridRange(value.inner_row!, value.inner_col!, value.row_span, value.col_span))}`;
	}
	function archivedLocation(value: AdminBin): string | null {
		const origin = shelf?.archivedLocations.get(value.id);
		if (!origin) return null;
		const cabinet = origin.cabinetOuterRow && origin.cabinetOuterCol
			? m.cabinet(gridCell(origin.cabinetOuterRow, origin.cabinetOuterCol))
			: origin.cabinetLabel || origin.cabinetCode;
		return `${cabinet} · ${m.bin(gridRange(origin.innerRow, origin.innerCol, origin.rowSpan, origin.colSpan))}`;
	}
	function summary(command: ShelfCommand) {
		if (command.kind === 'archive-cabinet') return m.archiveCabinetWithDrawersConfirm(command.beforeBins.length);
		if (command.kind === 'swap-cabinets' || command.kind === 'swap-bins') return m.swapPreview(position(command.first), position(command.second));
		return command.before ? m.pendingChange(position(command.before), command.after.is_archived ? m.archived : position(command.after))
			: m.pendingCreate(position(command.after));
	}
	async function load() {
		if (busy) return;
		// Reconciling after a rejected write keeps its explanation on screen.
		const reconciling = needsRefresh;
		busy = true;
		try {
			const session = admin.credentials(), result = await readAdminShelf(session);
			if (!alive || session.userId !== admin.session?.user.id) return;
			shelf = result; loadFailed = false; needsRefresh = false;
			if (!pending && !reconciling) outcome = 'idle';
		} catch (error) { if (alive) { loadFailed = true; if (!pending) outcome = 'failed'; } await admin.permissionFailure(error); }
		finally {
			if (alive) {
				busy = false;
				if (inlineEditor && !draftChanged && !locked && !reviewCommand) {
					const current = shelf?.cabinets.find((item) => item.id === before?.id && !item.is_archived);
					if (current) syncCabinet(current); else closeEditor(false);
				}
				settleRevalidation();
			}
		}
	}
	function syncCabinet(current: AdminCabinet) {
		before = { ...current }; description = current.label ?? '';
		row = String(current.outer_row); column = gridCell(1, current.outer_col!).slice(0, -1);
		rows = String(current.inner_rows); cols = String(current.inner_cols);
		layoutSize = { rows: current.inner_rows, cols: current.inner_cols };
		beforeBins = shelf!.bins.filter((item) => item.cabinet_id === current.id && !item.is_archived).map((item) => ({ ...item }));
		layoutBins = beforeBins.map((item) => ({ ...item }));
	}
	// The app owns freshness (design-system.md §4.2): re-read the map when the
	// tab becomes relevant again, never through a standing refresh button. An
	// dirty draft, modal editor or unresolved command keeps its reconciliation flow.
	// A read already in flight may predate the change that made the tab relevant
	// again, so a revalidation during it runs once more when it settles.
	let revalidateQueued = false;
	function revalidate() {
		if (admin.status !== 'ready' || document.visibilityState !== 'visible') return;
		// Decide once the in-flight work has settled: a save's own draft is not a user draft.
		if (busy) { revalidateQueued = true; return; }
		if (pending || reviewCommand || swapSource || (editor && (!inlineEditor || draftChanged))) return;
		void load();
	}
	function settleRevalidation() {
		if (!revalidateQueued || busy || !alive) return;
		revalidateQueued = false; revalidate();
	}
	$effect(() => {
		if (!editor && cabinet && !locked) untrack(() => {
			const status = outcome, trigger = editorTrigger;
			edit('cabinet', shelf!.cabinets.find((item) => item.id === cabinet!.id)!);
			outcome = status; editorTrigger = trigger;
		});
	});
	function selectCabinet(id: string) {
		if (locked || draftChanged || id === cabinetId) return;
		closeEditor(false); cabinetId = id; binId = null;
	}
	function edit(kind: 'cabinet' | 'bin', value: AdminCabinet | AdminBin | null) {
		if (locked || (kind === 'bin' && !value)) return;
		editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		editorMode = 'edit'; detailsOpen = !value || value.is_archived;
		editor = kind; before = value ? { ...value } : null; description = value?.label ?? ''; swapId = ''; outcome = 'idle';
		if (kind === 'cabinet') {
			const c = value as AdminCabinet | null;
			row = String(c?.outer_row ?? 1); column = gridCell(1, c?.outer_col ?? 1).slice(0, -1);
			rows = String(c?.inner_rows ?? 12); cols = String(c?.inner_cols ?? 4);
			layoutId = c?.id ?? crypto.randomUUID(); layoutSize = { rows: Number(rows), cols: Number(cols) };
			beforeBins = shelf!.bins.filter((bin) => bin.cabinet_id === c?.id && !bin.is_archived).map((bin) => ({ ...bin }));
			layoutBins = c ? beforeBins.map((bin) => ({ ...bin })) : resizeLayout([], layoutId, null, layoutSize, assignedIds);
			layoutVersion++;
		} else {
			const b = value as AdminBin | null;
			row = String(b?.inner_row ?? 1); column = gridCell(1, b?.inner_col ?? 1).slice(0, -1);
			rows = String(b?.row_span ?? 1); cols = String(b?.col_span ?? 1);
			parentId = b?.cabinet_id ?? cabinetId ?? cabinets[0]?.id ?? '';
		}
	}
	function restoreDraft(command: ShelfCommand) {
		// A failed restored request must keep its entered values just like a live form.
		if (editor && !(editor === 'cabinet' && (command.kind === 'swap-bins' || command.kind === 'bin'))) return;
		editorMode = command.kind === 'swap-cabinets' || command.kind === 'swap-bins' ? 'swap' : 'edit';
		const value = command.kind === 'archive-cabinet' ? command.before : command.kind === 'cabinet' || command.kind === 'layout' || command.kind === 'bin'
			? command.after.is_archived ? command.before! : command.after : command.first;
		editor = 'outer_row' in value ? 'cabinet' : 'bin';
		before = command.kind === 'archive-cabinet' || command.kind === 'cabinet' || command.kind === 'layout' || command.kind === 'bin' ? command.before : command.first;
		description = value.label ?? '';
		if ('outer_row' in value) {
			row = String(value.outer_row ?? 1); column = gridCell(1, value.outer_col ?? 1).slice(0, -1);
			rows = String(value.inner_rows); cols = String(value.inner_cols);
			layoutId = value.id; layoutSize = { rows: value.inner_rows, cols: value.inner_cols };
			beforeBins = command.kind === 'layout' || command.kind === 'archive-cabinet' ? command.beforeBins.map((bin) => ({ ...bin })) : [];
			layoutBins = command.kind === 'layout' ? command.bins.map((bin) => ({ ...bin })) : [];
			layoutVersion++;
		} else {
			row = String(value.inner_row ?? 1); column = gridCell(1, value.inner_col ?? 1).slice(0, -1);
			rows = String(value.row_span); cols = String(value.col_span); parentId = value.cabinet_id ?? '';
		}
		if (command.kind === 'swap-cabinets' || command.kind === 'swap-bins') swapId = command.second.id;
	}
	function reviewPlacement() {
		if (busy || needsRefresh || !currentReview) return;
		if (editor === 'cabinet') {
			const current = currentReview as AdminCabinet;
			if (reviewCommand?.kind === 'layout') {
				description = current.label ?? ''; row = String(current.outer_row ?? 1); column = gridCell(1, current.outer_col ?? 1).slice(0, -1);
			}
			rows = String(current.inner_rows); cols = String(current.inner_cols);
			layoutId = current.id; layoutSize = { rows: current.inner_rows, cols: current.inner_cols };
			beforeBins = shelf!.bins.filter((bin) => bin.cabinet_id === current.id && !bin.is_archived).map((bin) => ({ ...bin }));
			layoutBins = beforeBins.map((bin) => ({ ...bin })); layoutVersion++;
		} else {
			const current = currentReview as AdminBin; rows = String(current.row_span); cols = String(current.col_span);
		}
		before = { ...currentReview }; reviewCommand = null; outcome = 'idle';
	}
	function closeEditor(restoreFocus = document.activeElement?.matches(':focus-visible') ?? false) {
		editor = null; before = null; reviewCommand = null;
		if (restoreFocus && !cabinet) void tick().then(() => {
			if (alive) (editorTrigger?.isConnected ? editorTrigger : newCabinetButton)?.focus({ preventScroll: true });
		});
	}
	async function run(command?: ShelfCommand) {
		if (admin.status !== 'ready' || busy || !storageReady || wrongIdentity || loadFailed) return;
		const restoreFocus = document.activeElement?.matches(':focus-visible') ?? false;
		let closed = false, savedInline = false;
		busy = true; outcome = 'idle';
		try {
			const session = admin.credentials();
			if (!pending) {
				if (!command || needsRefresh) throw new Error();
				try { pending = saveShelfCommand(sessionStorage, command); }
				catch (error) { storageReady = false; throw error; }
			}
			const saved = readShelfCommand(sessionStorage);
			if (!saved || saved.userId !== session.userId || JSON.stringify(saved) !== JSON.stringify(pending)) throw new Error();
			const result = await executeShelfCommand(session, saved);
			if (!alive || session.userId !== admin.session?.user.id) return;
			clearShelfCommand(sessionStorage, saved); pending = null;
			outcome = result;
			if (result !== 'stale') swapSource = null;
			if (result === 'stale') {
				if (saved.kind !== 'archive-cabinet') { restoreDraft(saved); reviewCommand = saved; }
				needsRefresh = true; return;
			}
			if (saved.kind === 'swap-bins' || saved.kind === 'swap-cabinets') {
				toast.success(m.positionsSwapped, { description: summary(saved) }); outcome = 'idle';
			}
			if (inlineEditor) savedInline = true;
			else { closeEditor(false); closed = true; }
			// This is display refresh after acknowledgement, never a new write.
			try { const refreshed = await readAdminShelf(session); if (alive && session.userId === admin.session?.user.id) { shelf = refreshed; loadFailed = false; } }
			catch (error) { loadFailed = true; needsRefresh = true; await admin.permissionFailure(error); }
		} catch (error) {
			if (!alive) return;
			const failure = shelfFailure(error);
			if (failure && pending) {
				try {
					const saved = pending; clearShelfCommand(sessionStorage, saved); pending = null; restoreDraft(saved); outcome = failure;
					needsRefresh = failure !== 'invalid';
					// A fresh read never silently changes the original guards. The user reviews
					// the current placement before applying their retained draft to it.
					if (needsRefresh && saved.kind !== 'archive-cabinet' && (saved.kind === 'swap-bins' || saved.kind === 'swap-cabinets' || saved.before)) reviewCommand = saved;
				}
				catch { outcome = 'unknown'; storageReady = false; }
			} else outcome = pending ? 'unknown' : 'failed';
			await admin.permissionFailure(error);
		} finally {
			if (alive) {
				busy = false;
				if (savedInline && shelf && !loadFailed) {
					const current = shelf.cabinets.find((item) => item.id === before?.id && !item.is_archived);
					if (current) syncCabinet(current); else closeEditor(false);
				}
				if (closed && restoreFocus) closeEditor(true);
				// The app reconciles the map itself (design-system.md §4.2); the retained
				// draft waits for the explicit placement review below.
				if (needsRefresh) void load(); else settleRevalidation();
			}
		}
	}
	function actor() { return { userId: admin.credentials().userId, requestId: crypto.randomUUID() }; }
	function save(event: SubmitEvent) {
		event.preventDefault(); if (locked || !editor || !shelf) return;
		try {
			const id = before?.id ?? layoutId, code = before?.code ?? `${editor === 'cabinet' ? 'C' : 'B'}-${id}`;
			const common = { id, code, label: description.trim() || null, is_archived: false };
			if (editor === 'cabinet') {
				if (sizeUnreviewed) throw new Error();
				const after: AdminCabinet = { ...common, outer_row: shelfInteger(row), outer_col: shelfColumn(column), inner_rows: layoutSize.rows, inner_cols: layoutSize.cols };
				void run({ ...actor(), kind: 'layout', before: before as AdminCabinet | null, beforeBins, after, bins: layoutBins });
			} else {
				if (!shelf.live.cabinets.some((item) => item.id === parentId)) throw new Error();
				const after: AdminBin = { ...common, cabinet_id: parentId, inner_row: shelfInteger(row), inner_col: shelfColumn(column), row_span: shelfInteger(rows), col_span: shelfInteger(cols) };
				void run({ ...actor(), kind: 'bin', before: before as AdminBin, after });
			}
		} catch { outcome = 'invalid'; }
	}
	function confirm(command: ShelfCommand) {
		confirmationTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		confirmation = command;
	}
	function canSwapDraft() {
		if (editor === 'cabinet' && (!before || draftChanged)) { outcome = 'saveBeforeSwap'; return false; }
		return true;
	}
	function dragSwap(firstId: string, secondId: string) {
		if (locked || !canSwapDraft()) return;
		const first = swapSource?.id === firstId ? swapSource : shelf!.bins.find((item) => item.id === firstId && !item.is_archived);
		const second = shelf!.bins.find((item) => item.id === secondId && !item.is_archived);
		if (first && second && first.id !== second.id) confirm({ ...actor(), kind: 'swap-bins', first: { ...first }, second: { ...second } });
	}
	function pickSwap(id: string) {
		const source = shelf?.bins.find((item) => item.id === id);
		if (locked || !source || !canSwapDraft()) return;
		swapSource = { ...source };
		void tick().then(() => document.querySelector<HTMLElement>(`[data-cabinet-editor] [data-item-id="${id}"]`)?.focus({ preventScroll: true }));
	}
	function selectDrawer(id: string) {
		binId = id;
		if (swapSource) { if (id !== swapSource.id) dragSwap(swapSource.id, id); }
	}
	function moveToEmpty(inner_row: number, inner_col: number) {
		if (locked || !swapSource || !cabinetId || !canSwapDraft()) return;
		confirm({ ...actor(), kind: 'bin', before: { ...swapSource }, after: { ...swapSource, cabinet_id: cabinetId, inner_row, inner_col } });
	}
	function drawerDetails(changes: Pick<AdminBin, 'label'>) {
		if (locked || !selectedDrawer) return;
		layoutBins = layoutBins.map((item) => item.id === binId ? { ...item, ...changes } : item);
	}
	function archiveDrawer() {
		if (locked || draftChanged || !binId || assignedIds.has(binId)) return;
		const current = shelf?.bins.find((item) => item.id === binId && !item.is_archived);
		if (current) confirm({ ...actor(), kind: 'bin', before: { ...current }, after: { ...current, is_archived: true, cabinet_id: null, inner_row: null, inner_col: null } });
	}
	function archive() {
		if (locked || !before || before.is_archived || draftChanged || (editor === 'cabinet' ? cabinetAssignments : blockers)) return;
		if (editor === 'cabinet') {
			const current = before as AdminCabinet;
			const liveBins = shelf?.bins.filter((item) => !item.is_archived && item.cabinet_id === current.id) ?? [];
			confirm({ ...actor(), kind: 'archive-cabinet', before: { ...current }, beforeBins: liveBins.map((item) => ({ ...item })) });
		} else {
			const current = before as AdminBin;
			confirm({ ...actor(), kind: 'bin', before: current, after: { ...current, is_archived: true, cabinet_id: null, inner_row: null, inner_col: null } });
		}
	}
	function swap() {
		if (locked || !before || !swapTarget || before.is_archived) return;
		if (editor === 'cabinet') confirm({ ...actor(), kind: 'swap-cabinets', first: before as AdminCabinet,
			second: shelf!.cabinets.find((item) => item.id === swapTarget.id)! });
		else confirm({ ...actor(), kind: 'swap-bins', first: before as AdminBin,
			second: shelf!.bins.find((item) => item.id === swapTarget.id)! });
	}
</script>

{#snippet storageStatus()}
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
	{:else if outcome !== 'idle'}<Alert.Message appearance="inline" variant={outcome === 'saved' ? 'default' : 'destructive'} role="status">{m[outcome]}</Alert.Message>{/if}
{/snippet}

{#snippet storageEditor(inline = false)}
{#if editor}
	{#if inline}
		<h2 class={sectionHeading} id="cabinet-title">{m.cabinetMap(gridCell((before as AdminCabinet).outer_row!, (before as AdminCabinet).outer_col!))}</h2>
		<Menubar.Root aria-label={m.drawerActions} class="my-3 w-fit max-w-full">
			<Menubar.Menu>
				<Menubar.Trigger disabled={locked || !selectedDrawer || Boolean(swapSource)}>{m.binKind}</Menubar.Trigger>
				<Menubar.Content>
					<Menubar.Item disabled={draftChanged} onSelect={() => { if (binId) pickSwap(binId); }}>{m.moveDrawer}</Menubar.Item>
					<Menubar.Item onSelect={() => { drawerLabel = selectedDrawer?.label ?? ''; renameOpen = true; }}>{m.renameDrawer}</Menubar.Item>
					<Menubar.Separator />
					<Menubar.Item variant="destructive" disabled={draftChanged || !binId || assignedIds.has(binId)} onSelect={archiveDrawer}>{m.archiveBin}</Menubar.Item>
				</Menubar.Content>
			</Menubar.Menu>
		</Menubar.Root>
		{#if swapSource}<div class="flex flex-wrap items-center gap-3" role="status"><p>{m.chooseSwap}</p><Button variant="outline" onclick={() => swapSource = null}>{m.cancelAction}</Button></div>{/if}
	{:else}
		<Dialog.Header layout="bar">
			<Dialog.Title>{editorMode === 'swap' ? m.swapHeading : before ? position(before) : m.newCabinet}</Dialog.Title>
			<Dialog.Close disabled={busy}>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{m.cancel}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named dialog editor region supports native keyboard scrolling.) -->
	<div class={inline ? 'min-w-0' : ['shelf-editor-body', sheetBody]} role={inline ? undefined : 'region'} aria-label={inline ? undefined : editorMode === 'swap' ? m.swapHeading : m.layoutHeading} tabindex={inline ? undefined : 0}>
		<AdminAccessGate active={!inline}>
		{#if !inline}<Dialog.Description class="sr-only">{m.moveHint}</Dialog.Description>{/if}

		{#if reviewCommand}
			<p>{summary(reviewCommand)}</p><p>{reviewCommand.kind === 'layout' ? m.reviewLayoutHint : m.reviewHint}</p>
			{#if currentReview}<p>{m.currentPlacement(position(currentReview))}</p>{/if}
			{#if needsRefresh && !busy}<Alert.Message appearance="inline" variant="destructive" role="status" class="mt-4">{m.unavailable}</Alert.Message>{/if}
			<div class={[formActions, 'my-4']}>
				{#if needsRefresh && !busy}<Button type="button" variant="outline" onclick={load}>{m.retryLoad}</Button>{/if}
				<Button type="button" variant="outline" disabled={busy || needsRefresh || !currentReview} onclick={reviewPlacement}>{reviewCommand.kind === 'layout' ? m.reviewLayout : m.reviewPlacement}</Button>
			</div>
		{/if}
		{#if editorMode === 'edit'}
		<form id="shelf-editor-form" class={formLayout} onsubmit={save}>
			{#if editor === 'cabinet'}
				{#key layoutVersion}<ShelfLayoutEditor initialSelected={binId ?? ''} onselect={selectDrawer} moving={Boolean(swapSource)} onempty={moveToEmpty} cabinetId={layoutId} bind:bins={layoutBins} bind:size={layoutSize}
					bind:rowsText={rows} bind:colsText={cols} original={beforeBins} assigned={assignedIds} disabled={locked} onswap={dragSwap} onswapselect={pickSwap} />{/key}
			{:else if before && 'row_span' in before}<p>{m.drawerSize(before.row_span, before.col_span)}</p>{/if}
			<Collapsible.Root bind:open={detailsOpen}>
				<DisclosureTrigger>{m.details}</DisclosureTrigger>
				<Collapsible.Content class="space-y-4 pt-3">
					<Field.Group layout="row">
						<Field.Field width="grow"><Field.Label for={`${fieldId}-1`}>{m.label}</Field.Label><Input id={`${fieldId}-1`} bind:value={description} disabled={locked} /></Field.Field>
						<Field.Field width="short"><Field.Label for={`${fieldId}-2`}>{m.row}</Field.Label><Input id={`${fieldId}-2`} required inputmode="numeric" pattern="[1-9][0-9]*" bind:value={row} disabled={locked} /></Field.Field>
						<Field.Field width="short"><Field.Label for={`${fieldId}-3`}>{m.column}</Field.Label><Input id={`${fieldId}-3`} class="font-mono" required pattern="[A-Za-z]+" autocapitalize="characters" bind:value={column} disabled={locked} /></Field.Field>
					</Field.Group>
					{#if editor === 'bin'}
						<Field.Set class="picker-group my-4 grid min-w-0 justify-items-start gap-3 [&_.placement-picker]:justify-self-stretch" aria-labelledby="parent-cabinet-title">
							<Field.Legend variant="label" id="parent-cabinet-title">{m.chooseCabinet}</Field.Legend>
							<ShelfPlacementPicker topology={shelf?.live ?? { cabinets: [], bins: [] }} pick="cabinet" selected={parentId || null} disabled={locked} onselect={(id) => { parentId = id; }} />
						</Field.Set>
					{/if}
					<Field.Description class="my-0 min-h-12">{preview ? m.placementPreview(preview) : m.invalid}</Field.Description>
					{#if before && !before.is_archived}
						<div class={formActions}><Button type="button" variant="outline" disabled={locked} onclick={() => { if (canSwapDraft()) editorMode = 'swap'; }}>{editor === 'cabinet' ? m.moveCabinet : m.swapHeading}</Button>
						<Button type="button" variant="outline" disabled={locked || (editor === 'cabinet' ? cabinetAssignments > 0 || draftChanged : blockers > 0)} onclick={archive}>{editor === 'cabinet' ? m.archiveCabinetWithDrawers : m.archiveBin}</Button></div>
						{#if editor === 'cabinet' && cabinetAssignments}<p class="text-sm text-muted-foreground">{m.cabinetAssignedBlocked(cabinetAssignments)}</p>
						{:else if editor === 'bin' && blockers}<p class="text-sm text-muted-foreground">{m.binBlocked(blockers)}</p>{/if}
					{/if}
				</Collapsible.Content>
			</Collapsible.Root>
		</form>
		{/if}
		{#if pending && !wrongIdentity}
			<h3>{m.pendingHeading}</h3><p>{summary(pending)}</p>
			<Button type="button" variant="outline" disabled={admin.status !== 'ready' || busy || !storageReady} onclick={() => run()}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.retry} /></Button>
		{/if}
		{#if before && !before.is_archived && editorMode === 'swap'}
			<p>{m.swapHint}</p>
			<Field.Set class="picker-group my-4 grid min-w-0 justify-items-start gap-3 [&_.placement-picker]:justify-self-stretch" aria-labelledby="swap-target-title">
				<Field.Legend variant="label" id="swap-target-title">{m.swapTarget}</Field.Legend>
				<ShelfPlacementPicker topology={swapTopology} pick={editor === 'cabinet' ? 'cabinet' : 'bin'} selected={swapId || null} disabled={locked} onselect={(id) => { swapId = id; }} />
				<Field.Description class="my-0 min-h-12" aria-live="polite">{swapTarget ? m.swapPreview(position(before), position({ ...swapTarget, is_archived: false })) : m.chooseSwap}</Field.Description>
				<Button type="button" disabled={locked || !swapTarget} onclick={swap}>{m.swap}</Button>
			</Field.Set>
		{/if}
		{#if inline}
			<div class={formStatus} aria-live="polite" aria-atomic="true">{@render storageStatus()}</div>
			<div class={formActions}>
				<Button form="shelf-editor-form" type="submit" disabled={locked || sizeUnreviewed || !draftChanged}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.save} /></Button>
				{#if draftChanged}<Button type="button" variant="outline" disabled={locked} onclick={() => edit('cabinet', shelf!.cabinets.find((item) => item.id === before!.id)!)}>{m.discardChanges}</Button>{/if}
			</div>
		{/if}
		</AdminAccessGate>
	</div>
	{#if !inline}
		<Dialog.Footer variant="sheet" class="items-center">
			<div class="min-w-0 flex-1 text-sm" aria-live="polite" aria-atomic="true">{@render storageStatus()}</div>
			{#if editorMode === 'edit'}<Button form="shelf-editor-form" type="submit" disabled={locked || sizeUnreviewed}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.save} /></Button>{/if}
		</Dialog.Footer>
	{/if}
{/if}
{/snippet}

<svelte:head><title>{m.title}</title></svelte:head>
<Toaster position="bottom-center" closeButton containerAriaLabel={m.notifications} closeButtonAriaLabel={m.dismissNotification} />
<svelte:window onfocus={revalidate} ononline={revalidate} onkeydown={(event) => { if (event.key === 'Escape' && swapSource && !confirmation) { swapSource = null; event.preventDefault(); } }} />
<svelte:document onvisibilitychange={revalidate} />
<div class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<div class={formActions}><Button type="button" bind:ref={newCabinetButton} disabled={locked || draftChanged} onclick={() => edit('cabinet', null)}>{m.newCabinet}</Button></div>
</div>
<div class={formStatus} aria-live="polite" aria-atomic="true">
	{#if !editor}
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
	{:else if outcome !== 'idle'}<Alert.Message appearance="inline" variant={(outcome !== 'saved') ? 'destructive' : 'default'} role="status">{m[outcome]}</Alert.Message>
	{/if}
	{/if}
</div>

{#if pending && !wrongIdentity && !editor}
	<section class={shelfSection} aria-labelledby="pending-title"><Separator /><h2 class={sectionHeading} id="pending-title">{m.pendingHeading}</h2>
		<p>{summary(pending)}</p><Button type="button" variant="default" disabled={admin.status !== 'ready' || busy || !storageReady} onclick={() => run()}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.retry} /></Button>
	</section>
{/if}
{#if shelf && loadFailed}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" disabled={busy} onclick={load}>{m.retryLoad}</Button>{/if}
{#if !shelf}
	{#if busy}<span class="sr-only" role="status">{m.loading}</span>{/if}
	<section class={shelfSection} aria-busy={busy}>
		<Separator />
		<h2 class={sectionHeading}>{m.wall}</h2>
		<div class="grid min-h-80 content-start justify-items-start gap-2">
			{#if busy}<Skeleton class="h-80 w-full justify-self-stretch" aria-hidden="true" />
			{:else}<Alert.Message appearance="inline" variant="destructive" role="status">{m.unavailable}</Alert.Message><Button type="button" variant="outline" onclick={load}>{m.retryLoad}</Button>{/if}
		</div>
	</section>
{:else}
	<section class={shelfSection} aria-labelledby="wall-title"><Separator /><h2 class={sectionHeading} id="wall-title">{m.wall}</h2>
		{#if cabinets.length}
			<ShelfDiagram rows={wallRows} cols={wallCols} items={cabinets.map((item) => ({ id: item.id, row: item.outer_row, col: item.outer_col, label: gridCell(item.outer_row, item.outer_col), inner: cabinetInner(item, shelf?.live.bins ?? []) }))}
				selected={cabinetId} label={m.wall} onselect={selectCabinet} disabled={locked || draftChanged} />
		{:else}<Empty.Root><Empty.Description>{m.noCabinets}</Empty.Description></Empty.Root>{/if}
	</section>
	{#if inlineEditor}
		<section data-cabinet-editor class={shelfSection} aria-labelledby="cabinet-title">
			<Separator />
			{@render storageEditor(true)}
		</section>
	{/if}
	{#if bin}
		<section class={shelfSection} aria-labelledby="bin-title"><Separator /><h2 class={sectionHeading} id="bin-title">{m.bin(gridRange(bin.inner_row, bin.inner_col, bin.row_span, bin.col_span))}</h2>
			{#if bin.label}<p>{bin.label}</p>{/if}
			<h3>{m.contents}</h3>
			{#if !assigned.length}<Empty.Root><Empty.Description>{m.noProducts}</Empty.Description></Empty.Root>
			{:else}
				<Item.Group>
					{#each assigned as product, index (product.id)}
						{#if index > 0}<Item.Separator />{/if}
						<Item.Root variant="row" role="listitem">
							<Item.Content>
							<Item.Title class={itemTitle}><a href={i18n.href(`/admin/products/${product.id}`)}>{productName(product, i18n.locale)}</a></Item.Title>
							<Item.Description class="flex flex-wrap items-center gap-x-3 gap-y-1"><span class={codeText}>{product.code}</span>{#if !product.is_active}<StateBadge tone="neutral">{m.inactive}</StateBadge>{/if}</Item.Description>
							</Item.Content>
						</Item.Root>
					{/each}
				</Item.Group>
			{/if}
		</section>
	{/if}
	<!-- Only when something is archived: an empty disclosure would open to nothing to do. -->
	{#if archivedCabinets.length || archivedBins.length}
	<Collapsible.Root class={section({ spacing: 'divided', class: 'mb-8' })}>
		<Separator />
		<DisclosureTrigger>{m.archivedHeading}</DisclosureTrigger>
		<Collapsible.Content>
		<Item.Group class="[&_.shelf-section]:basis-full [&_.shelf-section]:min-w-0">
			{#each archivedCabinets as item, index (item.id)}
				{#if index > 0}<Item.Separator />{/if}
				<Item.Root variant="row" role="listitem">
					<Item.Content><Item.Title class={itemTitle}>{position(item)}</Item.Title></Item.Content>
					<Item.Actions><Button type="button" variant="outline" size="sm" disabled={locked || draftChanged} onclick={() => edit('cabinet', item)}>{m.reactivateCabinet}</Button></Item.Actions>

				</Item.Root>
			{/each}
			{#each archivedBins as item, index (item.id)}
				{#if index > 0 || archivedCabinets.length}<Item.Separator />{/if}
				<Item.Root variant="row" role="listitem">
					<Item.Content><Item.Title class={itemTitle}>{item.label || m.binKind}</Item.Title><Item.Description class="flex flex-wrap gap-x-3 gap-y-1">{#if archivedLocation(item)}<span>{m.archivedFrom(archivedLocation(item)!)}</span>{/if}<span class={[codeText, 'break-all']}>{item.code}</span></Item.Description></Item.Content>
					<Item.Actions><Button type="button" variant="outline" size="sm" disabled={locked || draftChanged || !cabinets.length} onclick={() => edit('bin', item)}>{m.reactivateBin}</Button></Item.Actions>

				</Item.Root>
			{/each}
		</Item.Group>
		</Collapsible.Content>
	</Collapsible.Root>
	{/if}
{/if}

<Dialog.Root open={editor !== null && !inlineEditor} onOpenChange={(open) => { if (!open && !busy) closeEditor(); }}>
	<Dialog.Content variant="sheet" preventScroll={false}
		onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
		onEscapeKeydown={(event) => { if (busy || document.querySelector('[data-resizing="true"]')) event.preventDefault(); }}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			void tick().then(() => {
				const target = editorTrigger?.isConnected ? editorTrigger
					: document.querySelector<HTMLElement>('[data-cabinet-editor] .drawer-move-handle') ?? newCabinetButton;
				target?.focus({ preventScroll: true });
			});
		}}>
		{@render storageEditor()}
	</Dialog.Content>
</Dialog.Root>
<AlertDialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) confirmation = null; }}>
	<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); confirmationTrigger?.focus({ preventScroll: true }); }}>
		<AlertDialog.Header>
			<AlertDialog.Title id={`${fieldId}-confirmation-title`}>{confirmation?.kind === 'swap-bins' || confirmation?.kind === 'swap-cabinets' ? m.swapHeading : confirmation?.kind === 'bin' && !confirmation.after.is_archived ? m.moveDrawer : confirmation?.kind === 'archive-cabinet' ? m.archiveCabinetWithDrawers : confirmation?.kind === 'cabinet' ? m.archiveCabinet : m.archiveBin}</AlertDialog.Title>
			<AlertDialog.Description aria-labelledby={`${fieldId}-confirmation-title`}>
				<span class="block">{confirmation ? summary(confirmation) : ''}</span>
				<span class="mt-3 block text-foreground">{confirmation?.kind === 'swap-bins' || confirmation?.kind === 'swap-cabinets' ? m.swapHint : confirmation?.kind === 'bin' && !confirmation.after.is_archived ? m.moveHint : m.archiveHint}</span>
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.cancelAction}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={locked} onclick={() => { const command = confirmation; confirmation = null; if (command) void run(command); }}>{m.confirmAction}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root bind:open={renameOpen}>
	<Dialog.Content preventScroll={false} aria-describedby={undefined} class="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
		<Dialog.Header layout="bar">
			<Dialog.Title id={`${fieldId}-rename-title`}>{m.renameDrawer}</Dialog.Title>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{m.cancel}</span></Button>{/snippet}</Dialog.Close>
		</Dialog.Header>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named dialog body supports native keyboard scrolling.) -->
		<div class={sheetBody} role="region" aria-labelledby={`${fieldId}-rename-title`} tabindex="0">
			<AdminAccessGate><form id={`${fieldId}-rename-form`} class={formLayout} onsubmit={(event) => { event.preventDefault(); if (locked) return; drawerDetails({ label: drawerLabel.trim() || null }); renameOpen = false; }}>
				<Field.Field><Field.Label for={`${fieldId}-drawer-label`}>{m.label}</Field.Label><Input id={`${fieldId}-drawer-label`} bind:value={drawerLabel} disabled={locked} /></Field.Field>
			</form></AdminAccessGate>
		</div>
		<Dialog.Footer variant="sheet"><Button form={`${fieldId}-rename-form`} type="submit" disabled={locked}>{m.applyDrawerDetails}</Button></Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
