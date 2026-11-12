/** Central, typed access to environment variables. */

// Load apps/api/.env (variables already set, e.g. by Docker, are kept).
try {
  process.loadEnvFile();
} catch {
  /* no .env file: use the real environment */
}

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
  /** First digits of generated wallet card numbers */
  walletCardPrefix: process.env.WALLET_CARD_PREFIX ?? '8899',
};

if (config.nodeEnv === 'production' && config.jwtAccessSecret.startsWith('change-me')) {
  throw new Error('JWT_ACCESS_SECRET must be set to a strong secret in production');
}

/**
 * Member app login: a one-time code sent to the member's phone.
 *  dev:     the code is returned in the API response and logged (testing only, refused in production)
 *  webhook: the code is POSTed to MEMBER_OTP_WEBHOOK_URL, which sends the SMS (your SMS gateway, Telegram bot...)
 */
export const memberConfig = {
  otpMode: (process.env.MEMBER_OTP_MODE ?? (config.nodeEnv === 'production' ? 'webhook' : 'dev')) as 'dev' | 'webhook',
  otpWebhookUrl: process.env.MEMBER_OTP_WEBHOOK_URL ?? '',
  otpWebhookSecret: process.env.MEMBER_OTP_WEBHOOK_SECRET ?? '',
  otpMinutes: num(process.env.MEMBER_OTP_MINUTES, 5),
  jwtSecret: process.env.MEMBER_JWT_SECRET ?? config.jwtAccessSecret + ':member',
  tokenDays: num(process.env.MEMBER_TOKEN_DAYS, 60),
  brand: process.env.MEMBER_APP_NAME ?? 'our café',
};
if (config.nodeEnv === 'production' && memberConfig.otpMode === 'dev') {
  throw new Error('MEMBER_OTP_MODE=dev shows login codes to anyone and cannot be used in production');
}

/** Time zone used to group report days, e.g. Asia/Phnom_Penh */
export const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE ?? 'UTC';

/**
 * KHQR payments.
 *  manual: cashier confirms after seeing the payment arrive (no Bakong API token needed).
 *  bakong: payment is confirmed automatically through the Bakong Open API.
 */
export const khqrConfig = {
  mode: (process.env.KHQR_MODE === 'bakong' && process.env.BAKONG_TOKEN ? 'bakong' : 'manual') as 'bakong' | 'manual',
  apiUrl: (process.env.BAKONG_API_URL ?? 'https://api-bakong.nbc.gov.kh').replace(/\/$/, ''),
  token: process.env.BAKONG_TOKEN ?? '',
  expiryMinutes: Number(process.env.KHQR_EXPIRY_MINUTES ?? 5),
};

/**
 * ML anomaly detector (monitoring/ml-detector). Production: http://ml-detector:8000 on the internal
 * Docker network (never published). Empty = monitoring shows the detector as not set up.
 */
export const detectorConfig = {
  url: (process.env.DETECTOR_URL ?? 'http://localhost:8000').trim().replace(/\/+$/, ''),
  apiKey: (process.env.DETECTOR_API_KEY ?? '').trim(),
};
