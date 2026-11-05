/** Central, typed access to environment variables. */
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  jwtRefreshTtlDays: num(process.env.JWT_REFRESH_TTL_DAYS, 30),
  loyaltyEarnRate: num(process.env.LOYALTY_EARN_RATE, 1),
  loyaltyPointValue: num(process.env.LOYALTY_POINT_VALUE, 0.01),
  allowNegativeStock: process.env.ALLOW_NEGATIVE_STOCK === 'true',
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 300),
};

if (config.nodeEnv === 'production' && config.jwtAccessSecret.startsWith('change-me')) {
  throw new Error('JWT_ACCESS_SECRET must be set to a strong secret in production');
}

/** Time zone used to group report days, e.g. Asia/Phnom_Penh */
export const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE ?? 'UTC';
