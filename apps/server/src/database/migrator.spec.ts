import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadMigrations, migrationChecksum, MIGRATIONS_DIR } from './migrator';

describe('migration checksums', () => {
  it('are the same for LF and CRLF checkouts of a migration', () => {
    const lf = readFileSync(join(MIGRATIONS_DIR, '001_compliance_core.sql'), 'utf8');
    expect(lf.includes('\r\n')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'nxgen-mig-'));
    writeFileSync(join(dir, '001_compliance_core.sql'), lf.replace(/\n/g, '\r\n'));
    const [crlf] = loadMigrations(dir);
    const [original] = loadMigrations().filter((m) => m.version === 1);
    expect(crlf.checksum).toBe(original.checksum);
  });

  it('still change for any other edit', () => {
    expect(migrationChecksum('SELECT 1;\n')).not.toBe(migrationChecksum('SELECT  1;\n'));
  });
});
