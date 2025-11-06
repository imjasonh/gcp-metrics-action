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
    // Post-action runs before job is marked complete, so estimate using current time
    const jobStartedAt = job.started_at ? new Date(job.started_at) : new Date();
    const jobCompletedAt = job.completed_at ? new Date(job.completed_at) : new Date();
    const jobDurationMs = jobCompletedAt - jobStartedAt;

    if (!job.completed_at) {
      core.debug(`Job not marked complete yet, estimating duration: ${jobDurationMs}ms`);
    }

    // Infer job conclusion from steps if not set (post-action runs before job completes)
    let jobConclusion = job.conclusion;
    if (!jobConclusion || jobConclusion === 'unknown') {
      // Only look at completed steps (ignore pending/in-progress post-action steps)
      const completedSteps = steps.filter(s => s.conclusion !== null);

      const hasFailure = completedSteps.some(s => s.conclusion === 'failure');
      const hasCancelled = completedSteps.some(s => s.conclusion === 'cancelled');

      if (hasFailure) {
        jobConclusion = 'failure';
        core.debug('Inferred job conclusion as "failure" based on failed steps');
      } else if (hasCancelled) {
        jobConclusion = 'cancelled';
        core.debug('Inferred job conclusion as "cancelled" based on cancelled steps');
      } else if (completedSteps.length > 0 && completedSteps.every(s => s.conclusion === 'success' || s.conclusion === 'skipped')) {
        jobConclusion = 'success';
        core.debug(`Inferred job conclusion as "success" based on ${completedSteps.length} completed steps`);
      } else {
        jobConclusion = 'unknown';
        core.debug(`Could not infer job conclusion from steps (${completedSteps.length} completed steps)`);
      }
    }

    // Extract PR number if this is a pull request event
    const prNumber = context.payload?.pull_request?.number ||
                     (process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\/merge/)?.[1]) ||
                     null;

    const metrics = {
      workflow: context.workflow,
      job: {
        name: job.name,
        id: job.id,
        status: job.status || 'in_progress',
        conclusion: jobConclusion,
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
      git: {
        sha: context.sha || process.env.GITHUB_SHA,
        ref: context.ref || process.env.GITHUB_REF,
        refName: process.env.GITHUB_REF_NAME || null,
        baseRef: process.env.GITHUB_BASE_REF || null,
        headRef: process.env.GITHUB_HEAD_REF || null,
      },
      event: {
        name: context.eventName || process.env.GITHUB_EVENT_NAME,
        actor: context.actor || process.env.GITHUB_ACTOR,
        prNumber: prNumber,
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
 * Collects artifacts from GitHub Actions workflow run
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {Object} context - GitHub context
 * @returns {Promise<Array>} Artifact metadata
 */
async function collectArtifacts(octokit, context) {
  const { owner, repo } = context.repo;
  const runId = context.runId;

  core.info(`Checking for artifacts in run ${runId}`);

  try {
    const { data: artifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: runId,
    });

    if (artifacts.artifacts && artifacts.artifacts.length > 0) {
      core.info(`Found ${artifacts.artifacts.length} artifact(s):`);
      artifacts.artifacts.forEach(artifact => {
        core.info(`  - ${artifact.name} (${artifact.size_in_bytes} bytes, expired: ${artifact.expired})`);
      });

      return artifacts.artifacts.map(artifact => ({
        name: artifact.name,
        sizeBytes: artifact.size_in_bytes,
        expired: artifact.expired,
        createdAt: artifact.created_at ? new Date(artifact.created_at) : null,
        expiresAt: artifact.expires_at ? new Date(artifact.expires_at) : null,
      }));
    } else {
      core.info('No artifacts found (this is expected if workflow is still running or no artifacts uploaded)');
      return [];
    }
  } catch (error) {
    core.warning(`Failed to list artifacts: ${error.message}`);
    core.info('Artifacts may not be available while workflow is still in progress');
    return [];
  }
}

module.exports = { collectMetrics, collectArtifacts };
