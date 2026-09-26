import { spawnSync } from 'child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
        BACKUP_DIR: bin, // exists (mkdir is stubbed)
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

// The dump is written to `<name>.tmp` and renamed only once pg_dump succeeded,
// so an interrupted / failed dump never looks like the newest backup.
describe('scripts/backup.sh atomic dump', () => {
  let root: string;
  let bin: string;
  let backups: string;
  let metrics: string;
  let calls: string;

  /** pg_dump stub: writes "partial" to its `-f` file, then exits `code`. */
  const pgDumpStub = (code: number) =>
    `#!/bin/sh\necho "pg_dump $*" >> "${calls}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-f" ] && out="$2"; shift; done\nprintf partial > "$out"\nexit ${code}\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'backup-atomic-'));
    bin = join(root, 'bin');
    backups = join(root, 'backups');
    metrics = join(root, 'metrics');
    calls = join(root, 'calls.log');
    for (const d of [bin, backups, metrics]) mkdirSync(d);
    // `sleep <interval>` fails to end the loop after one full iteration.
    writeFileSync(join(bin, 'sleep'), `#!/bin/sh\nexit 3\n`);
    chmodSync(join(bin, 'sleep'), 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** age stub: writes "partial" to its `-o` file, then exits `code`. */
  const ageStub = (code: number) =>
    `#!/bin/sh\necho "age $*" >> "${calls}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf partial > "$out"\nexit ${code}\n`;

  const run = (
    pgDumpExit: number,
    opts: { ageExit?: number; env?: Record<string, string> } = {},
  ) => {
    writeFileSync(join(bin, 'pg_dump'), pgDumpStub(pgDumpExit));
    chmodSync(join(bin, 'pg_dump'), 0o755);
    if (opts.ageExit !== undefined) {
      writeFileSync(join(bin, 'age'), ageStub(opts.ageExit));
      chmodSync(join(bin, 'age'), 0o755);
    }
    const res = spawnSync('sh', [SCRIPT], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PGHOST: 'db',
        PGUSER: 'accounting',
        PGDATABASE: 'accounting',
        BACKUP_DIR: backups,
        BACKUP_METRICS_DIR: metrics,
        ...opts.env,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      status: res.status,
      stderr: res.stderr,
      files: readdirSync(backups),
      log: readFileSync(calls, 'utf8'),
    };
  };

  it('pg_dump writes to <name>.tmp; success renames it to accounting-<ts>.dump', () => {
    const { status, files, log } = run(0);
    expect(log).toMatch(/-f \S+\/accounting-\d{8}T\d{6}Z\.dump\.tmp$/m);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^accounting-\d{8}T\d{6}Z\.dump$/);
    expect(existsSync(join(metrics, 'backup.prom'))).toBe(true);
    expect(status).toBe(3); // the stubbed `sleep <interval>`
  });

  it('a failed dump leaves no dump file behind (neither .dump nor .tmp) and no success metric', () => {
    const { status, files } = run(1);
    expect(status).not.toBe(0);
    expect(files).toEqual([]);
    expect(existsSync(join(metrics, 'backup.prom'))).toBe(false);
  });

  it('a stale .tmp from an interrupted earlier run is removed at start', () => {
    writeFileSync(join(backups, 'accounting-20260101T000000Z.dump.tmp'), 'x');
    const { files } = run(0);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toHaveLength(1);
  });

  // age encryption uses the same tmp+rename: `age -o <name>.dump.age.tmp`, then
  // mv — an interrupted/failed age run never leaves a truncated `.dump.age`.
  const AGE = { BACKUP_AGE_RECIPIENT: 'age1testrecipient' };

  it('age encrypts to <name>.dump.age.tmp; success renames it and drops the plaintext', () => {
    const { status, files, log } = run(0, { ageExit: 0, env: AGE });
    expect(log).toMatch(
      /^age -r age1testrecipient -o \S+\/accounting-\d{8}T\d{6}Z\.dump\.age\.tmp \S+\/accounting-\d{8}T\d{6}Z\.dump$/m,
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^accounting-\d{8}T\d{6}Z\.dump\.age$/);
    expect(existsSync(join(metrics, 'backup.prom'))).toBe(true);
    expect(status).toBe(3);
  });

  it('a failed age run leaves no .age / .age.tmp and keeps the plaintext dump', () => {
    const { status, files, stderr } = run(0, { ageExit: 1, env: AGE });
    expect(stderr).toContain('age encryption failed');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^accounting-\d{8}T\d{6}Z\.dump$/);
    expect(status).toBe(3);
  });

  // With a recipient configured, a dump that is NOT encrypted (age failed or is
  // missing) must never leave the host: offsite upload is skipped for that run.
  /** offsite stub: records its argv, exits 0. */
  const offsiteStub = (name: string) => {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };

  it.each([
    ['aws', { BACKUP_S3_BUCKET: 'bkt/acct' }],
    ['rsync', { BACKUP_RSYNC_TARGET: 'u@h:/b/' }],
  ])(
    'age fails + %s target set: plaintext is NOT shipped offsite',
    (tool, target) => {
      offsiteStub(tool);
      const { status, files, stderr, log } = run(0, {
        ageExit: 1,
        env: { ...AGE, ...target },
      });
      expect(log).not.toMatch(new RegExp(`^${tool} `, 'm'));
      expect(stderr).toContain('not shipped offsite: encryption failed');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^accounting-\d{8}T\d{6}Z\.dump$/);
      expect(existsSync(join(metrics, 'backup.prom'))).toBe(true);
      expect(status).toBe(3);
    },
  );

  it('recipient set but age missing + s3 target: plaintext is NOT shipped offsite', () => {
    offsiteStub('aws');
    const { stderr, log } = run(0, {
      env: { ...AGE, BACKUP_S3_BUCKET: 'bkt/acct' },
    });
    expect(log).not.toMatch(/^aws /m);
    expect(stderr).toContain('not shipped offsite: encryption failed');
  });

  it('age succeeds + s3 target: only the .dump.age is uploaded', () => {
    offsiteStub('aws');
    const { log } = run(0, {
      ageExit: 0,
      env: { ...AGE, BACKUP_S3_BUCKET: 'bkt/acct' },
    });
    const uploads = log.split('\n').filter((l) => l.startsWith('aws '));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(
      /^aws s3 cp \S+\/accounting-\d{8}T\d{6}Z\.dump\.age s3:\/\/bkt\/acct\/accounting-\d{8}T\d{6}Z\.dump\.age$/,
    );
  });

  it('no recipient configured: the plaintext dump is uploaded as before', () => {
    offsiteStub('aws');
    const { log } = run(0, { env: { BACKUP_S3_BUCKET: 'bkt/acct' } });
    expect(log).toMatch(/^aws s3 cp \S+\/accounting-\d{8}T\d{6}Z\.dump s3:/m);
  });

  it('a stale .dump.age.tmp from an interrupted earlier encryption is removed at start', () => {
    writeFileSync(
      join(backups, 'accounting-20260101T000000Z.dump.age.tmp'),
      'x',
    );
    const { files } = run(0, { ageExit: 0, env: AGE });
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.dump\.age$/);
  });
});
