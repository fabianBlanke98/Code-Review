function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export const config = {
  // Direct Postgres connection using the service role. The worker is the only
  // component that bypasses RLS, so this string never leaves the container.
  databaseUrl: required('DATABASE_URL'),

  r2: {
    endpoint: required('R2_ENDPOINT'),
    bucket: required('R2_BUCKET'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    region: process.env.R2_REGION ?? 'auto',
  },

  workerId: process.env.FLY_MACHINE_ID ?? `local-${process.pid}`,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 2000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 5),

  expoPushUrl: process.env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',
  pushCooldownMinutes: Number(process.env.PUSH_COOLDOWN_MINUTES ?? 60),
};
