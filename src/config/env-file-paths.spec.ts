import { resolveEnvFilePaths } from './env-file-paths';

describe('resolveEnvFilePaths', () => {
  it('puts the env-specific file before the shared .env (development)', () => {
    expect(resolveEnvFilePaths('development')).toEqual([
      '.env.development',
      '.env',
    ]);
  });

  it('resolves the test environment', () => {
    expect(resolveEnvFilePaths('test')).toEqual(['.env.test', '.env']);
  });

  it('resolves the production environment', () => {
    expect(resolveEnvFilePaths('production')).toEqual([
      '.env.production',
      '.env',
    ]);
  });

  it('defaults to development when NODE_ENV is undefined', () => {
    expect(resolveEnvFilePaths(undefined)).toEqual([
      '.env.development',
      '.env',
    ]);
  });

  it('defaults to development when NODE_ENV is an empty string', () => {
    expect(resolveEnvFilePaths('')).toEqual(['.env.development', '.env']);
  });
});
