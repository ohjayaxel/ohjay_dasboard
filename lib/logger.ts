import { AsyncLocalStorage } from 'async_hooks'
import crypto from 'crypto'
import pino from 'pino'

type LogContext = Record<string, unknown>

type RequestScope = {
  requestId?: string
}

const storage = new AsyncLocalStorage<RequestScope>()

export type Logger = {
  debug: (context: LogContext, message: string) => void
  info: (context: LogContext, message: string) => void
  warn: (context: LogContext, message: string) => void
  error: (context: LogContext, message: string) => void
  createChild: (context: LogContext) => Logger
}

const baseLogger = (() => {
  try {
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: {
        service: 'meta',
      },
      transport:
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:standard',
              },
            }
          : undefined,
    })
  } catch {
    return null
  }
})()

function withBaseContext(context: LogContext): LogContext {
  const scope = storage.getStore()
  const requestId = scope?.requestId
  return {
    ts: new Date().toISOString(),
    requestId,
    ...context,
  }
}

function emit(level: 'debug' | 'info' | 'warn' | 'error', context: LogContext, message: string) {
  const payload = withBaseContext(context)

  if (baseLogger) {
    if (level === 'debug' && typeof baseLogger.debug !== 'function') {
      baseLogger.info({ ...payload, level: 'debug' }, message)
      return
    }
    baseLogger[level](payload, message)
    return
  }

  const line = `[${level.toUpperCase()}] ${message}`
  switch (level) {
    case 'debug': {
      console.debug(line, payload)
      break
    }
    case 'warn': {
      console.warn(line, payload)
      break
    }
    case 'error': {
      console.error(line, payload)
      break
    }
    default: {
      console.info(line, payload)
    }
  }
}

function createLogger(context: LogContext = {}): Logger {
  return {
    debug(additionalContext, message) {
      emit('debug', { ...context, ...additionalContext }, message)
    },
    info(additionalContext, message) {
      emit('info', { ...context, ...additionalContext }, message)
    },
    warn(additionalContext, message) {
      emit('warn', { ...context, ...additionalContext }, message)
    },
    error(additionalContext, message) {
      emit('error', { ...context, ...additionalContext }, message)
    },
    createChild(childContext) {
      return createLogger({ ...context, ...childContext })
    },
  }
}

export function withRequestContext<T>(fn: () => Promise<T>, requestId?: string): Promise<T> {
  const id = requestId ?? crypto.randomUUID()
  return storage.run({ requestId: id }, fn)
}

export const logger = createLogger()

