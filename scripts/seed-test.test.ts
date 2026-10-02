import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('seed startup failure cleans up only its own project and leaves orphaned projects intact', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ampoteket-seed-probe.'));
	const orphan = await mkdtemp(join(tmpdir(), 'ampoteket-seed.'));
	try {
		await mkdir(join(orphan, 'project'));
		await writeFile(join(orphan, 'keep.txt'), 'previous reproduction');
		await writeFile(join(directory, 'stub'), `#!/usr/bin/env bash
printf '%s %s\\n' "\${0##*/}" "$*" >> "$SEED_PROBE_LOG"
case "\${0##*/} $1" in
  'supabase --version') echo 2.116.0 ;;
  'supabase start') exit 1 ;;
  'docker ps') printf 'ampoteket-seed-previous %s/project\\n' "$SEED_PROBE_ORPHAN" ;;
esac
`, { mode: 0o700 });
		for (const name of ['docker', 'supabase']) await symlink(join(directory, 'stub'), join(directory, name));
		const log = join(directory, 'calls');
		const child = Bun.spawn(['bash', 'scripts/seed-test.sh', '--empty', '--studio-port', 'off'], {
			env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SEED_PROBE_LOG: log, SEED_PROBE_ORPHAN: orphan },
			stdout: 'pipe', stderr: 'pipe'
		});
		expect(await child.exited).toBe(1);
		expect(await readFile(join(orphan, 'keep.txt'), 'utf8')).toBe('previous reproduction');
		const calls = await readFile(log, 'utf8');
		expect(calls).not.toContain('docker ps');
		expect(calls).not.toContain('ampoteket-seed-previous');
		expect(calls).toMatch(/supabase stop --project-id ampoteket-seed-/);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(orphan, { recursive: true, force: true });
	}
});
