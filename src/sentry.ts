import * as Sentry from '@sentry/react'

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN
const APP_ENV = import.meta.env.VITE_APP_ENV || 'development'
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'

export function initSentry() {
  if (!SENTRY_DSN) {
    if (import.meta.env.DEV) {
      console.warn('[Sentry] VITE_SENTRY_DSN not set, skipping initialization')
    }
    return
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    release: APP_VERSION,
    environment: APP_ENV,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: APP_ENV === 'production' ? 0.1 : 1.0,
    sampleRate: 1.0,
    beforeSend(event) {
      if (event.request?.url?.includes('localhost')) {
        return null
      }
      return event
    },
  })
}

export const captureException = Sentry.captureException
export const captureMessage = Sentry.captureMessage
