import type { QueryCtx } from '../_generated/server';
import { image } from './audit';
import { byUuid } from './ids';

const auditNumber = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

export type ArchivedBinLocation = {
	bin_id: string; cabinet_id: string; cabinet_code: string; cabinet_label: string | null;
	cabinet_outer_row: number | null; cabinet_outer_col: number | null;
	inner_row: number | null; inner_col: number | null; row_span: number | null; col_span: number | null;
};

/**
 * Where an archived drawer used to be: the image before its latest archive, in
 * the cabinet as it was at that moment (amp_archived_bin_locations). Imported
 * audit images hold numbers as strings, newer ones as numbers.
 */
export async function archivedBinLocation(ctx: QueryCtx, binId: string): Promise<ArchivedBinLocation | null> {
	const bin = await byUuid(ctx, 'bins', binId);
	if (!bin?.is_archived) return null;
	const history = await ctx.db.query('audit_log').withIndex('table_row', (q) => q.eq('table_name', 'bins').eq('row_id', binId)).order('desc').collect();
	const archive = history.find((a) => a.action === 'UPDATE' && a.before_data?.is_archived === false && a.after_data?.is_archived === true);
	if (!archive) return null;
	const cabinetId = archive.before_data.cabinet_id as string;
	const cabinet = await byUuid(ctx, 'cabinets', cabinetId);
	if (!cabinet) return null;
	const cabinetHistory = await ctx.db.query('audit_log').withIndex('table_row', (q) => q.eq('table_name', 'cabinets').eq('row_id', cabinetId)).collect();
	const state = cabinetHistory.filter((a) => a.id < archive.id).at(-1)?.after_data ?? cabinetHistory.find((a) => a.id > archive.id)?.before_data ?? image(cabinet);
	return { bin_id: bin.id, cabinet_id: cabinetId, cabinet_code: String(state.code), cabinet_label: (state.label ?? null) as string | null,
		cabinet_outer_row: auditNumber(state.outer_row), cabinet_outer_col: auditNumber(state.outer_col),
		inner_row: auditNumber(archive.before_data.inner_row), inner_col: auditNumber(archive.before_data.inner_col),
		row_span: auditNumber(archive.before_data.row_span), col_span: auditNumber(archive.before_data.col_span) };
}
