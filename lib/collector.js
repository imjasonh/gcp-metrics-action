const github = require('@actions/github');
const core = require('@actions/core');

/**
 * Collects metrics from GitHub Actions workflow
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {Object} context - GitHub context
 * @returns {Promise<Object>} Collected metrics
 */
async function collectMetrics(octokit, context) {
  const { owner, repo } = context.repo;
  const runId = context.runId;

  core.info(`Collecting metrics for run ${runId} in ${owner}/${repo}`);

  try {
    // Fetch job information for the current run
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    core.debug(`Found ${jobs.jobs.length} jobs`);

    // Find the current job by matching the job name or ID
    // GitHub Actions doesn't expose the current job ID directly, so we try to match by name
    const currentJobName = process.env.GITHUB_JOB;
    const currentJob = jobs.jobs.find(job => job.name === currentJobName);

    if (!currentJob) {
      core.warning(`Could not find current job "${currentJobName}". Using first job as fallback.`);
    }

    const job = currentJob || jobs.jobs[0];

    if (!job) {
      throw new Error('No jobs found for this workflow run');
    }

    core.info(`Analyzing job: ${job.name} (${job.id})`);

    // Parse steps and calculate durations
    const steps = (job.steps || []).map(step => {
      const startedAt = step.started_at ? new Date(step.started_at) : null;
      const completedAt = step.completed_at ? new Date(step.completed_at) : null;
      const durationMs = startedAt && completedAt ? completedAt - startedAt : 0;

      return {
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        startedAt,
        completedAt,
        durationMs,
      };
    });

    // Calculate job duration
    const jobStartedAt = job.started_at ? new Date(job.started_at) : null;
    const jobCompletedAt = job.completed_at ? new Date(job.completed_at) : null;
    const jobDurationMs = jobStartedAt && jobCompletedAt ? jobCompletedAt - jobStartedAt : 0;

    const metrics = {
      workflow: context.workflow,
      job: {
        name: job.name,
        id: job.id,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: jobStartedAt,
        completedAt: jobCompletedAt,
        durationMs: jobDurationMs,
      },
      steps,
      repository: {
        owner,
        repo,
        fullName: `${owner}/${repo}`,
      },
      run: {
        id: runId,
        number: context.runNumber,
        attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
      },
    };

    core.debug(`Collected metrics: ${JSON.stringify(metrics, null, 2)}`);
    return metrics;
  } catch (error) {
    core.error(`Failed to collect metrics: ${error.message}`);
    throw error;
  }
}

/**
 * Collects job logs from GitHub Actions workflow
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {Object} context - GitHub context
 * @param {number} jobId - Job ID
 * @returns {Promise<Array>} Parsed log entries with timestamps
 */
async function collectLogs(octokit, context, jobId) {
  const { owner, repo } = context.repo;

  core.info(`Collecting logs for job ${jobId}`);

  try {
    // Download job logs
    const response = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });

    // The response is a redirect URL or direct log content
    const logText = response.data;

    if (!logText || typeof logText !== 'string') {
      core.warning('No logs available or unexpected log format');
      return [];
    }

    // Parse logs - GitHub Actions logs have format:
    // 2025-11-05T15:49:00.1234567Z log message here
    const logLines = logText.split('\n');
    const parsedLogs = [];

    let currentStep = 'unknown';

    for (const line of logLines) {
      // Extract timestamp from log line (ISO 8601 format)
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);

      if (timestampMatch) {
        const [, timestamp, message] = timestampMatch;

        // Detect step boundaries (GitHub Actions marks these)
        if (message.includes('##[group]Run ')) {
          const stepMatch = message.match(/##\[group\]Run (.+)/);
          if (stepMatch) {
            currentStep = stepMatch[1];
          }
        }

        parsedLogs.push({
          timestamp: new Date(timestamp),
          message: message,
          step: currentStep,
        });
      }
    }

    core.info(`Parsed ${parsedLogs.length} log lines`);
    return parsedLogs;

  } catch (error) {
    core.warning(`Failed to collect detailed logs: ${error.message}`);
    core.info('This is expected - GitHub Actions may not make job logs available via API yet');
    core.info('Will use summary log entries instead (one per job/step)');
    return [];
  }
}

module.exports = { collectMetrics, collectLogs };
