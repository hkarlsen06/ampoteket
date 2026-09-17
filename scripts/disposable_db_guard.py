"""Reject direct runs of mutation tests against anything but our own test container."""

import os
import re
import subprocess


def require_disposable_database() -> None:
    container = os.environ.get('AMPOTEKET_DISPOSABLE_DB_CONTAINER', '')
    port = os.environ.get('PGPORT', '')
    if (os.environ.get('PGHOST') != '127.0.0.1'
            or not re.fullmatch(r'ampoteket-test-[A-Za-z0-9]+', container)
            or not re.fullmatch(r'[0-9]{1,5}', port)):
        raise SystemExit('Run through scripts/test-database.sh, not against an existing database.')
    published = subprocess.run(['docker', 'port', container, '5432/tcp'],
                               capture_output=True, text=True)
    if published.returncode or published.stdout.strip() != f'127.0.0.1:{port}':
        raise SystemExit('Disposable database container/port does not match this connection.')


if __name__ == '__main__':
    require_disposable_database()
