import pino from 'pino'

type LogContext = Record<string, unknown>

export type Logger = {
  info: (context: LogContext, message: string) => void
  warn: (context: LogContext, message: string) => void
  error: (context: LogContext, message: string) => void
}

const baseLogger = (() => {
  try {
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: { colorize: true },
            }
          : undefined,
    })
  } catch {
    return null
  }
})()

function withTimestamp(context: LogContext): LogContext {
  return {
    timestamp: new Date().toISOString(),
    ...context,
  }
}

export const logger: Logger = {
  info(context, message) {
    const payload = withTimestamp(context)
    if (baseLogger) {
      baseLogger.info(payload, message)
    } else {
      console.info(message, payload)
    }
  },
  warn(context, message) {
    const payload = withTimestamp(context)
    if (baseLogger) {
      baseLogger.warn(payload, message)
    } else {
      console.warn(message, payload)
    }
  },
  error(context, message) {
    const payload = withTimestamp(context)
    if (baseLogger) {
      baseLogger.error(payload, message)
    } else {
      console.error(message, payload)
    }
  },
}

