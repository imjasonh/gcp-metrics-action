const core = require('@actions/core');

/**
 * Finds the current job from the list of jobs
 * @param {Array} jobs - List of jobs
 * @param {string} currentJobName - Name of the current job
 * @returns {Object} The current job or first job as fallback
 */
function findCurrentJob(jobs, currentJobName) {
  const currentJob = jobs.find(job => job.name === currentJobName);
  
  if (!currentJob) {
    core.warning(`Could not find current job "${currentJobName}". Using first job as fallback.`);
  }
  
  const job = currentJob || jobs[0];
  
  if (!job) {
    throw new Error('No jobs found for this workflow run');
  }
  
  return job;
}

/**
 * Fetches repository size from GitHub API
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<number|null>} Repository size in KB or null if unavailable
 */
async function fetchRepositorySize(octokit, owner, repo) {
  try {
    const { data: repoData } = await octokit.rest.repos.get({
      owner,
      repo,
    });
    const size = repoData.size; // Size in KB
    core.debug(`Repository size: ${size} KB`);
    return size;
  } catch (error) {
    core.debug(`Could not fetch repository size: ${error.message}`);
    return null;
  }
}

/**
 * Parses job steps and calculates their durations
 * @param {Array} rawSteps - Raw step data from GitHub API
 * @returns {Array} Parsed steps with calculated durations
 */
function parseSteps(rawSteps) {
  return (rawSteps || []).map(step => {
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
}

/**
 * Calculates job duration, estimating if job is not yet complete
 * @param {Object} job - Job data from GitHub API
 * @returns {Object} Job timing information
 */
function calculateJobDuration(job) {
  const jobStartedAt = job.started_at ? new Date(job.started_at) : new Date();
  const jobCompletedAt = job.completed_at ? new Date(job.completed_at) : new Date();
  const jobDurationMs = jobCompletedAt - jobStartedAt;

  if (!job.completed_at) {
    core.debug(`Job not marked complete yet, estimating duration: ${jobDurationMs}ms`);
  }

  return { jobStartedAt, jobCompletedAt, jobDurationMs };
}

/**
 * Infers job conclusion from completed steps
 * @param {string} jobConclusion - Original job conclusion
 * @param {Array} steps - Parsed steps
 * @returns {string} Inferred or original job conclusion
 */
function inferJobConclusion(jobConclusion, steps) {
  // Return early if we already have a valid conclusion
  if (jobConclusion && jobConclusion !== 'unknown') {
    return jobConclusion;
  }

  // Only look at completed steps (ignore pending/in-progress post-action steps)
  const completedSteps = steps.filter(s => s.conclusion !== null);

  const hasFailure = completedSteps.some(s => s.conclusion === 'failure');
  const hasCancelled = completedSteps.some(s => s.conclusion === 'cancelled');

  if (hasFailure) {
    core.debug('Inferred job conclusion as "failure" based on failed steps');
    return 'failure';
  } else if (hasCancelled) {
    core.debug('Inferred job conclusion as "cancelled" based on cancelled steps');
    return 'cancelled';
  } else if (completedSteps.length > 0 && completedSteps.every(s => s.conclusion === 'success' || s.conclusion === 'skipped')) {
    core.debug(`Inferred job conclusion as "success" based on ${completedSteps.length} completed steps`);
    return 'success';
  } else {
    core.debug(`Could not infer job conclusion from steps (${completedSteps.length} completed steps)`);
    return 'unknown';
  }
}

/**
 * Extracts PR number from context
 * @param {Object} context - GitHub context
 * @returns {string|null} PR number or null
 */
function extractPRNumber(context) {
  return context.payload?.pull_request?.number ||
         (process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\/merge/)?.[1]) ||
         null;
}

/**
 * Builds the metrics object from collected data
 * @param {Object} params - Parameters for building metrics
 * @returns {Object} Complete metrics object
 */
function buildMetricsObject({
  context,
  job,
  jobStartedAt,
  jobCompletedAt,
  jobDurationMs,
  jobConclusion,
  steps,
  repoSize,
  prNumber
}) {
  const { owner, repo } = context.repo;
  
  return {
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
      sizeKB: repoSize,
    },
    run: {
      id: context.runId,
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
    runner: {
      os: process.env.RUNNER_OS || 'unknown',
      arch: process.env.RUNNER_ARCH || 'unknown',
      name: process.env.RUNNER_NAME || null,
      labels: job.labels || [],
    },
  };
}

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

    // Find the current job
    const currentJobName = process.env.GITHUB_JOB;
    const job = findCurrentJob(jobs.jobs, currentJobName);
    core.info(`Analyzing job: ${job.name} (${job.id})`);

    // Fetch repository size
    const repoSize = await fetchRepositorySize(octokit, owner, repo);

    // Parse steps and calculate durations
    const steps = parseSteps(job.steps);

    // Calculate job duration
    const { jobStartedAt, jobCompletedAt, jobDurationMs } = calculateJobDuration(job);

    // Infer job conclusion from steps if not set
    const jobConclusion = inferJobConclusion(job.conclusion, steps);

    // Extract PR number if available
    const prNumber = extractPRNumber(context);

    // Build and return the metrics object
    const metrics = buildMetricsObject({
      context,
      job,
      jobStartedAt,
      jobCompletedAt,
      jobDurationMs,
      jobConclusion,
      steps,
      repoSize,
      prNumber
    });

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
