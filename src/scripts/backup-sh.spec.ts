import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// scripts/backup.sh must reject bad RETENTION_DAYS / BACKUP_INTERVAL BEFORE any
// pg_dump: under `restart: unless-stopped` a post-dump failure would re-dump on
// every restart. pg_dump / sleep / mkdir are PATH stubs that only record calls.
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'backup.sh');

describe('scripts/backup.sh config guard', () => {
  let bin: string;
  let calls: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'backup-sh-'));
    calls = join(bin, 'calls.log');
    const stub = (name: string, exitCode: number) => {
      const p = join(bin, name);
      writeFileSync(
        p,
        `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit ${exitCode}\n`,
      );
      chmodSync(p, 0o755);
    };
    stub('pg_dump', 1); // stop the loop right after the first dump attempt
    stub('sleep', 0);
    stub('mkdir', 0);
  });

  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  const run = (env: Record<string, string | undefined>) => {
    const res = spawnSync('sh', [SCRIPT], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PGHOST: 'db',
        PGUSER: 'accounting',
        PGDATABASE: 'accounting',
        ...env,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    return { status: res.status, stderr: res.stderr, log };
  };

  it.each([
    ['RETENTION_DAYS', 'abc'],
    ['RETENTION_DAYS', '"30"'],
    ['RETENTION_DAYS', '0'],
    ['RETENTION_DAYS', '-1'],
    ['RETENTION_DAYS', '1.5'],
    ['RETENTION_DAYS', ' 7'],
    ['BACKUP_INTERVAL', 'abc'],
    ['BACKUP_INTERVAL', '"3600"'],
    ['BACKUP_INTERVAL', '59'],
    ['BACKUP_INTERVAL', '0'],
  ])('%s=%s exits 64 after a 60s pause, without pg_dump', (key, value) => {
    const { status, stderr, log } = run({ [key]: value });
    expect(status).toBe(64);
    expect(stderr).toContain(key);
    expect(stderr).toContain('no dump taken');
    expect(log).not.toContain('pg_dump');
    expect(log).toContain('sleep 60');
  });

  it.each([
    [{}],
    [{ RETENTION_DAYS: '', BACKUP_INTERVAL: '' }],
    [{ RETENTION_DAYS: '30', BACKUP_INTERVAL: '60' }],
  ])('valid/defaulted config %j reaches pg_dump', (env) => {
    const { status, log } = run(env);
    expect(log).toContain('pg_dump -Fc -h db -U accounting -d accounting');
    expect(log).not.toContain('sleep 60');
    expect(status).toBe(1); // the stubbed pg_dump failure, under set -e
  });
});
