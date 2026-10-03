<script lang="ts">
	import AdminAccessGate from '#lib/AdminAccessGate.svelte';
	import { productName } from '#lib/catalog.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Icon from '#lib/Icon.svelte';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import StateBadge from '#lib/StateBadge.svelte';
	import { codeText, formActions, formLayout, formStatus, itemTitle, pageHeader, pageHeading, section, sectionHeading, sheetBody } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import { toast } from 'svelte-sonner';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { gridCell, gridRange } from '#lib/format.js';
	import ShelfDiagram from '#lib/ShelfDiagram.svelte';
	import ShelfLayoutEditor from '#lib/ShelfLayoutEditor.svelte';
	import ShelfPlacementPicker from '#lib/ShelfPlacementPicker.svelte';
	import { resizeLayout, type LayoutSize } from '#lib/shelf-layout.js';
	import { cabinetInner } from '#lib/shelf-map.js';
	import { readAdminShelf, shelfInteger, shelfColumn, readShelfCommand, saveShelfCommand, clearShelfCommand,
		executeShelfCommand, shelfFailure, type AdminShelf, type AdminCabinet, type AdminBin, type ShelfCommand } from '#lib/admin-shelf.js';
	import { readDraft, writeDraft } from '#lib/drafts.js';
	const fieldId = $props.id();
	const shelfSection = section({ spacing: 'divided', class: 'shelf-section' });

	const i18n = getI18n(), admin = getAdminContext();
	const m = $derived(i18n.m.adminShelf);
	let loadFailed = $state(false);
	let shelf = $state<AdminShelf | null>(null), busy = $state(false), storageReady = $state(false), needsRefresh = $state(false);
	let pending = $state<ShelfCommand | null>(null);
	let reviewCommand = $state<ShelfCommand | null>(null);
	let outcome = $state<'idle' | 'saved' | 'stale' | 'occupied' | 'fit' | 'notEmpty' | 'invalid' | 'unknown' | 'failed' | 'saveBeforeSwap'>('idle');
	let cabinetId = $state<string | null>(null), binId = $state<string | null>(null);
	// One cabinet editor: inline for a placed cabinet, a sheet for a new one or a move.
	let editor = $state(false);
	let editorMode = $state<'edit' | 'move'>('edit');
	let swapSource = $state<AdminBin | null>(null);
	let confirmation = $state<ShelfCommand | null>(null);
	let confirmationTrigger: HTMLElement | null = null;
	let before = $state<AdminCabinet | null>(null);
	// Wall position, typed only for a new cabinet; placed cabinets move through the wall picker.
	let row = $state('1'), column = $state('A');
	let moveId = $state('');
	let layoutId = $state(''), layoutBins = $state<AdminBin[]>([]), beforeBins = $state<AdminBin[]>([]);
	let layoutSize = $state<LayoutSize>({ rows: 12, cols: 4 }), layoutVersion = $state(0);
	let layoutEditor = $state<ReturnType<typeof ShelfLayoutEditor>>();
	const selectedDrawer = $derived(layoutBins.find((item) => item.id === binId));
	const inlineEditor = $derived(editor && Boolean(before) && editorMode === 'edit');
	const draftChanged = $derived(editor && Boolean(before && (JSON.stringify(layoutBins) !== JSON.stringify(beforeBins)
		|| layoutSize.rows !== before.inner_rows || layoutSize.cols !== before.inner_cols)));
	const assignedIds = $derived(new Set(shelf?.products.flatMap((product) => product.bin_id ? [product.bin_id] : []) ?? []));
	let alive = true;
	let editorTrigger: HTMLElement | null = null;
	let newCabinetButton = $state<HTMLButtonElement | null>(null);
	const wrongIdentity = $derived(Boolean(pending && pending.userId !== admin.session?.user.id));
	const locked = $derived(admin.status !== 'ready' || busy || Boolean(pending) || Boolean(reviewCommand) || !storageReady || needsRefresh || loadFailed || !shelf);
	const currentReview = $derived.by(() => {
		const command = reviewCommand;
		return command?.kind === 'layout' ? shelf?.cabinets.find((item) => item.id === command.after.id) : undefined;
	});
	const cabinets = $derived([...(shelf?.live.cabinets ?? [])].sort((a, b) => b.outer_row - a.outer_row || a.outer_col - b.outer_col));
	const cabinet = $derived(cabinets.find((item) => item.id === cabinetId));
	// The saved drawer behind the selection; drafted drawers have no contents, moves or archive yet.
	const bin = $derived(before ? shelf?.live.bins.find((item) => item.id === binId && item.cabinet_id === before!.id) : undefined);
	const assigned = $derived(shelf?.products.filter((item) => item.bin_id === binId) ?? []);
	const wallRows = $derived(cabinets.reduce((max, item) => Math.max(max, item.outer_row), 1));
	const wallCols = $derived(cabinets.reduce((max, item) => Math.max(max, item.outer_col), 1));
	const cabinetAssignments = $derived(editor && before ? (shelf?.products.filter((product) =>
		product.bin_id && shelf?.bins.some((item) => item.id === product.bin_id && !item.is_archived && item.cabinet_id === before!.id)).length ?? 0) : 0);
	// A move target is a vacant wall position or another cabinet to swap with.
	const moveTarget = $derived.by(() => {
		const vacant = /^vacant:(\d+):(\d+)$/.exec(moveId);
		if (vacant) return { kind: 'vacant' as const, row: Number(vacant[1]), col: Number(vacant[2]) };
		const value = shelf?.cabinets.find((item) => item.id === moveId && item.id !== before?.id && !item.is_archived);
		return value ? { kind: 'cabinet' as const, cabinet: value } : undefined;
	});
	const preview = $derived.by(() => {
		try { return m.cabinet(gridCell(shelfInteger(row), shelfColumn(column))); } catch { return null; }
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
		return value ? position(value) : m.archived;
	}
	function position(value: AdminCabinet | AdminBin): string {
		if (value.is_archived) return m.archived;
		if ('outer_row' in value) return m.cabinet(gridCell(value.outer_row!, value.outer_col!));
		return `${cabinetName(value.cabinet_id)} · ${m.bin(gridRange(value.inner_row!, value.inner_col!, value.row_span, value.col_span))}`;
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
				// A move sheet is only open here after a rejected move: its guards must be current.
				if ((editorMode === 'move' || (inlineEditor && !draftChanged)) && before && !locked && !reviewCommand) {
					const current = shelf?.cabinets.find((item) => item.id === before?.id && !item.is_archived);
					if (current) { syncCabinet(current); moveId = ''; } else closeEditor(false);
				}
				settleRevalidation();
			}
		}
	}
	function syncCabinet(current: AdminCabinet) {
		before = { ...current };
		row = String(current.outer_row); column = gridCell(1, current.outer_col!).slice(0, -1);
		layoutSize = { rows: current.inner_rows, cols: current.inner_cols };
		beforeBins = shelf!.bins.filter((item) => item.cabinet_id === current.id && !item.is_archived).map((item) => ({ ...item }));
		layoutBins = beforeBins.map((item) => ({ ...item }));
		draftStart = JSON.stringify(draftFields());
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
			edit(shelf!.cabinets.find((item) => item.id === cabinet!.id)!);
			outcome = status; editorTrigger = trigger;
		});
	});
	function selectCabinet(id: string) {
		if (locked || draftChanged || id === cabinetId) return;
		closeEditor(false); cabinetId = id; binId = null;
	}
	function edit(value: AdminCabinet | null) {
		if (locked) return;
		editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		editorMode = 'edit'; editor = true; before = value ? { ...value } : null; moveId = ''; outcome = 'idle';
		row = String(value?.outer_row ?? 1); column = gridCell(1, value?.outer_col ?? 1).slice(0, -1);
		layoutId = value?.id ?? crypto.randomUUID(); layoutSize = { rows: value?.inner_rows ?? 12, cols: value?.inner_cols ?? 4 };
		beforeBins = shelf!.bins.filter((bin) => bin.cabinet_id === value?.id && !bin.is_archived).map((bin) => ({ ...bin }));
		layoutBins = value ? beforeBins.map((bin) => ({ ...bin })) : resizeLayout([], layoutId, null, layoutSize, assignedIds);
		layoutVersion++;
		draftStart = JSON.stringify(draftFields()); draftStored = false;
		const saved = readDraft(admin.session?.user.id, 'shelf') as { editor?: unknown; before?: unknown; beforeBins?: unknown; fields?: Record<string, unknown> } | null;
		const fields = saved?.fields, size = fields?.layoutSize as Record<string, unknown> | undefined;
		if (saved?.editor === 'cabinet' && JSON.stringify(saved.before) === JSON.stringify(before) && JSON.stringify(saved.beforeBins) === JSON.stringify(beforeBins)
			&& ['row', 'column', 'layoutId'].every(name => typeof fields?.[name] === 'string')
			&& Number.isInteger(size?.rows) && Number.isInteger(size?.cols) && Array.isArray(fields?.layoutBins)
			&& new Set(fields.layoutBins.map(bin => bin?.id)).size === fields.layoutBins.length
			&& fields.layoutBins.every(bin => bin && typeof bin === 'object' && typeof bin.id === 'string' && Number.isInteger(bin.inner_row) && Number.isInteger(bin.inner_col) && Number.isInteger(bin.row_span) && Number.isInteger(bin.col_span))) {
			({ row, column, layoutId, layoutSize, layoutBins } = fields as ReturnType<typeof draftFields>);
			layoutVersion++; draftStored = true;
		}
	}
	// Unsaved editor input outlives closing the sheet, a reload or a sign-in round
	// trip (drafts.ts). It returns only to the same unit, unchanged since the draft
	// began; Discard and an acknowledged save drop it.
	let draftStart = '', draftStored = false;
	function draftFields() { return { row, column, layoutId, layoutSize: $state.snapshot(layoutSize), layoutBins: $state.snapshot(layoutBins) }; }
	function discardDraft() { writeDraft(admin.session?.user.id, 'shelf', null); draftStored = false; }
	$effect(() => {
		if (!editor || editorMode !== 'edit' || busy || pending) return;
		const fields = draftFields();
		untrack(() => {
			// Only this unit's own draft is removed when its edits are undone by hand.
			if (JSON.stringify(fields) === draftStart) { if (draftStored) discardDraft(); return; }
			writeDraft(admin.session?.user.id, 'shelf', { editor: 'cabinet', before: $state.snapshot(before), beforeBins: $state.snapshot(beforeBins), fields });
			draftStored = true;
		});
	});
	function restoreDraft(command: ShelfCommand) {
		// Only a layout is a draft worth keeping; a rejected move or swap is redone on
		// the refreshed map. An open editor already holds the entered values.
		if (command.kind !== 'layout' || editor) return;
		const value = command.after;
		editorMode = 'edit'; editor = true; before = command.before;
		row = String(value.outer_row ?? 1); column = gridCell(1, value.outer_col ?? 1).slice(0, -1);
		layoutId = value.id; layoutSize = { rows: value.inner_rows, cols: value.inner_cols };
		beforeBins = command.beforeBins.map((bin) => ({ ...bin }));
		layoutBins = command.bins.map((bin) => ({ ...bin }));
		layoutVersion++;
	}
	function reviewPlacement() {
		if (busy || needsRefresh) return;
		// A cabinet archived or never created meanwhile leaves nothing to start from.
		if (!currentReview || currentReview.is_archived) { closeEditor(false); return; }
		syncCabinet(currentReview); layoutVersion++;
		reviewCommand = null; outcome = 'idle';
	}
	function closeEditor(restoreFocus = document.activeElement?.matches(':focus-visible') ?? false) {
		editor = false; before = null; reviewCommand = null;
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
			outcome = result; swapSource = null;
			// The acknowledged fields are the new baseline, even if the display refresh fails.
			if (result === 'stale') {
				if (saved.kind === 'layout') { restoreDraft(saved); reviewCommand = saved; }
				needsRefresh = true; return;
			}
			discardDraft(); draftStart = JSON.stringify(draftFields());
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
					const saved = pending; clearShelfCommand(sessionStorage, saved); pending = null; swapSource = null; restoreDraft(saved); outcome = failure;
					needsRefresh = failure !== 'invalid';
					// A fresh read never silently changes the original guards. The user reviews
					// the current layout before applying their retained draft to it.
					if (needsRefresh && saved.kind === 'layout' && saved.before) reviewCommand = saved;
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
				// The app reconciles the map itself (design-system.md §4.2); a retained
				// layout draft waits for the explicit review below.
				if (needsRefresh) void load(); else settleRevalidation();
			}
		}
	}
	function actor() { return { userId: admin.credentials().userId, requestId: crypto.randomUUID() }; }
	function save(event: SubmitEvent) {
		event.preventDefault(); if (locked || !editor || !shelf) return;
		try {
			const after: AdminCabinet = before ? { ...before, inner_rows: layoutSize.rows, inner_cols: layoutSize.cols }
				: { id: layoutId, code: `C-${layoutId}`, label: null, is_archived: false, outer_row: shelfInteger(row), outer_col: shelfColumn(column),
					inner_rows: layoutSize.rows, inner_cols: layoutSize.cols };
			void run({ ...actor(), kind: 'layout', before, beforeBins, after, bins: layoutBins });
		} catch { outcome = 'invalid'; }
	}
	function confirm(command: ShelfCommand) {
		confirmationTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		confirmation = command;
	}
	function canSwapDraft() {
		if (editor && (!before || draftChanged)) { outcome = 'saveBeforeSwap'; return false; }
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
	function archiveDrawer() {
		if (locked || draftChanged || !binId || assignedIds.has(binId)) return;
		const current = shelf?.bins.find((item) => item.id === binId && !item.is_archived);
		if (current) confirm({ ...actor(), kind: 'bin', before: { ...current }, after: { ...current, is_archived: true, cabinet_id: null, inner_row: null, inner_col: null } });
	}
	function archiveCabinet() {
		if (locked || !before || draftChanged || cabinetAssignments) return;
		const current = before;
		const liveBins = shelf?.bins.filter((item) => !item.is_archived && item.cabinet_id === current.id) ?? [];
		confirm({ ...actor(), kind: 'archive-cabinet', before: { ...current }, beforeBins: liveBins.map((item) => ({ ...item })) });
	}
	function openMove() {
		if (locked || !canSwapDraft()) return;
		editorTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		moveId = ''; editorMode = 'move';
	}
	function moveCabinet() {
		const target = moveTarget;
		if (locked || !before || !target) return;
		if (target.kind === 'cabinet') confirm({ ...actor(), kind: 'swap-cabinets', first: { ...before }, second: { ...target.cabinet } });
		else confirm({ ...actor(), kind: 'cabinet', before: { ...before }, after: { ...before, outer_row: target.row, outer_col: target.col } });
	}
</script>

{#snippet storageStatus()}
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive" role="status">{m.wrongIdentity}</Alert.Message>
	{:else if !storageReady}<Alert.Message appearance="inline" variant="destructive" role="status">{m.storageUnavailable}</Alert.Message>
	{:else if outcome !== 'idle'}<Alert.Message appearance="inline" variant={outcome === 'saved' ? 'default' : 'destructive'} role="status">{m[outcome]}</Alert.Message>{/if}
{/snippet}

{#snippet pendingRetry()}
	{#if pending && !wrongIdentity}
		<h3 class={itemTitle}>{m.pendingHeading}</h3><p>{summary(pending)}</p>
		<Button type="button" variant="outline" disabled={admin.status !== 'ready' || busy || !storageReady} onclick={() => run()}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.retry} /></Button>
	{/if}
{/snippet}

{#snippet review()}
	{#if reviewCommand}
		<p>{summary(reviewCommand)}</p><p>{m.reviewLayoutHint}</p>
		{#if currentReview && !currentReview.is_archived}<p>{m.currentPlacement(position(currentReview))}</p>{/if}
		{#if needsRefresh && !busy}<Alert.Message appearance="inline" variant="destructive" role="status" class="mt-4">{m.unavailable}</Alert.Message>{/if}
		<div class={[formActions, 'my-4']}>
			{#if needsRefresh && !busy}<Button type="button" variant="outline" onclick={load}>{m.retryLoad}</Button>{/if}
			<Button type="button" variant="outline" disabled={busy || needsRefresh} onclick={reviewPlacement}>{m.reviewLayout}</Button>
		</div>
	{/if}
{/snippet}

{#snippet layoutView()}
	{#key layoutVersion}<ShelfLayoutEditor bind:this={layoutEditor} initialSelected={binId ?? ''} onselect={selectDrawer} moving={Boolean(swapSource)} onempty={moveToEmpty}
		cabinetId={layoutId} bind:bins={layoutBins} bind:size={layoutSize} original={beforeBins} assigned={assignedIds} disabled={locked} onswap={dragSwap} onswapselect={pickSwap} />{/key}
{/snippet}

<!-- The selected drawer: its heading, everything you can do with it, then what it holds. -->
{#snippet drawerPanel()}
	{#if selectedDrawer}
		{@const id = selectedDrawer.id}
		<section class="mt-6 grid min-w-0 gap-3" aria-labelledby={`${fieldId}-drawer-title`}>
			<h3 class={itemTitle} id={`${fieldId}-drawer-title`}>{m.bin(gridRange(selectedDrawer.inner_row!, selectedDrawer.inner_col!, selectedDrawer.row_span, selectedDrawer.col_span))}</h3>
			<div class={formActions}>
				<Button type="button" variant="outline" disabled={locked || Boolean(swapSource) || selectedDrawer.inner_col! + selectedDrawer.col_span > layoutSize.cols} onclick={() => layoutEditor?.widen()}>{m.widenDrawer}</Button>
				<Button type="button" variant="outline" disabled={locked || Boolean(swapSource) || assignedIds.has(id) || selectedDrawer.col_span === 1} onclick={() => layoutEditor?.narrow()}>{m.narrowDrawer}</Button>
				{#if selectedDrawer.row_span * selectedDrawer.col_span > 1}<Button type="button" variant="outline" disabled={locked || Boolean(swapSource) || assignedIds.has(id)} onclick={() => layoutEditor?.split()}>{m.splitLayout}</Button>{/if}
				{#if bin}
					<Button type="button" variant="outline" disabled={locked || draftChanged || Boolean(swapSource)} onclick={() => pickSwap(id)}>{m.moveDrawer}</Button>
					<Button type="button" variant="outline" disabled={locked || draftChanged || assignedIds.has(id)} onclick={archiveDrawer}>{m.archiveBin}</Button>
				{/if}
			</div>
			{#if bin}
				{#if !assigned.length}<p class="text-sm text-muted-foreground">{m.noProducts}</p>
				{:else}
					<Item.Group aria-label={m.contents}>
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
			{/if}
		</section>
	{/if}
{/snippet}

<svelte:head><title>{m.title}</title></svelte:head>
<Toaster position="bottom-center" closeButton containerAriaLabel={m.notifications} closeButtonAriaLabel={m.dismissNotification} />
<svelte:window onfocus={revalidate} ononline={revalidate} onkeydown={(event) => { if (event.key === 'Escape' && swapSource && !confirmation) { swapSource = null; event.preventDefault(); } }} />
<svelte:document onvisibilitychange={revalidate} />
<div class={pageHeader}>
	<h1 class={pageHeading}>{m.heading}</h1>
	<div class={formActions}><Button type="button" variant="outline" bind:ref={newCabinetButton} disabled={locked || draftChanged} onclick={() => edit(null)}>{m.newCabinet}</Button></div>
</div>
<div class={formStatus} aria-live="polite" aria-atomic="true">
	{#if !editor}{@render storageStatus()}{/if}
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
	{#if inlineEditor && before}
		<section data-cabinet-editor class={shelfSection} aria-labelledby="cabinet-title">
			<Separator />
			<h2 class={sectionHeading} id="cabinet-title">{m.cabinet(gridCell(before.outer_row!, before.outer_col!))}</h2>
			<div class={[formActions, 'mt-3']}>
				<Button type="button" variant="outline" disabled={locked} onclick={openMove}>{m.moveCabinet}</Button>
				<Button type="button" variant="outline" disabled={locked || cabinetAssignments > 0 || draftChanged} onclick={archiveCabinet}>{m.archiveCabinetWithDrawers}</Button>
			</div>
			{#if cabinetAssignments}<p class="mt-2 text-sm text-muted-foreground">{m.cabinetAssignedBlocked(cabinetAssignments)}</p>{/if}
			<div class="mt-6 min-w-0">
				{@render review()}
				{#if swapSource}<div class="flex flex-wrap items-center gap-3" role="status"><p>{m.chooseSwap}</p><Button variant="outline" onclick={() => swapSource = null}>{m.cancelAction}</Button></div>{/if}
				<form id="shelf-editor-form" class={formLayout} onsubmit={save}>
					{@render layoutView()}
					<div class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground" aria-hidden="true">
						<span class="inline-flex items-center gap-2"><span class="size-4 rounded-xs border border-drawer-edge bg-drawer"></span>{m.legendAssigned}</span>
						<span class="inline-flex items-center gap-2"><span class="size-4 rounded-xs border border-dashed border-drawer-edge bg-steel"></span>{m.emptyDrawer}</span>
					</div>
				</form>
				{@render drawerPanel()}
				{@render pendingRetry()}
				<div class={[formStatus, 'mt-6']} aria-live="polite" aria-atomic="true">{@render storageStatus()}</div>
				<div class={[formActions, 'mt-6']}>
					<Button form="shelf-editor-form" type="submit" disabled={locked || !draftChanged}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.save} /></Button>
					{#if draftChanged}<Button type="button" variant="outline" disabled={locked} onclick={() => { discardDraft(); edit(shelf!.cabinets.find((item) => item.id === before!.id)!); }}>{m.discardChanges}</Button>{/if}
				</div>
			</div>
		</section>
	{/if}
{/if}

<Dialog.Root open={editor && !inlineEditor} onOpenChange={(open) => { if (open || busy) return; if (editorMode === 'move' && before) editorMode = 'edit'; else closeEditor(); }}>
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
		{#if editor}
			<Dialog.Header layout="bar">
				<Dialog.Title>{editorMode === 'move' ? m.moveCabinet : m.newCabinet}</Dialog.Title>
				<Dialog.Close disabled={busy}>{#snippet child({ props })}<Button {...props} variant="ghost" size="icon-sm"><Icon icon={XIcon} class="size-5" /><span class="sr-only">{m.cancel}</span></Button>{/snippet}</Dialog.Close>
			</Dialog.Header>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named dialog editor region supports native keyboard scrolling.) -->
			<div class={['shelf-editor-body', sheetBody]} role="region" aria-label={editorMode === 'move' ? m.moveCabinet : m.layoutHeading} tabindex="0">
				<AdminAccessGate active>
				<Dialog.Description class="sr-only">{editorMode === 'move' ? m.wallHint : m.moveHint}</Dialog.Description>
				{#if editorMode === 'move' && before}
					<Field.Set class="picker-group my-4 grid min-w-0 justify-items-start gap-3 [&_.placement-picker]:justify-self-stretch" aria-labelledby="move-target-title">
						<Field.Legend variant="label" id="move-target-title">{m.moveTarget}</Field.Legend>
						<Field.Description class="my-0">{m.moveCabinetHint}</Field.Description>
						<ShelfPlacementPicker topology={shelf?.live ?? { cabinets: [], bins: [] }} pick="cabinet" vacant current={before.id} selected={moveId || null} disabled={locked}
							onselect={(id) => { if (id !== before?.id) moveId = id; }} />
						<Field.Description class="my-0 min-h-12" aria-live="polite">{!moveTarget ? m.chooseSwap
							: moveTarget.kind === 'cabinet' ? m.swapPreview(position(before), position(moveTarget.cabinet))
							: m.movePreview(position(before), m.cabinet(gridCell(moveTarget.row, moveTarget.col)))}</Field.Description>
						<Button type="button" disabled={locked || !moveTarget} onclick={moveCabinet}>{moveTarget?.kind === 'cabinet' ? m.swap : m.move}</Button>
					</Field.Set>
				{:else}
					{@render review()}
					<form id="shelf-editor-form" class={formLayout} onsubmit={save}>
						<Field.Group layout="row">
							<Field.Field width="short"><Field.Label for={`${fieldId}-2`}>{m.row}</Field.Label><Input id={`${fieldId}-2`} required inputmode="numeric" pattern="[1-9][0-9]*" bind:value={row} disabled={locked} /></Field.Field>
							<Field.Field width="short"><Field.Label for={`${fieldId}-3`}>{m.column}</Field.Label><Input id={`${fieldId}-3`} class="font-mono" required pattern="[A-Za-z]+" autocapitalize="characters" bind:value={column} disabled={locked} /></Field.Field>
						</Field.Group>
						<Field.Description class="my-0 min-h-12">{preview ? m.placementPreview(preview) : m.invalid}</Field.Description>
						{@render layoutView()}
					</form>
					{@render drawerPanel()}
				{/if}
				{@render pendingRetry()}
				</AdminAccessGate>
			</div>
			<Dialog.Footer variant="sheet" class="items-center">
				<div class="min-w-0 flex-1 text-sm" aria-live="polite" aria-atomic="true">{@render storageStatus()}</div>
				{#if editorMode === 'edit'}<Button form="shelf-editor-form" type="submit" disabled={locked}><ButtonLabel pending={busy} pendingLabel={m.saving} label={m.save} /></Button>{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
<AlertDialog.Root open={confirmation !== null} onOpenChange={(open) => { if (!open) confirmation = null; }}>
	<AlertDialog.Content preventScroll={false} onCloseAutoFocus={(event) => { event.preventDefault(); confirmationTrigger?.focus({ preventScroll: true }); }}>
		<AlertDialog.Header>
			<AlertDialog.Title id={`${fieldId}-confirmation-title`}>{confirmation?.kind === 'swap-bins' || confirmation?.kind === 'swap-cabinets' ? m.swapHeading : confirmation?.kind === 'bin' && !confirmation.after.is_archived ? m.moveDrawer : confirmation?.kind === 'archive-cabinet' ? m.archiveCabinetWithDrawers : confirmation?.kind === 'cabinet' ? m.moveCabinet : m.archiveBin}</AlertDialog.Title>
			<AlertDialog.Description aria-labelledby={`${fieldId}-confirmation-title`}>
				<span class="block">{confirmation ? summary(confirmation) : ''}</span>
				<span class="mt-3 block text-foreground">{confirmation?.kind === 'swap-bins' ? m.swapHint : confirmation?.kind === 'swap-cabinets' || confirmation?.kind === 'cabinet' ? m.wallHint : confirmation?.kind === 'bin' && !confirmation.after.is_archived ? m.moveHint : m.archiveHint}</span>
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.cancelAction}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={locked} onclick={() => { const command = confirmation; confirmation = null; if (command) void run(command); }}>{m.confirmAction}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
