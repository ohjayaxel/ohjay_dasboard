export async function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    console.info('Sentry DSN missing; telemetry disabled.')
  }
  // When Sentry is needed, install @sentry/nextjs and replace this no-op implementation.
}

export async function captureException(error: unknown, context?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'production') {
    console.error('Captured exception (Sentry disabled):', error, context)
  }
}
