import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Capture 100% of commit pipelines so every compression trace is visible.
  // Override per-env with SENTRY_TRACES_SAMPLE_RATE if needed.
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 1.0,
  // Profile the sharp/diff/reconcile work behind each commit transaction.
  profilesSampleRate: 1.0,
  sendDefaultPii: false,
  debug: false,
  enabled: !!process.env.SENTRY_DSN,
});
