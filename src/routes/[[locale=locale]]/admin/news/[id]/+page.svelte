<script lang="ts">
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formActions, formGrid, formStatus, itemTitle, pageHeader, pageHeading, section, sectionHeading } from '#lib/ui.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Button, ButtonLabel } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import StateBadge from '#lib/StateBadge.svelte';
	import Icon from '#lib/Icon.svelte';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import ImageSquareIcon from 'phosphor-svelte/lib/ImageSquareIcon';
	import LinkBreakIcon from 'phosphor-svelte/lib/LinkBreakIcon';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
	import ArrowLineUpIcon from 'phosphor-svelte/lib/ArrowLineUpIcon';
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getI18n } from '#lib/i18n/index.js';
	import { getAdminContext } from '#lib/admin-context.svelte.js';
	import { readAdminHelp } from '#lib/admin-api.js';
	import type { StaffSession } from '#lib/convex.js';
	import { isSafeHttpsUrl, type EditableHelpContact } from '#lib/help.js';
	import { osloInstant, osloLocal } from '#lib/oslo-time.js';
	import { formatEventWhen, slugify, uniqueSlug, type NewsLink } from '#lib/news.js';
	import {
		clearNewsCommand, insertParagraph, newsError, numberMarkers, placedNumbers, prepareImage, storeMarkers, readAdminNews, readNewsCommand, readNewsImage, saveNews, saveNewsCommand, uploadNewsImage,
		type AdminArticle, type AdminEvent, type ArticleWrite, type EventWrite, type ImageRef, type NewsCommand, type PreparedImage
	} from '#lib/admin-news.js';

	// One editor for an article, its event, or both (docs/page-admin-news.md). The event row
	// owns the link, so linking, unlinking and creating both happen in one amp_save_news call.
	const fieldId = $props.id();
	const i18n = getI18n(); const admin = getAdminContext(); const m = $derived(i18n.m.adminNews);
	const id = $derived(page.params.id ?? 'new');

	type ArticleDraft = { id: string; slug: string | null; title: string; author: string; summary: string; body: string; is_published: boolean; revision: string | null };
	type EventDraft = { id: string; slug: string | null; title: string; description: string; location: string; starts: string; ends: string; is_published: boolean; revision: string | null };
	let news = $state<{ articles: AdminArticle[]; events: AdminEvent[] } | null>(null);
	let contacts = $state<EditableHelpContact[] | null>(null);
	let loading = $state(true); let loadFailed = $state(false); let notFound = $state(false);
	let article = $state<ArticleDraft | null>(null); let event = $state<EventDraft | null>(null);
	// A saved link the editor removed: the stored event is saved back with article_id null.
	let removed = $state<{ side: 'article' | 'event'; stored: AdminArticle | AdminEvent; draft: ArticleDraft | EventDraft } | null>(null);
	// Images, links and people are shared by an article and its event.
	let images = $state<ImageRef[]>([]); let links = $state<NewsLink[]>([]); let people = $state<string[]>([]);
	let previews = $state<Record<string, string | null | undefined>>({});
	let busy = $state(false);
	type Outcome = 'idle' | 'saved' | 'invalid' | 'missingImage' | 'stale' | 'slugTaken' | 'linkTaken' | 'unknown' | 'ambiguousTime' | 'invalidTime' | 'endsBeforeStart';
	let outcome = $state<Outcome>('idle');
	let pending = $state<NewsCommand | null>(null); let restored = $state(false);
	let storageReady = $state(false); let wrongIdentity = $state(false);
	let imageState = $state<'idle' | 'preparing' | 'failed' | 'unreadable'>('idle');
	let failedUpload = $state.raw<{ id: string; image: PreparedImage } | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	// Images go into the text where the cursor last was; an upload started from the text goes there too.
	let bodyField = $state<HTMLTextAreaElement | null>(null);
	let bodyCursor: number | null = null;
	let insertUpload: number | null = null;

	// The body keeps stored markers until `numberBody` shows them as image numbers.
	const fromArticle = (a: AdminArticle): ArticleDraft => ({ id: a.id, slug: a.slug, title: a.title, author: a.author ?? '', summary: a.summary ?? '', body: a.body, is_published: a.is_published, revision: a.edit_revision });
	const fromEvent = (e: AdminEvent): EventDraft => ({ id: e.id, slug: e.slug, title: e.title, description: e.description, location: e.location ?? '',
		starts: osloLocal(new Date(e.starts_at)), ends: e.ends_at ? osloLocal(new Date(e.ends_at)) : '', is_published: e.is_published, revision: e.edit_revision });
	const blankArticle = (): ArticleDraft => ({ id: crypto.randomUUID(), slug: null, title: '', author: admin.membership?.displayName ?? '', summary: '', body: '', is_published: false, revision: null });
	const blankEvent = (title = ''): EventDraft => ({ id: crypto.randomUUID(), slug: null, title, description: '', location: '', starts: '', ends: '', is_published: false, revision: null });
	function merge(...sources: (AdminArticle | AdminEvent | null)[]) {
		const rows = sources.filter(row => row !== null);
		images = [...new Map([...images, ...rows.flatMap(row => row.images)].map(image => [image.id, image])).values()].slice(0, 8);
		links = [...new Map([...links, ...rows.flatMap(row => row.links)].map(link => [link.url, link])).values()].slice(0, 10);
		people = [...new Set([...people, ...rows.flatMap(row => row.people)])].slice(0, 20);
	}
	function fill(a: AdminArticle | null, e: AdminEvent | null) {
		article = a ? fromArticle(a) : null; event = e ? fromEvent(e) : null; removed = null;
		images = []; links = []; people = []; merge(a, e); numberBody();
	}
	function numberBody() { if (article) article.body = numberMarkers(article.body, images, m.markerWord); }
	async function load() {
		if (admin.status !== 'ready') return;
		loading = true; loadFailed = false; notFound = false;
		try {
			const session = admin.credentials();
			const [rows, directory] = await Promise.all([readAdminNews(session), readAdminHelp(session).catch(() => null)]);
			if (session.userId !== admin.userId) return;
			news = rows; contacts = directory;
			if (id === 'new') {
				const kind = page.url.searchParams.get('with');
				fill(null, null);
				if (kind !== 'event') article = blankArticle();
				if (kind === 'event' || kind === 'both') event = blankEvent();
				return;
			}
			const a = rows.articles.find(row => row.id === id) ?? null;
			const e = a ? rows.events.find(row => row.article_id === a.id) ?? null : rows.events.find(row => row.id === id) ?? null;
			const linked = a ?? (e?.article_id ? rows.articles.find(row => row.id === e.article_id) ?? null : null);
			if (!linked && !e) { notFound = true; return; }
			fill(linked, e);
		} catch (error) { loadFailed = true; await admin.permissionFailure(error); }
		finally { loading = false; }
	}
	onMount(() => {
		try {
			const probe = 'ampoteket:admin-news-save:probe'; sessionStorage.setItem(probe, '1');
			if (sessionStorage.getItem(probe) !== '1') throw new Error(); sessionStorage.removeItem(probe);
			storageReady = true;
			pending = readNewsCommand(sessionStorage); restored = Boolean(pending);
			wrongIdentity = Boolean(pending && pending.userId !== admin.userId);
		} catch { storageReady = false; }
		void load();
	});
	onDestroy(() => { for (const url of Object.values(previews)) if (url) URL.revokeObjectURL(url); });

	// Stored images are shown through the staff API; uploads in this session already have a preview.
	$effect(() => {
		for (const image of images) {
			if (image.id in previews || admin.status !== 'ready') continue;
			previews[image.id] = undefined;
			readNewsImage(admin.credentials(), image.id).then(blob => { previews[image.id] = URL.createObjectURL(blob); }, () => { previews[image.id] = null; });
		}
	});

	const linkableEvents = $derived(news?.events.filter(row => !row.article_id && row.id !== removed?.stored.id) ?? []);
	const linkableArticles = $derived(news?.articles.filter(row => !news!.events.some(e => e.article_id === row.id) && row.id !== removed?.stored.id) ?? []);
	function addArticle() { article = blankArticle(); if (event) article.title = event.title; outcome = 'idle'; }
	function addEvent() { event = blankEvent(article?.title ?? ''); outcome = 'idle'; }
	function linkExisting(side: 'article' | 'event', rowId: string) {
		if (side === 'event') { const row = news?.events.find(e => e.id === rowId); if (row) { event = fromEvent(row); merge(row); } }
		else { const row = news?.articles.find(a => a.id === rowId); if (row) { article = fromArticle(row); merge(row); numberBody(); } }
		outcome = 'idle';
	}
	// Removing a side that is linked in the database keeps it, unlinked; a side added in this editor just goes.
	function remove(side: 'article' | 'event') {
		const draft = side === 'article' ? article : event;
		if (!draft || !article || !event) return;
		const storedEvent = news?.events.find(e => e.id === event!.id);
		if (storedEvent?.article_id === article.id) {
			const stored = side === 'event' ? storedEvent : news!.articles.find(a => a.id === article!.id)!;
			removed = { side, stored, draft: $state.snapshot(draft) };
		}
		if (side === 'article') article = null; else event = null;
		outcome = 'idle';
	}
	function undoRemove() {
		if (!removed) return;
		if (removed.side === 'article') article = removed.draft as ArticleDraft; else event = removed.draft as EventDraft;
		removed = null;
	}

	async function addImage(change: Event) {
		const input = change.currentTarget as HTMLInputElement; const file = input.files?.[0]; input.value = '';
		if (!file || images.length >= 8 || admin.status !== 'ready') return;
		imageState = 'preparing';
		let image: PreparedImage;
		try { image = await prepareImage(file); } catch { imageState = 'unreadable'; return; }
		await upload({ id: crypto.randomUUID(), image });
	}
	// A failed upload is retried with the same id, so a lost response stores nothing twice.
	async function upload(attempt: { id: string; image: PreparedImage }) {
		imageState = 'preparing'; failedUpload = null;
		try { await uploadNewsImage(admin.credentials(), attempt.id, attempt.image); }
		catch (error) { imageState = 'failed'; failedUpload = attempt; await admin.permissionFailure(error); return; }
		previews[attempt.id] = URL.createObjectURL(attempt.image.blob);
		images.push({ id: attempt.id, alt: '' }); imageState = 'idle';
		if (insertUpload !== null && article) { article.body = insertParagraph(article.body, insertUpload, marker(images.length)).body; insertUpload = null; }
		await tick(); document.getElementById(`${fieldId}-alt-${attempt.id}`)?.focus();
	}
	function chooseImage(intoText: boolean) {
		insertUpload = intoText && article ? bodyCursor ?? article.body.length : null;
		fileInput?.click();
	}
	const marker = (n: number) => `[${m.markerWord} ${n}]`;
	async function insertImage(n: number) {
		if (!article) return;
		const inserted = insertParagraph(article.body, bodyCursor ?? article.body.length, marker(n));
		article.body = inserted.body; bodyCursor = inserted.cursor;
		await tick(); bodyField?.focus(); bodyField?.setSelectionRange(inserted.cursor, inserted.cursor);
	}
	// The text names images by their number in the list, so reordering or removing renumbers it.
	function setImages(next: ImageRef[]) {
		const stored = article ? storeMarkers(article.body, images) : null;
		images = next;
		if (article && stored !== null) article.body = numberMarkers(stored, next, m.markerWord);
	}
	function moveImage(index: number, step: -1 | 1) {
		const next = [...images]; const [row] = next.splice(index, 1); next.splice(index + step, 0, row); setImages(next);
	}
	const placed = $derived(article ? placedNumbers(article.body) : new Set<number>());
	function togglePerson(contactId: string, checked: boolean) {
		const chosen = checked ? [...people, contactId] : people.filter(person => person !== contactId);
		// Tags follow the contact page's order, like everywhere else the volunteers are listed.
		people = [...(contacts?.map(contact => contact.id).filter(person => chosen.includes(person)) ?? []), ...chosen.filter(person => !contacts?.some(contact => contact.id === person))];
	}

	function instant(local: string): string | Outcome {
		try { return osloInstant(local); }
		catch (error) { return error instanceof Error && error.message === 'AMBIGUOUS_OSLO_TIME' ? 'ambiguousTime' : 'invalidTime'; }
	}
	const storedWrite = (row: AdminEvent): EventWrite => ({ id: row.id, slug: row.slug, title: row.title, description: row.description, location: row.location, starts_at: row.starts_at, ends_at: row.ends_at,
		article_id: null, images: row.images, links: row.links, people: row.people, is_published: row.is_published, expected_revision: row.edit_revision });
	function buildCommand(session: StaffSession): NewsCommand | Outcome {
		const imageRefs = images.map(image => ({ id: image.id, alt: image.alt.trim() }));
		const linkList = links.map(link => ({ label: link.label.trim(), url: link.url.trim() })).filter(link => link.label || link.url);
		if (imageRefs.some(image => !image.alt) || linkList.some(link => !link.label || !isSafeHttpsUrl(link.url))) return 'invalid';
		const body = article && storeMarkers(article.body, imageRefs);
		if (article && body === null) return 'missingImage';
		const articleWrite: ArticleWrite | null = article && {
			id: article.id, slug: article.slug ?? uniqueSlug(slugify(article.title), new Set(news?.articles.map(row => row.slug))), title: article.title.trim(),
			author: article.author.trim() || null, summary: article.summary.trim() || null, body: body!, images: imageRefs, links: linkList, people, is_published: article.is_published, expected_revision: article.revision
		};
		let eventWrite: EventWrite | null = null;
		if (event) {
			const starts = instant(event.starts);
			const ends = event.ends ? instant(event.ends) : null;
			for (const value of [starts, ends]) if (value === 'ambiguousTime' || value === 'invalidTime') return value;
			if (ends && (Date.parse(ends) <= Date.parse(starts) || Date.parse(ends) - Date.parse(starts) > 62 * 86_400_000)) return 'endsBeforeStart';
			eventWrite = { id: event.id, slug: event.slug ?? uniqueSlug(slugify(event.title), new Set(news?.events.map(row => row.slug))), title: event.title.trim(), description: event.description.replace(/\r\n?/g, '\n').trim(),
				location: event.location.trim() || null, starts_at: starts, ends_at: ends, article_id: article?.id ?? null, images: imageRefs, links: linkList, people, is_published: event.is_published, expected_revision: event.revision };
		} else if (removed?.side === 'event') eventWrite = storedWrite(removed.stored as AdminEvent);
		if (!articleWrite && !eventWrite) return 'invalid';
		return { userId: session.userId, requestId: crypto.randomUUID(), article: articleWrite, event: eventWrite };
	}
	async function save(submit: SubmitEvent) {
		submit.preventDefault();
		if (busy || !storageReady || wrongIdentity || admin.status !== 'ready' || outcome === 'stale') return;
		busy = true; outcome = 'idle';
		try {
			const session = admin.credentials();
			if (!pending) {
				const built = buildCommand(session);
				if (typeof built === 'string') { outcome = built; return; }
				pending = saveNewsCommand(sessionStorage, built);
			}
			const command = pending;
			try {
				const saved = await saveNews(session, command);
				clearNewsCommand(sessionStorage, command); pending = null;
				if (restored) { restored = false; await load(); return; }
				if (article && saved.article) { article.revision = saved.article.edit_revision; article.slug = saved.article.slug; }
				if (event && saved.event) { event.revision = saved.event.edit_revision; event.slug = saved.event.slug; }
				removed = null; outcome = 'saved';
				news = await readAdminNews(session).catch(() => news);
				const target = article?.id ?? event?.id;
				if (target && target !== id) await goto(i18n.href(`/admin/news/${target}`), { replace: true, reset: false });
			} catch (error) {
				const name = newsError(error, ['STALE_NEWS', 'NEWS_NOT_FOUND', 'NEWS_SLUG_TAKEN', 'EVENT_ARTICLE_TAKEN', 'INVALID_NEWS', 'NEWS_IMAGE_NOT_FOUND', 'NEWS_PERSON_NOT_FOUND', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT'] as const);
				if (name) {
					// A definite rejection: nothing was saved, so the command is dropped and the next save is rebuilt.
					clearNewsCommand(sessionStorage, command); pending = null; restored = false;
					outcome = name === 'STALE_NEWS' || name === 'NEWS_NOT_FOUND' ? 'stale' : name === 'NEWS_SLUG_TAKEN' ? 'slugTaken' : name === 'EVENT_ARTICLE_TAKEN' ? 'linkTaken' : 'invalid';
					if (name === 'NEWS_SLUG_TAKEN') news = await readAdminNews(session).catch(() => news);
				} else outcome = 'unknown';
				await admin.permissionFailure(error);
			}
		} catch { outcome = 'unknown'; }
		finally { busy = false; }
	}
	async function reload() { outcome = 'idle'; await load(); }

	const locked = $derived(busy || Boolean(pending) || wrongIdentity || !storageReady);
	// The saved title, so the heading does not change while typing.
	const heading = $derived(news?.articles.find(row => row.id === article?.id)?.title ?? news?.events.find(row => row.id === event?.id)?.title
		?? (event && !article ? m.newEvent : m.newArticle));
	const messages = $derived<Record<Outcome, string>>({ idle: '', saved: '', invalid: m.invalid, missingImage: m.missingImage, stale: m.stale, slugTaken: m.slugTaken, linkTaken: m.linkTaken, unknown: m.unknown,
		ambiguousTime: m.ambiguousTime, invalidTime: m.invalidTime, endsBeforeStart: m.endsBeforeStart });
</script>
<svelte:head><title>{m.editTitle}</title></svelte:head>
<header class={pageHeader}><h1 class={pageHeading}>{heading}</h1></header>
<div class={formStatus} aria-live="polite">
	{#if wrongIdentity}<Alert.Message appearance="inline" variant="destructive">{i18n.m.admin.commandIdentity}</Alert.Message>
	{:else if !storageReady && !loading}<Alert.Message appearance="inline" variant="destructive">{i18n.m.admin.storageUnavailable}</Alert.Message>
	{:else if restored && pending}<Alert.Message appearance="inline" variant="warning">{m.unfinished}</Alert.Message>{/if}
</div>
{#if loading && !news}
	<span class="sr-only" role="status">{i18n.m.admin.loading}</span>
	<div class="min-h-80 space-y-6" aria-hidden="true"><Skeleton class="h-10 w-full" /><Skeleton class="h-32 w-full" /><Skeleton class="h-10 w-2/3" /></div>
{:else if loadFailed}
	<Alert.Message appearance="inline" variant="destructive" role="alert">{m.unavailable}</Alert.Message>
	<Button type="button" variant="outline" onclick={load}>{i18n.m.admin.retry}</Button>
{:else if notFound}
	<Alert.Message appearance="inline" variant="destructive" role="alert">{m.notFound}</Alert.Message>
	<Button variant="outline" href={i18n.href('/admin/news')}>{m.heading}</Button>
{:else}
	<form class="grid gap-2" aria-label={heading} onsubmit={save}>
		{#snippet sideActions(side: 'article' | 'event')}
			{@const options = side === 'article' ? linkableArticles : linkableEvents}
			<div class="flex flex-wrap items-end gap-x-5 gap-y-3">
				<Button type="button" variant="outline" disabled={locked} onclick={side === 'article' ? addArticle : addEvent}><Icon icon={PlusIcon} />{side === 'article' ? m.addArticle : m.addEvent}</Button>
				{#if options.length}
					<Field.Field class="w-full max-w-80">
						<Field.Label for={`${fieldId}-link-${side}`}>{side === 'article' ? m.linkArticle : m.linkEvent}</Field.Label>
						<NativeSelect.Root id={`${fieldId}-link-${side}`} value="" disabled={locked} onchange={(change: Event) => linkExisting(side, (change.currentTarget as HTMLSelectElement).value)}>
							<NativeSelect.Option value="">{m.choose}</NativeSelect.Option>
							{#each options as option (option.id)}<NativeSelect.Option value={option.id}>{'starts_at' in option ? `${option.title} (${formatEventWhen(option, i18n.locale)})` : option.title}</NativeSelect.Option>{/each}
						</NativeSelect.Root>
					</Field.Field>
				{/if}
			</div>
		{/snippet}
		{#snippet removedNotice(side: 'article' | 'event')}
			{#if removed?.side === side}
				<div class="flex flex-wrap items-center gap-3">
					<p class="inline-flex items-center gap-2 text-muted-foreground"><Icon icon={LinkBreakIcon} />{m.unlinked}</p>
					<Button type="button" variant="link" disabled={locked} onclick={undoRemove}>{m.undoUnlink}</Button>
				</div>
			{/if}
		{/snippet}

		<section class="space-y-4" aria-labelledby={`${fieldId}-article-title`}>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 id={`${fieldId}-article-title`} class={sectionHeading}>{m.article}</h2>
				{#if article?.slug && article.is_published && article.revision}<Button variant="link" href={i18n.href(`/news/${article.slug}`)} target="_blank">{m.viewArticle}<Icon icon={ArrowSquareOutIcon} /><span class="sr-only"> {i18n.m.newTab}</span></Button>{/if}
			</div>
			{#if article}
				<div class={formGrid}>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-article-name`} required>{m.titleLabel}</Field.Label><Input id={`${fieldId}-article-name`} autocapitalize="sentences" required maxlength={160} bind:value={article.title} disabled={locked} /></Field.Field>
					<Field.Field class="col-span-full md:col-span-2"><Field.Label for={`${fieldId}-author`}>{m.author}</Field.Label><Input id={`${fieldId}-author`} autocomplete="name" autocapitalize="words" maxlength={80} bind:value={article.author} disabled={locked} /></Field.Field>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-summary`}>{m.summary}</Field.Label><Textarea id={`${fieldId}-summary`} rows={2} maxlength={300} bind:value={article.summary} disabled={locked} /></Field.Field>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-body`}>{m.body}</Field.Label><Textarea id={`${fieldId}-body`} rows={12} maxlength={20000} bind:ref={bodyField} bind:value={article.body} disabled={locked} aria-describedby={`${fieldId}-body-hint`} aria-invalid={outcome === 'missingImage'} onblur={(blur: FocusEvent) => { bodyCursor = (blur.currentTarget as HTMLTextAreaElement).selectionStart; }} /><Field.Description id={`${fieldId}-body-hint`}>{m.bodyHint}</Field.Description>
							{#if images.length < 8}<Button type="button" variant="outline" class="self-start" disabled={locked || imageState === 'preparing'} onclick={() => chooseImage(true)}><Icon icon={ImageSquareIcon} />{m.insertImage}</Button>{/if}
						</Field.Field>
				</div>
				<Field.Field orientation="horizontal" class="min-h-12"><Switch id={`${fieldId}-article-published`} bind:checked={article.is_published} disabled={locked} /><Field.Label for={`${fieldId}-article-published`} class="cursor-pointer">{m.publishArticle}</Field.Label></Field.Field>
				{#if event}<Button type="button" variant="ghost" disabled={locked} onclick={() => remove('article')}><Icon icon={LinkBreakIcon} />{m.unlinkArticle}</Button>{/if}
			{:else}
				{@render removedNotice('article')}
				{#if removed?.side !== 'article'}{@render sideActions('article')}{/if}
			{/if}
		</section>

		<section class={section({ spacing: 'divided' })} aria-labelledby={`${fieldId}-event-title`}>
			<Separator />
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 id={`${fieldId}-event-title`} class={sectionHeading}>{m.event}</h2>
				{#if event?.slug && event.is_published && event.revision}<Button variant="link" href={i18n.href(`/events/${event.slug}`)} target="_blank">{m.viewEvent}<Icon icon={ArrowSquareOutIcon} /><span class="sr-only"> {i18n.m.newTab}</span></Button>{/if}
			</div>
			{#if event}
				<div class={formGrid}>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-event-name`} required>{m.titleLabel}</Field.Label><Input id={`${fieldId}-event-name`} autocapitalize="sentences" required maxlength={160} bind:value={event.title} disabled={locked} /></Field.Field>
					<Field.Field class="col-span-full md:col-span-2"><Field.Label for={`${fieldId}-starts`} required>{m.starts}</Field.Label><Input id={`${fieldId}-starts`} type="datetime-local" required bind:value={event.starts} disabled={locked} aria-invalid={['ambiguousTime', 'invalidTime'].includes(outcome)} /></Field.Field>
					<Field.Field class="col-span-full md:col-span-2"><Field.Label for={`${fieldId}-ends`}>{m.ends}</Field.Label><Input id={`${fieldId}-ends`} type="datetime-local" min={event.starts || undefined} bind:value={event.ends} disabled={locked} aria-invalid={outcome === 'endsBeforeStart'} /></Field.Field>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-location`}>{m.location}</Field.Label><Input id={`${fieldId}-location`} autocapitalize="sentences" maxlength={160} bind:value={event.location} disabled={locked} /></Field.Field>
					<Field.Field class="col-span-full"><Field.Label for={`${fieldId}-description`}>{m.description}</Field.Label><Textarea id={`${fieldId}-description`} rows={4} maxlength={5000} bind:value={event.description} disabled={locked} /></Field.Field>
				</div>
				<Field.Field orientation="horizontal" class="min-h-12"><Switch id={`${fieldId}-event-published`} bind:checked={event.is_published} disabled={locked} /><Field.Label for={`${fieldId}-event-published`} class="cursor-pointer">{m.publishEvent}</Field.Label></Field.Field>
				{#if article}<Button type="button" variant="ghost" disabled={locked} onclick={() => remove('event')}><Icon icon={LinkBreakIcon} />{m.unlinkEvent}</Button>{/if}
			{:else}
				{@render removedNotice('event')}
				{#if removed?.side !== 'event'}{@render sideActions('event')}{/if}
			{/if}
		</section>

		<section class={section({ spacing: 'divided' })} aria-labelledby={`${fieldId}-images-title`}>
			<Separator />
			<h2 id={`${fieldId}-images-title`} class={sectionHeading}>{m.images}</h2>
			{#if article && event}<p class="text-muted-foreground">{m.shared}</p>{/if}
			<p class="text-muted-foreground">{images.length > 1 ? `${m.imageConsent} ${m.imageCover}` : m.imageConsent}</p>
			{#if images.length}
				<ol class="m-0 grid list-none gap-4 p-0">
					{#each images as image, index (image.id)}
						<li class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 md:grid-cols-[auto_8rem_minmax(0,1fr)_auto]">
							<div class="flex flex-col">
								<Button type="button" variant="ghost" size="icon-sm" disabled={locked || index === 0} onclick={() => moveImage(index, -1)}><Icon icon={ArrowUpIcon} /><span class="sr-only">{m.moveImageUp(index + 1)}</span></Button>
								<Button type="button" variant="ghost" size="icon-sm" disabled={locked || index === images.length - 1} onclick={() => moveImage(index, 1)}><Icon icon={ArrowDownIcon} /><span class="sr-only">{m.moveImageDown(index + 1)}</span></Button>
							</div>
							<div class="grid gap-1 max-md:col-start-2 max-md:row-start-1">
								<div class="grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-muted text-center text-sm text-muted-foreground md:w-32">
									{#if previews[image.id]}<img src={previews[image.id]} alt="" class="size-full object-cover" />{:else if previews[image.id] === null}<span class="p-2">{m.imagePreviewUnavailable}</span>{:else}<Skeleton class="size-full" />{/if}
								</div>
								<p class="text-sm text-muted-foreground">{m.imageNumber(index + 1)}{#if placed.has(index + 1)}, {m.inText}{/if}</p>
							</div>
							<Field.Field class="col-start-2 md:col-start-auto"><Field.Label for={`${fieldId}-alt-${image.id}`} required>{m.imageAlt}</Field.Label><Input id={`${fieldId}-alt-${image.id}`} autocapitalize="sentences" required maxlength={300} bind:value={image.alt} disabled={locked} /></Field.Field>
							<div class="col-start-2 flex flex-wrap items-center gap-1 md:col-start-auto md:self-end">
								{#if article}<Button type="button" variant="ghost" disabled={locked} onclick={() => insertImage(index + 1)}><Icon icon={ArrowLineUpIcon} /><span aria-hidden="true">{m.insertInText}</span><span class="sr-only">{m.insertImageN(index + 1)}</span></Button>{/if}
								<Button type="button" variant="ghost" disabled={locked} onclick={() => setImages(images.filter((_, other) => other !== index))}><Icon icon={TrashIcon} /><span class="sr-only">{m.removeImage(index + 1)}</span></Button>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
			{#if images.length < 8}
				<div class="flex flex-wrap items-center gap-3">
					<input bind:this={fileInput} class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true" onchange={addImage} />
					<Button type="button" variant="outline" disabled={locked || imageState === 'preparing'} onclick={() => chooseImage(false)}><Icon icon={ImageSquareIcon} /><ButtonLabel pending={imageState === 'preparing'} pendingLabel={m.preparingImage} label={m.addImage} /></Button>
					{#if imageState === 'failed' && failedUpload}{@const attempt = failedUpload}<Button type="button" variant="outline" disabled={locked} onclick={() => upload(attempt)}>{i18n.m.admin.retry}</Button>{/if}
				</div>
			{/if}
			<div class={formStatus} aria-live="polite">
				{#if imageState === 'preparing'}<span class="sr-only">{m.preparingImage}</span>{:else if imageState === 'failed'}<Alert.Message appearance="inline" variant="destructive">{m.imageFailed}</Alert.Message>{:else if imageState === 'unreadable'}<Alert.Message appearance="inline" variant="destructive">{m.imageUnreadable}</Alert.Message>{/if}
			</div>
		</section>

		<section class={section({ spacing: 'divided' })} aria-labelledby={`${fieldId}-links-title`}>
			<Separator />
			<h2 id={`${fieldId}-links-title`} class={sectionHeading}>{m.links}</h2>
			{#each links as link, index (index)}
				<div class="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto]">
					<Field.Field><Field.Label for={`${fieldId}-link-label-${index}`} required>{m.linkLabel}</Field.Label><Input id={`${fieldId}-link-label-${index}`} autocapitalize="sentences" required maxlength={80} bind:value={link.label} disabled={locked} /></Field.Field>
					<Field.Field class="max-md:col-start-1 max-md:row-start-2"><Field.Label for={`${fieldId}-link-url-${index}`} required>{m.linkUrl}</Field.Label><Input id={`${fieldId}-link-url-${index}`} type="url" autocapitalize="none" required maxlength={500} placeholder="https://" bind:value={link.url} disabled={locked} /></Field.Field>
					<Button type="button" variant="ghost" size="icon" class="max-md:row-start-1 max-md:col-start-2" disabled={locked} onclick={() => { links.splice(index, 1); }}><Icon icon={TrashIcon} /><span class="sr-only">{m.removeLink(index + 1)}</span></Button>
				</div>
			{/each}
			{#if links.length < 10}<Button type="button" variant="outline" disabled={locked} onclick={() => { links.push({ label: '', url: '' }); }}><Icon icon={PlusIcon} />{m.addLink}</Button>{/if}
		</section>

		<section class={section({ spacing: 'divided' })} aria-labelledby={`${fieldId}-people-title`}>
			<Separator />
			<h2 id={`${fieldId}-people-title`} class={sectionHeading}>{m.people}</h2>
			<p class="text-muted-foreground">{m.peopleHint}</p>
			{#if contacts === null}<Alert.Message appearance="inline" variant="destructive">{m.contactsUnavailable}</Alert.Message>
			{:else if !contacts.length}<p class="text-muted-foreground">{m.noContacts}</p>
			{:else}
				<ul class="m-0 grid list-none gap-x-6 gap-y-1 p-0 md:grid-cols-2">
					{#each contacts as contact (contact.id)}
						<li>
							<Field.Field orientation="horizontal" class="min-h-11 items-start py-1">
								<Checkbox id={`${fieldId}-person-${contact.id}`} checked={people.includes(contact.id)} onCheckedChange={(checked: boolean) => togglePerson(contact.id, checked)} disabled={locked} />
								<Field.Label for={`${fieldId}-person-${contact.id}`} class="grid cursor-pointer gap-1 font-normal">
									<span class={itemTitle}>{contact.display_name}</span>
									{#if contact.responsibility || !contact.is_published}<span class="flex flex-wrap items-center gap-2 text-muted-foreground">{#if contact.responsibility}<span>{contact.responsibility}</span>{/if}{#if !contact.is_published}<StateBadge tone="neutral">{m.notOnContactPage}</StateBadge>{/if}</span>{/if}
								</Field.Label>
							</Field.Field>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<div class={[section({ spacing: 'divided' }), 'grid gap-0']}>
			<Separator />
			<div class={formActions}>
				<Button type="submit" disabled={busy || wrongIdentity || !storageReady || outcome === 'stale' || imageState === 'preparing' || (!article && !event)}>
					<ButtonLabel pending={busy} pendingLabel={i18n.m.admin.saving} label={pending ? (restored ? m.finish : m.retrySave) : m.save} reserveLabels={[m.save, m.retrySave, m.finish]} />
				</Button>
				{#if outcome === 'stale'}<Button type="button" variant="outline" disabled={busy} onclick={reload}>{m.reload}</Button>{/if}
				<Button variant="ghost" href={i18n.href('/admin/news')}>{m.heading}</Button>
			</div>
			<div class={formStatus} aria-live="polite">
				{#if outcome === 'saved'}<StateBadge tone="success">{i18n.m.admin.saved}</StateBadge>
				{:else if outcome !== 'idle'}<Alert.Message appearance="inline" variant="destructive">{messages[outcome]}</Alert.Message>{/if}
			</div>
		</div>
	</form>
{/if}
