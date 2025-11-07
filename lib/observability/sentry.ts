let isInitialized = false;

type SentryModule = typeof import('@sentry/nextjs');

async function loadSentry(): Promise<SentryModule | null> {
  try {
    return await import('@sentry/nextjs');
  } catch (error) {
    console.warn('Sentry module not installed; skipping init.', error);
    return null;
  }
}

export async function initSentry() {
  if (isInitialized) {
    return;
  }

  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.info('Sentry DSN missing; telemetry disabled.');
    return;
  }

  const sentry = await loadSentry();
  if (!sentry) {
    return;
  }

  sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? 'development',
    tracesSampleRate: 0.05,
    enableTracing: true,
  });

  isInitialized = true;
}

export async function captureException(error: unknown, context?: Record<string, unknown>) {
  const sentry = await loadSentry();
  if (!sentry) {
    console.error('Error captured (Sentry disabled):', error, context);
    return;
  }

  sentry.captureException(error, { extra: context });
}

