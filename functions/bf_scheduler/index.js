'use strict';
/**
 * Job function for Catalyst Job Scheduling.
 * Create cron jobs that pass the job param  task = sync_metrics | auto_release | reminders
 * (or leave it empty to run all three).
 */
const TASKS = ['sync_metrics', 'auto_release', 'reminders'];

module.exports = async (jobRequest, context) => {
  let task;
  try {
    const params = (jobRequest && jobRequest.getAllJobParams && jobRequest.getAllJobParams()) || {};
    task = params.task;
  } catch { /* no params */ }
  const tasks = task ? [task] : TASKS;
  let failed = false;
  for (const t of tasks) {
    try {
      const res = await fetch(`${process.env.API_BASE}/internal/run/${t}`, {
        method: 'POST',
        headers: { 'x-scheduler-secret': process.env.SCHEDULER_SECRET || '' },
      });
      const body = await res.text();
      console.log(`[bf_scheduler] ${t} → ${res.status} ${body.slice(0, 1000)}`);
      if (!res.ok) failed = true;
    } catch (e) {
      failed = true;
      console.error(`[bf_scheduler] ${t} failed`, e);
    }
  }
  if (failed) context.closeWithFailure(); else context.closeWithSuccess();
};
