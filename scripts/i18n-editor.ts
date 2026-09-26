/**
 * Side-by-side editor for the message dictionaries in src/lib/i18n/.
 *
 *   bun run i18n        # http://localhost:5175
 *
 * A local development tool, never part of the deployed site. It parses nb.ts and
 * en.ts with the TypeScript compiler, lists every string in both languages next
 * to each other, and writes edits straight back into the source files.
 *
 * It replaces only the string literals you actually changed, so comments,
 * formatting, arrow functions and untouched strings stay byte for byte the same.
 * It does not reflow long lines; run your formatter afterwards if you care.
 *
 * Runs on Bun only and sits outside the app's type-check scope (`scripts/**` is
 * excluded in tsconfig.json), so an editor without `@types/bun` will flag `Bun`
 * and `process` here. `bun run i18n` still works.
 *
 * See docs/i18n.md.
 */

import ts from 'typescript';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = join(ROOT, 'src/lib/i18n');
const LOCALES = ['nb', 'en'] as const;
type Locale = (typeof LOCALES)[number];

const PORT = Number(process.env.PORT ?? 5175);
// Binds to 127.0.0.1 by default, requiring explicit HOST override to reach from
// other machines. It writes to src/lib/i18n/, so do not expose it wider.
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Accepted `Host` headers, the same protection Vite's `allowedHosts` gives the
 * dev server: without it any web page could resolve a name it owns to this
 * address and POST edits into the source files from the visitor's browser.
 * `i18n.ampoteket.no` is the Caddy site that fronts this on the tailnet.
 * Override for a one-off name with `ALLOWED_HOSTS=a.example,b.example`.
 */
const ALLOWED_HOSTS = new Set(
	(process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1],i18n.ampoteket.no,100.106.184.0')
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean)
);

/** Hostname only: the port is not part of the rebinding question. */
function hostAllowed(req: Request): boolean {
	const host = (req.headers.get('host') ?? '').toLowerCase();
	const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
	return ALLOWED_HOSTS.has(name) || name.endsWith('.ts.net');
}

/** Parse and validate the Origin header the same way as Host. */
function originAllowed(req: Request): boolean {
	const origin = req.headers.get('origin');
	if (!origin) return false;
	try {
		const url = new URL(origin);
		const name = url.hostname.toLowerCase();
		return ALLOWED_HOSTS.has(name) || name.endsWith('.ts.net');
	} catch {
		return false;
	}
}

/** Characters that must stay escaped in the source, or a reader cannot see them. */
const INVISIBLE = new Set([
	0x00a0, // no-break space
	0x00ad, // soft hyphen
	0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero width / bidi marks
	0x2028, 0x2029, // line / paragraph separator
	0x202f, 0x2060, 0xfeff
]);

type Slot = {
	/** Dotted path, array indices included: `home.shelf.steps.0.title`. */
	key: string;
	/** `string` values round-trip through the value; `template` keeps its raw source. */
	kind: 'string' | 'template';
	/** Parameter list when the message is a function, e.g. `(n: number)`. */
	fn?: string;
	/** Leading `//` or `/** *\/` comment on the property, as a hint for translators. */
	note?: string;
	/** Text the editor shows. */
	value: string;
	/** Source range this slot owns (whole literal for strings, inside the backticks for templates). */
	start: number;
	end: number;
};

// ---------------------------------------------------------------- parsing

async function readDictionary(locale: Locale) {
	const file = join(I18N_DIR, `${locale}.ts`);
	const source = await Bun.file(file).text();
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const slots = new Map<string, Slot>();

	const root = findDictionary(sf, locale);
	if (!root) throw new Error(`Could not find \`export const ${locale} = { ... }\` in ${file}`);
	walkObject(root, [], slots, source);

	return { file, source, slots };
}

/** The object literal of `export const <locale>[: Messages] = { ... }`. */
function findDictionary(sf: ts.SourceFile, locale: Locale): ts.ObjectLiteralExpression | undefined {
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name) || decl.name.text !== locale) continue;
			if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) return decl.initializer;
		}
	}
	return undefined;
}

function walkObject(
	node: ts.ObjectLiteralExpression,
	path: string[],
	slots: Map<string, Slot>,
	source: string
) {
	for (const prop of node.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const name = propertyName(prop.name);
		if (name === undefined) continue;
		walkValue(prop.initializer, [...path, name], slots, source, leadingComment(prop, source));
	}
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined;
}

function walkValue(
	node: ts.Node,
	path: string[],
	slots: Map<string, Slot>,
	source: string,
	note?: string,
	fn?: string
) {
	const key = path.join('.');

	if (ts.isStringLiteral(node)) {
		slots.set(key, { key, kind: 'string', fn, note, value: node.text, start: node.getStart(), end: node.getEnd() });
		return;
	}
	if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
		const start = node.getStart() + 1; // inside the opening backtick
		const end = node.getEnd() - 1;
		slots.set(key, { key, kind: 'template', fn, note, value: source.slice(start, end), start, end });
		return;
	}
	if (ts.isObjectLiteralExpression(node)) {
		walkObject(node, path, slots, source);
		return;
	}
	if (ts.isArrayLiteralExpression(node)) {
		node.elements.forEach((el, i) => walkValue(el, [...path, String(i)], slots, source, note));
		return;
	}
	if (ts.isArrowFunction(node)) {
		const params = node.parameters.map((p) => p.getText()).join(', ');
		walkValue(node.body, path, slots, source, note, `(${params})`);
		return;
	}
	if (ts.isParenthesizedExpression(node)) {
		walkValue(node.expression, path, slots, source, note, fn);
	}
	// Numbers, booleans and anything else are not translatable copy; skip them.
}

function leadingComment(node: ts.Node, source: string): string | undefined {
	const ranges = ts.getLeadingCommentRanges(source, node.getFullStart());
	if (!ranges?.length) return undefined;
	const text = ranges
		.map((r) => source.slice(r.pos, r.end))
		.join('\n')
		.replace(/^\s*\/\*\*?/gm, '')
		.replace(/\*\/\s*$/gm, '')
		.replace(/^\s*\*\s?/gm, '')
		.replace(/^\s*\/\/\s?/gm, '')
		.trim();
	return text || undefined;
}

// ---------------------------------------------------------------- writing

/**
 * Serialise a value as a TypeScript string literal, in the repository's style:
 * single quotes unless the text itself contains one and no double quote, and
 * invisible characters (soft hyphen, NBSP, zero width) kept as \uXXXX escapes so
 * the next reader can see that they are there.
 */
function quote(value: string): string {
	const q = value.includes("'") && !value.includes('"') ? '"' : "'";
	let out = q;
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === '\\') out += '\\\\';
		else if (ch === q) out += '\\' + q;
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (code < 0x20 || INVISIBLE.has(code)) out += '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
		else out += ch;
	}
	return out + q;
}

/** A template stays raw source, so `${n}` survives; a stray backtick would break the file. */
function checkTemplate(key: string, raw: string) {
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === '\\') { i++; continue; }
		if (raw[i] === '`') throw new Error(`${key}: unescaped backtick in a template message. Write \\\` instead.`);
	}
	const opens = (raw.match(/(^|[^\\])\$\{/g) ?? []).length;
	const closes = (raw.match(/\}/g) ?? []).length;
	if (opens > closes) throw new Error(`${key}: unbalanced \${ ... } in a template message.`);
}

type Edit = { locale: Locale; key: string; value: string };

async function save(edits: Edit[]) {
	const touched: string[] = [];

	for (const locale of LOCALES) {
		const mine = edits.filter((e) => e.locale === locale);
		if (!mine.length) continue;

		// Re-parse now, so an edit made in an editor meanwhile cannot corrupt offsets.
		const { file, source, slots } = await readDictionary(locale);

		const patches = mine.flatMap(({ key, value }) => {
			const slot = slots.get(key);
			if (!slot) throw new Error(`${locale}.ts no longer has the key \`${key}\`. Reload the page.`);
			// Leave a string whose text did not change exactly as its author wrote it,
			// escapes, quote style and all.
			if (slot.value === value) return [];
			if (slot.kind === 'template') checkTemplate(key, value);
			return [{ start: slot.start, end: slot.end, text: slot.kind === 'template' ? value : quote(value) }];
		});

		let next = source;
		for (const p of patches.sort((a, b) => b.start - a.start)) {
			next = next.slice(0, p.start) + p.text + next.slice(p.end);
		}
		if (next === source) continue;

		const check = ts.createSourceFile(file, next, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const errors = (check as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ?? [];
		if (errors.length) {
			const first = ts.flattenDiagnosticMessageText(errors[0].messageText, ' ');
			throw new Error(`Refused to write ${locale}.ts: the result would not parse (${first}).`);
		}

		await Bun.write(file, next);
		touched.push(`${locale}.ts`);
	}

	return touched;
}

// ---------------------------------------------------------------- rows

async function rows() {
	const dicts = Object.fromEntries(
		await Promise.all(LOCALES.map(async (l) => [l, await readDictionary(l)] as const))
	) as Record<Locale, Awaited<ReturnType<typeof readDictionary>>>;

	// nb is the source language, so its order is the order of the page.
	const keys = [...dicts.nb.slots.keys()];
	for (const key of dicts.en.slots.keys()) if (!keys.includes(key)) keys.push(key);

	return keys.map((key) => {
		const nb = dicts.nb.slots.get(key);
		const en = dicts.en.slots.get(key);
		const ref = nb ?? en!;
		return {
			key,
			section: key.split('.')[0],
			kind: ref.kind,
			fn: nb?.fn ?? en?.fn ?? null,
			note: nb?.note ?? en?.note ?? null,
			nb: nb?.value ?? null,
			en: en?.value ?? null
		};
	});
}

// ---------------------------------------------------------------- server

const PAGE = await Bun.file(join(dirname(fileURLToPath(import.meta.url)), 'i18n-editor.html')).text();

const server = Bun.serve({
	port: PORT,
	hostname: HOST,
	async fetch(req) {
		const url = new URL(req.url);

		if (!hostAllowed(req)) {
			return new Response(
				`Host "${req.headers.get('host') ?? ''}" is not allowed. Add it to ALLOWED_HOSTS to use this name.\n`,
				{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
			);
		}

		if (url.pathname === '/') {
			return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}

		if (url.pathname === '/api/rows') {
			try {
				return Response.json({ rows: await rows() });
			} catch (err) {
				return Response.json({ error: String((err as Error).message ?? err) }, { status: 500 });
			}
		}

		if (url.pathname === '/api/save' && req.method === 'POST') {
			if (!originAllowed(req)) {
				const origin = req.headers.get('origin') ?? '(none)';
				return new Response(
					`Origin "${origin}" is not allowed. Add it to ALLOWED_HOSTS to use it.\n`,
					{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
				);
			}
			try {
				const { edits } = (await req.json()) as { edits: Edit[] };
				const written = await save(edits ?? []);
				return Response.json({ written, rows: await rows() });
			} catch (err) {
				return Response.json({ error: String((err as Error).message ?? err) }, { status: 400 });
			}
		}

		return new Response('Not found', { status: 404 });
	}
});

const counts = await rows();
console.log(`i18n editor  http://localhost:${server.port}`);
console.log(`${counts.length} strings from src/lib/i18n/{${LOCALES.join(',')}}.ts  (ctrl+c to stop)`);
