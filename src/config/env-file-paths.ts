/**
 * Ordered list of dotenv files ConfigModule loads for a given NODE_ENV.
 *
 * The environment-specific file (`.env.<env>`) is listed first so it takes
 * precedence over the shared base `.env` (in @nestjs/config, the first file
 * that defines a key wins). Real `process.env` still overrides both files, so
 * Docker/compose env and the test harness (`test/setup-env.ts`) are unaffected.
 * Defaults to `development` when NODE_ENV is unset/empty.
 */
export function resolveEnvFilePaths(nodeEnv?: string): string[] {
  const env = nodeEnv && nodeEnv.length > 0 ? nodeEnv : 'development';
  return [`.env.${env}`, '.env'];
}
