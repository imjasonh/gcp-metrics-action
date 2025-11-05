const core = require('@actions/core');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { MetricExporter } = require('@google-cloud/opentelemetry-cloud-monitoring-exporter');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE, ATTR_SERVICE_INSTANCE_ID } = require('@opentelemetry/semantic-conventions');

/**
 * Creates and configures an OpenTelemetry MeterProvider with GCP exporter
 * @param {Object} config - Configuration object
 * @returns {Object} MeterProvider and meters
 */
function createMeterProvider(config) {
  core.info('Initializing OpenTelemetry MeterProvider with Google Cloud Monitoring exporter');

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_NAMESPACE]: config.serviceNamespace,
    [ATTR_SERVICE_INSTANCE_ID]: process.env.GITHUB_RUN_ID || 'unknown',
  });

  // Configure exporter options
  const exporterOptions = {
    projectId: config.gcpProjectId,
  };

  // If service account key is provided, parse and use it
  if (config.gcpServiceAccountKey) {
    try {
      const credentials = JSON.parse(config.gcpServiceAccountKey);
      exporterOptions.credentials = credentials;
      core.info('Using provided service account credentials');
    } catch (error) {
      core.error(`Failed to parse service account key: ${error.message}`);
      throw new Error('Invalid service account key JSON');
    }
  } else {
    core.info('Using Application Default Credentials');
  }

  const exporter = new MetricExporter(exporterOptions);

  // Note: We use PeriodicExportingMetricReader not for periodic exports,
  // but because it handles metric aggregation and collection.
  // We trigger export manually via forceFlush() in the shutdown function.
  const metricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60000, // Set high since we export manually via forceFlush()
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader],
  });

  const meter = meterProvider.getMeter(config.metricPrefix);

  return { meterProvider, meter };
}

/**
 * Records metrics for collected workflow data
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics from GitHub
 * @param {string} metricPrefix - Metric name prefix
 */
function recordMetrics(meter, metrics, metricPrefix) {
  core.info('Recording metrics to OpenTelemetry');

  const baseAttributes = {
    'workflow.name': metrics.workflow,
    'job.name': metrics.job.name,
    'repository.owner': metrics.repository.owner,
    'repository.name': metrics.repository.repo,
    'repository.full_name': metrics.repository.fullName,
    'run.id': metrics.run.id.toString(),
    'run.number': metrics.run.number.toString(),
    'run.attempt': metrics.run.attempt,
  };

  // Create meters for step metrics
  const stepDurationName = `${metricPrefix}.step.duration`;
  const stepDurationHistogram = meter.createHistogram(stepDurationName, {
    description: 'Duration of workflow steps in milliseconds',
    unit: 'ms',
  });
  core.debug(`Created histogram metric: ${stepDurationName}`);

  const stepCounterName = `${metricPrefix}.step.total`;
  const stepCounter = meter.createCounter(stepCounterName, {
    description: 'Total count of workflow steps by conclusion',
  });
  core.debug(`Created counter metric: ${stepCounterName}`);

  // Record job-level metrics
  if (metrics.job.durationMs > 0) {
    const jobDurationHistogram = meter.createHistogram(`${metricPrefix}.job.duration`, {
      description: 'Duration of workflow jobs in milliseconds',
      unit: 'ms',
    });

    jobDurationHistogram.record(metrics.job.durationMs, {
      ...baseAttributes,
      'job.status': metrics.job.status,
      'job.conclusion': metrics.job.conclusion || 'unknown',
    });

    core.info(`Recorded job duration: ${metrics.job.durationMs}ms`);
  }

  // Record step-level metrics
  for (const step of metrics.steps) {
    const stepAttributes = {
      ...baseAttributes,
      'step.name': step.name,
      'step.number': step.number.toString(),
      'step.status': step.status,
      'step.conclusion': step.conclusion || 'unknown',
    };

    // Record step duration
    if (step.durationMs > 0) {
      stepDurationHistogram.record(step.durationMs, stepAttributes);
      core.info(`Recorded step "${step.name}" duration: ${step.durationMs}ms`);
    }

    // Record step count (for success/failure tracking)
    stepCounter.add(1, stepAttributes);
  }

  core.info(`Recorded metrics for ${metrics.steps.length} steps`);
}

/**
 * Forces metrics export and shuts down the meter provider
 * @param {Object} meterProvider - MeterProvider instance
 * @returns {Promise<void>}
 */
async function shutdown(meterProvider) {
  core.info('Exporting metrics and shutting down MeterProvider');
  try {
    // forceFlush() triggers an immediate export and waits for completion
    core.info('Triggering metric export...');
    await meterProvider.forceFlush();
    core.info('Metrics exported successfully');

    // Shutdown the provider
    core.info('Shutting down MeterProvider...');
    await meterProvider.shutdown();
    core.info('MeterProvider shut down successfully');
  } catch (error) {
    core.error(`Error during export/shutdown: ${error.message}`);
    core.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

module.exports = { createMeterProvider, recordMetrics, shutdown };
