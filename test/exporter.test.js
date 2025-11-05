const { test, mock } = require('node:test');
const assert = require('node:assert');
const { createMeterProvider, recordMetrics } = require('../lib/exporter');

test('createMeterProvider', async (t) => {
  await t.test('should create MeterProvider with correct configuration', () => {
    const config = {
      gcpProjectId: 'test-project',
      serviceName: 'test-service',
      serviceNamespace: 'test-namespace',
      metricPrefix: 'test.prefix',
      exportIntervalMillis: 5000,
    };

    process.env.GITHUB_RUN_ID = '12345';

    const { meterProvider, meter } = createMeterProvider(config);

    assert.ok(meterProvider, 'MeterProvider should be created');
    assert.ok(meter, 'Meter should be created');
  });

  await t.test('should create MeterProvider with service account key', () => {
    const serviceAccountKey = {
      type: 'service_account',
      project_id: 'test-project',
      private_key_id: 'key-id',
      private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
      client_email: 'test@test-project.iam.gserviceaccount.com',
      client_id: '12345',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    };

    const config = {
      gcpProjectId: 'test-project',
      gcpServiceAccountKey: JSON.stringify(serviceAccountKey),
      serviceName: 'test-service',
      serviceNamespace: 'test-namespace',
      metricPrefix: 'test.prefix',
      exportIntervalMillis: 5000,
    };

    process.env.GITHUB_RUN_ID = '12345';

    const { meterProvider, meter } = createMeterProvider(config);

    assert.ok(meterProvider, 'MeterProvider should be created');
    assert.ok(meter, 'Meter should be created');
  });

  await t.test('should throw error for invalid service account key JSON', () => {
    const config = {
      gcpProjectId: 'test-project',
      gcpServiceAccountKey: 'invalid-json',
      serviceName: 'test-service',
      serviceNamespace: 'test-namespace',
      metricPrefix: 'test.prefix',
      exportIntervalMillis: 5000,
    };

    process.env.GITHUB_RUN_ID = '12345';

    assert.throws(
      () => createMeterProvider(config),
      /Invalid service account key JSON/
    );
  });
});

test('recordMetrics', async (t) => {
  await t.test('should record step and job metrics', () => {
    const mockHistogramRecord = mock.fn();
    const mockCounterAdd = mock.fn();

    const mockMeter = {
      createHistogram: mock.fn((name) => {
        return { record: mockHistogramRecord };
      }),
      createCounter: mock.fn((name) => {
        return { add: mockCounterAdd };
      }),
    };

    const metrics = {
      workflow: 'CI',
      job: {
        name: 'test-job',
        id: 12345,
        status: 'completed',
        conclusion: 'success',
        durationMs: 300000,
      },
      steps: [
        {
          name: 'Checkout',
          number: 1,
          status: 'completed',
          conclusion: 'success',
          durationMs: 60000,
        },
        {
          name: 'Build',
          number: 2,
          status: 'completed',
          conclusion: 'success',
          durationMs: 180000,
        },
      ],
      repository: {
        owner: 'test-owner',
        repo: 'test-repo',
        fullName: 'test-owner/test-repo',
      },
      run: {
        id: 67890,
        number: 42,
        attempt: '1',
      },
      git: {
        sha: 'abc123',
        ref: 'refs/heads/main',
        refName: 'main',
        baseRef: null,
        headRef: null,
      },
      event: {
        name: 'push',
        actor: 'test-user',
        prNumber: null,
      },
    };

    recordMetrics(mockMeter, metrics, 'test.prefix');

    // Verify histogram creation for job and step duration
    assert.strictEqual(mockMeter.createHistogram.mock.calls.length >= 2, true);

    // Verify histogram records were called (1 job + 2 steps = 3)
    assert.strictEqual(mockHistogramRecord.mock.calls.length, 3);
  });

  await t.test('should handle steps with zero duration', () => {
    const mockHistogramRecord = mock.fn();

    const mockMeter = {
      createHistogram: mock.fn(() => ({ record: mockHistogramRecord })),
    };

    const metrics = {
      workflow: 'CI',
      job: {
        name: 'test-job',
        id: 12345,
        status: 'in_progress',
        conclusion: null,
        durationMs: 0,
      },
      steps: [
        {
          name: 'Pending',
          number: 1,
          status: 'queued',
          conclusion: null,
          durationMs: 0,
        },
      ],
      repository: {
        owner: 'test-owner',
        repo: 'test-repo',
        fullName: 'test-owner/test-repo',
      },
      run: {
        id: 67890,
        number: 42,
        attempt: '1',
      },
      git: {
        sha: 'abc123',
        ref: 'refs/heads/main',
        refName: 'main',
        baseRef: null,
        headRef: null,
      },
      event: {
        name: 'push',
        actor: 'test-user',
        prNumber: null,
      },
    };

    recordMetrics(mockMeter, metrics, 'test.prefix');

    // Job duration is always recorded, even if 0
    // Step has 0 duration, so it should not be recorded
    // Total histogram calls: 1 (just the job)
    assert.strictEqual(mockHistogramRecord.mock.calls.length, 1);
  });

  await t.test('should include correct attributes in metrics', () => {
    const mockHistogramRecord = mock.fn();

    const mockMeter = {
      createHistogram: mock.fn(() => ({ record: mockHistogramRecord })),
    };

    const metrics = {
      workflow: 'CI',
      job: {
        name: 'test-job',
        id: 12345,
        status: 'completed',
        conclusion: 'success',
        durationMs: 300000,
      },
      steps: [
        {
          name: 'Checkout',
          number: 1,
          status: 'completed',
          conclusion: 'success',
          durationMs: 60000,
        },
      ],
      repository: {
        owner: 'test-owner',
        repo: 'test-repo',
        fullName: 'test-owner/test-repo',
      },
      run: {
        id: 67890,
        number: 42,
        attempt: '1',
      },
      git: {
        sha: 'abc123',
        ref: 'refs/heads/main',
        refName: 'main',
        baseRef: null,
        headRef: null,
      },
      event: {
        name: 'push',
        actor: 'test-user',
        prNumber: null,
      },
    };

    recordMetrics(mockMeter, metrics, 'test.prefix');

    // Check that histogram was called with attributes
    const histogramCall = mockHistogramRecord.mock.calls[0];
    assert.ok(histogramCall, 'Histogram should be called');
    assert.strictEqual(histogramCall.arguments[0], 300000); // Duration
    assert.ok(histogramCall.arguments[1], 'Attributes should be provided');
    assert.strictEqual(histogramCall.arguments[1]['workflow.name'], 'CI');
    assert.strictEqual(histogramCall.arguments[1]['job.name'], 'test-job');
    assert.strictEqual(histogramCall.arguments[1]['repository.owner'], 'test-owner');
  });
});
