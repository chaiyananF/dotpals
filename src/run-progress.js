// Shared execution clock for the broker and Tasks UI; no timer changes policy.
export const DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function runTiming(job, now = Date.now()) {
  const started = time(job.startedAt);
  const active = job.status === 'running';
  const end = active ? now : time(job.finishedAt);
  const timeoutMs = job.progress?.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  const deadline = active && started !== null ? started + timeoutMs : null;
  const last = time(job.progress?.lastActivityAt);
  return {
    timeoutMs,
    elapsedMs: job.status !== 'queued' && started !== null && end !== null ? Math.max(0, end - started) : null,
    remainingMs: deadline !== null ? Math.max(0, deadline - now) : null,
    deadlineAt: deadline !== null ? new Date(deadline).toISOString() : null,
    quietForMs: last !== null && end !== null && job.status !== 'queued' ? Math.max(0, end - last) : null,
  };
}
