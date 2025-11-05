const { test, mock } = require('node:test');
const assert = require('node:assert');
const { collectMetrics } = require('../lib/collector');

test('collectMetrics', async (t) => {
  await t.test('should collect metrics from GitHub API', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'test-job',
          status: 'completed',
          conclusion: 'success',
          started_at: '2025-01-01T10:00:00Z',
          completed_at: '2025-01-01T10:05:00Z',
          steps: [
            {
              name: 'Checkout',
              number: 1,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:00:00Z',
              completed_at: '2025-01-01T10:01:00Z',
            },
            {
              name: 'Build',
              number: 2,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:01:00Z',
              completed_at: '2025-01-01T10:04:00Z',
            },
          ],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'test-job';
    process.env.GITHUB_RUN_ATTEMPT = '1';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    assert.strictEqual(metrics.workflow, 'CI');
    assert.strictEqual(metrics.job.name, 'test-job');
    assert.strictEqual(metrics.job.id, 12345);
    assert.strictEqual(metrics.job.conclusion, 'success');
    assert.strictEqual(metrics.job.durationMs, 300000); // 5 minutes

    assert.strictEqual(metrics.steps.length, 2);
    assert.strictEqual(metrics.steps[0].name, 'Checkout');
    assert.strictEqual(metrics.steps[0].durationMs, 60000); // 1 minute
    assert.strictEqual(metrics.steps[1].name, 'Build');
    assert.strictEqual(metrics.steps[1].durationMs, 180000); // 3 minutes

    assert.strictEqual(metrics.repository.owner, 'test-owner');
    assert.strictEqual(metrics.repository.repo, 'test-repo');
    assert.strictEqual(metrics.run.id, 67890);
  });

  await t.test('should handle missing current job', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'other-job',
          status: 'completed',
          conclusion: 'success',
          started_at: '2025-01-01T10:00:00Z',
          completed_at: '2025-01-01T10:05:00Z',
          steps: [],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'non-existent-job';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    // Should fallback to first job
    assert.strictEqual(metrics.job.name, 'other-job');
  });

  await t.test('should handle empty steps', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'test-job',
          status: 'completed',
          conclusion: 'success',
          started_at: '2025-01-01T10:00:00Z',
          completed_at: '2025-01-01T10:05:00Z',
          steps: [],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'test-job';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    assert.strictEqual(metrics.steps.length, 0);
    assert.ok(metrics.job.durationMs > 0);
  });

  await t.test('should handle API errors', async () => {
    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => {
            throw new Error('API Error');
          }),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    await assert.rejects(
      async () => await collectMetrics(mockOctokit, mockContext),
      /API Error/
    );
  });

  await t.test('should infer job conclusion as failure from failed steps', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'test-job',
          status: 'in_progress',
          conclusion: null,
          started_at: '2025-01-01T10:00:00Z',
          completed_at: null,
          steps: [
            {
              name: 'Step 1',
              number: 1,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:00:00Z',
              completed_at: '2025-01-01T10:01:00Z',
            },
            {
              name: 'Step 2',
              number: 2,
              status: 'completed',
              conclusion: 'failure',
              started_at: '2025-01-01T10:01:00Z',
              completed_at: '2025-01-01T10:02:00Z',
            },
          ],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'test-job';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    assert.strictEqual(metrics.job.conclusion, 'failure');
    assert.strictEqual(metrics.job.status, 'in_progress');
  });

  await t.test('should infer job conclusion as success from successful steps', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'test-job',
          status: 'in_progress',
          conclusion: null,
          started_at: '2025-01-01T10:00:00Z',
          completed_at: null,
          steps: [
            {
              name: 'Step 1',
              number: 1,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:00:00Z',
              completed_at: '2025-01-01T10:01:00Z',
            },
            {
              name: 'Step 2',
              number: 2,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:01:00Z',
              completed_at: '2025-01-01T10:02:00Z',
            },
          ],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'test-job';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    assert.strictEqual(metrics.job.conclusion, 'success');
  });

  await t.test('should infer job conclusion as cancelled from cancelled steps', async () => {
    const mockJobData = {
      jobs: [
        {
          id: 12345,
          name: 'test-job',
          status: 'in_progress',
          conclusion: null,
          started_at: '2025-01-01T10:00:00Z',
          completed_at: null,
          steps: [
            {
              name: 'Step 1',
              number: 1,
              status: 'completed',
              conclusion: 'success',
              started_at: '2025-01-01T10:00:00Z',
              completed_at: '2025-01-01T10:01:00Z',
            },
            {
              name: 'Step 2',
              number: 2,
              status: 'completed',
              conclusion: 'cancelled',
              started_at: '2025-01-01T10:01:00Z',
              completed_at: '2025-01-01T10:02:00Z',
            },
          ],
        },
      ],
    };

    const mockOctokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: mock.fn(async () => ({ data: mockJobData })),
        },
      },
    };

    const mockContext = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      runId: 67890,
      runNumber: 42,
      workflow: 'CI',
    };

    process.env.GITHUB_JOB = 'test-job';

    const metrics = await collectMetrics(mockOctokit, mockContext);

    assert.strictEqual(metrics.job.conclusion, 'cancelled');
  });
});
