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

module.exports = { collectMetrics };
