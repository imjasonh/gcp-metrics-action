const core = require('@actions/core');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { MetricExporter } = require('@google-cloud/opentelemetry-cloud-monitoring-exporter');
const { TraceExporter } = require('@google-cloud/opentelemetry-cloud-trace-exporter');
const { BasicTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { context, trace } = require('@opentelemetry/api');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE, ATTR_SERVICE_INSTANCE_ID } = require('@opentelemetry/semantic-conventions');

/**
 * Estimates GitHub Actions cost based on runner type and duration
 * Pricing from: https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions
 * @param {string} runnerOS - Runner OS (Linux, Windows, macOS)
 * @param {string} runnerLabel - Runner label (e.g., ubuntu-latest, ubuntu-8-cores)
 * @param {number} durationMs - Duration in milliseconds
 * @returns {number} Estimated cost in USD
 */
function estimateJobCost(runnerOS, runnerLabel, durationMs) {
  // Standard runner pricing per minute
  const standardPricing = {
    'Linux': 0.008,
    'Windows': 0.016,
    'macOS': 0.08,
  };

  // Larger runner pricing (Linux/Windows only)
  // Format: ubuntu-4-cores, windows-8-cores, etc.
  const largerRunnerPricing = {
    '2-cores': { 'Linux': 0.016, 'Windows': 0.032 },
    '4-cores': { 'Linux': 0.032, 'Windows': 0.064 },
    '8-cores': { 'Linux': 0.064, 'Windows': 0.128 },
    '16-cores': { 'Linux': 0.128, 'Windows': 0.256 },
    '32-cores': { 'Linux': 0.256, 'Windows': 0.512 },
    '64-cores': { 'Linux': 0.512, 'Windows': 1.024 },
  };

  let pricePerMinute = standardPricing[runnerOS] || 0;

  // Check if this is a larger runner based on label
  if (runnerLabel) {
    const coresMatch = runnerLabel.match(/(\d+)-cores?/);
    if (coresMatch) {
      const coreSize = `${coresMatch[1]}-cores`;
      if (largerRunnerPricing[coreSize] && largerRunnerPricing[coreSize][runnerOS]) {
        pricePerMinute = largerRunnerPricing[coreSize][runnerOS];
      }
    }
  }

  const minutes = durationMs / 60000;
  return pricePerMinute * minutes;
}

/**
 * Creates and configures an OpenTelemetry MeterProvider with GCP exporter
 * @param {Object} config - Configuration object
 * @returns {Object} MeterProvider and meters
 */
function createMeterProvider(config) {
  core.info('Initializing OpenTelemetry MeterProvider with Google Cloud Monitoring exporter');

  const resource = resourceFromAttributes({
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
 * Builds base attributes for metrics from collected data
 * @param {Object} metrics - Collected metrics from GitHub
 * @returns {Object} Base attributes object
 */
function buildBaseAttributes(metrics) {
  const baseAttributes = {
    'workflow.name': metrics.workflow,
    'job.name': metrics.job.name,
    'repository.owner': metrics.repository.owner,
    'repository.name': metrics.repository.repo,
    'repository.full_name': metrics.repository.fullName,
    'run.id': metrics.run.id.toString(),
    'run.number': metrics.run.number.toString(),
    'run.attempt': metrics.run.attempt,
    'git.sha': metrics.git.sha,
    'git.ref': metrics.git.ref,
    'event.name': metrics.event.name,
    'event.actor': metrics.event.actor,
  };

  // Add optional git attributes
  if (metrics.git.refName) {
    baseAttributes['git.ref_name'] = metrics.git.refName;
  }
  if (metrics.git.baseRef) {
    baseAttributes['git.base_ref'] = metrics.git.baseRef;
  }
  if (metrics.git.headRef) {
    baseAttributes['git.head_ref'] = metrics.git.headRef;
  }
  if (metrics.event.prNumber) {
    baseAttributes['pull_request.number'] = metrics.event.prNumber.toString();
  }

  // Add runner information
  if (metrics.runner) {
    baseAttributes['runner.os'] = metrics.runner.os;
    baseAttributes['runner.arch'] = metrics.runner.arch;
    if (metrics.runner.name) {
      baseAttributes['runner.name'] = metrics.runner.name;
    }
    if (metrics.runner.labels && metrics.runner.labels.length > 0) {
      baseAttributes['runner.label'] = metrics.runner.labels[0];
    }
  }

  return baseAttributes;
}

/**
 * Records job-level metrics
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics
 * @param {string} metricPrefix - Metric name prefix
 * @param {Object} baseAttributes - Base attributes for all metrics
 */
function recordJobMetrics(meter, metrics, metricPrefix, baseAttributes) {
  const jobDurationHistogram = meter.createHistogram(`${metricPrefix}.job.duration`, {
    description: 'Duration of workflow jobs in milliseconds',
    unit: 'ms',
  });

  const jobAttributes = {
    ...baseAttributes,
    'job.status': metrics.job.status,
    'job.conclusion': metrics.job.conclusion || 'unknown',
  };

  jobDurationHistogram.record(metrics.job.durationMs, jobAttributes);
  core.info(`Recorded job duration: ${metrics.job.durationMs}ms`);

  // Record estimated cost if we have runner info
  if (metrics.runner && metrics.runner.os) {
    const runnerLabel = metrics.runner.labels && metrics.runner.labels.length > 0 ? metrics.runner.labels[0] : null;
    core.debug(`Calculating cost for runner: OS=${metrics.runner.os}, label=${runnerLabel}, duration=${metrics.job.durationMs}ms`);

    const estimatedCost = estimateJobCost(metrics.runner.os, runnerLabel, metrics.job.durationMs);
    core.debug(`Calculated estimated cost: $${estimatedCost}`);

    const costMetricName = `${metricPrefix}.job.estimated_cost`;
    const costHistogram = meter.createHistogram(costMetricName, {
      description: 'Estimated cost of workflow job in USD',
      unit: 'USD',
    });
    core.debug(`Created cost histogram metric: ${costMetricName}`);

    costHistogram.record(estimatedCost, jobAttributes);
    core.debug(`Recorded cost metric value: ${estimatedCost}`);

    const runnerDesc = runnerLabel || metrics.runner.os;
    core.info(`Recorded estimated cost for ${runnerDesc} runner: $${estimatedCost.toFixed(6)} (${(metrics.job.durationMs / 60000).toFixed(2)} minutes)`);
  } else {
    core.debug(`Not recording cost metric: runner.os=${metrics.runner?.os}, runner exists=${!!metrics.runner}`);
  }
}

/**
 * Records repository size metric
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics
 * @param {string} metricPrefix - Metric name prefix
 * @param {Object} baseAttributes - Base attributes for all metrics
 */
function recordRepositorySizeMetric(meter, metrics, metricPrefix, baseAttributes) {
  if (metrics.repository.sizeKB) {
    const repoSizeGauge = meter.createGauge(`${metricPrefix}.repo.size`, {
      description: 'Repository size in kilobytes',
      unit: 'KB',
    });

    repoSizeGauge.record(metrics.repository.sizeKB, baseAttributes);
    core.info(`Recorded repository size: ${metrics.repository.sizeKB} KB`);
  }
}

/**
 * Records artifact metrics
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics
 * @param {string} metricPrefix - Metric name prefix
 * @param {Object} baseAttributes - Base attributes for all metrics
 */
function recordArtifactMetrics(meter, metrics, metricPrefix, baseAttributes) {
  if (metrics.artifacts && metrics.artifacts.count > 0) {
    const artifactSizeHistogram = meter.createHistogram(`${metricPrefix}.artifact.size`, {
      description: 'Size of individual workflow artifacts in bytes',
      unit: 'bytes',
    });

    for (const artifact of metrics.artifacts.artifacts) {
      const artifactAttributes = {
        ...baseAttributes,
        'artifact.name': artifact.name,
      };

      artifactSizeHistogram.record(artifact.sizeBytes, artifactAttributes);
      core.info(`Recorded artifact "${artifact.name}": ${artifact.sizeBytes} bytes`);
    }

    core.info(`Recorded ${metrics.artifacts.count} artifact metrics (total: ${metrics.artifacts.totalBytes} bytes)`);
  }
}

/**
 * Records step-level metrics
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics
 * @param {string} metricPrefix - Metric name prefix
 * @param {Object} baseAttributes - Base attributes for all metrics
 */
function recordStepMetrics(meter, metrics, metricPrefix, baseAttributes) {
  const stepDurationName = `${metricPrefix}.step.duration`;
  const stepDurationHistogram = meter.createHistogram(stepDurationName, {
    description: 'Duration of workflow steps in milliseconds',
    unit: 'ms',
  });
  core.debug(`Created histogram metric: ${stepDurationName}`);

  for (const step of metrics.steps) {
    const stepAttributes = {
      ...baseAttributes,
      'step.name': step.name,
      'step.number': step.number.toString(),
      'step.status': step.status,
      'step.conclusion': step.conclusion || 'unknown',
    };

    if (step.durationMs > 0) {
      stepDurationHistogram.record(step.durationMs, stepAttributes);
      core.info(`Recorded step "${step.name}" duration: ${step.durationMs}ms`);
    }
  }

  core.info(`Recorded metrics for ${metrics.steps.length} steps`);
}

/**
 * Records metrics for collected workflow data
 * @param {Object} meter - OpenTelemetry meter
 * @param {Object} metrics - Collected metrics from GitHub
 * @param {string} metricPrefix - Metric name prefix
 */
function recordMetrics(meter, metrics, metricPrefix) {
  core.info('Recording metrics to OpenTelemetry');

  const baseAttributes = buildBaseAttributes(metrics);

  recordJobMetrics(meter, metrics, metricPrefix, baseAttributes);
  recordRepositorySizeMetric(meter, metrics, metricPrefix, baseAttributes);
  recordArtifactMetrics(meter, metrics, metricPrefix, baseAttributes);
  recordStepMetrics(meter, metrics, metricPrefix, baseAttributes);
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

/**
 * Creates and configures an OpenTelemetry TracerProvider with GCP exporter
 * @param {Object} config - Configuration object
 * @returns {Object} TracerProvider and tracer
 */
function createTracerProvider(config) {
  core.info('Initializing OpenTelemetry TracerProvider with Google Cloud Trace exporter');

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_NAMESPACE]: config.serviceNamespace,
    [ATTR_SERVICE_INSTANCE_ID]: process.env.GITHUB_RUN_ID || 'unknown',
  });

  const exporterOptions = {
    projectId: config.gcpProjectId,
  };

  if (config.gcpServiceAccountKey) {
    try {
      const credentials = JSON.parse(config.gcpServiceAccountKey);
      exporterOptions.credentials = credentials;
    } catch (error) {
      core.error(`Failed to parse service account key for traces: ${error.message}`);
      throw new Error('Invalid service account key JSON');
    }
  }

  const exporter = new TraceExporter(exporterOptions);
  const spanProcessor = new BatchSpanProcessor(exporter);

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  });

  const tracer = tracerProvider.getTracer(config.metricPrefix);

  return { tracerProvider, tracer };
}

/**
 * Builds base attributes for traces from collected data
 * @param {Object} metrics - Collected metrics from GitHub
 * @returns {Object} Base attributes object for traces
 */
function buildTraceBaseAttributes(metrics) {
  const baseAttributes = {
    'workflow.name': metrics.workflow,
    'repository.owner': metrics.repository.owner,
    'repository.name': metrics.repository.repo,
    'repository.full_name': metrics.repository.fullName,
    'run.id': metrics.run.id.toString(),
    'run.number': metrics.run.number.toString(),
    'run.attempt': metrics.run.attempt,
    'git.sha': metrics.git.sha,
    'git.ref': metrics.git.ref,
    'event.name': metrics.event.name,
    'event.actor': metrics.event.actor,
  };

  // Add optional attributes
  if (metrics.git.refName) {
    baseAttributes['git.ref_name'] = metrics.git.refName;
  }
  if (metrics.git.baseRef) {
    baseAttributes['git.base_ref'] = metrics.git.baseRef;
  }
  if (metrics.git.headRef) {
    baseAttributes['git.head_ref'] = metrics.git.headRef;
  }
  if (metrics.event.prNumber) {
    baseAttributes['pull_request.number'] = metrics.event.prNumber.toString();
  }
  if (metrics.artifacts) {
    baseAttributes['artifacts.count'] = metrics.artifacts.count.toString();
    baseAttributes['artifacts.total_bytes'] = metrics.artifacts.totalBytes.toString();
  }
  if (metrics.runner) {
    baseAttributes['runner.os'] = metrics.runner.os;
    baseAttributes['runner.arch'] = metrics.runner.arch;
    if (metrics.runner.name) {
      baseAttributes['runner.name'] = metrics.runner.name;
    }
    if (metrics.runner.labels && metrics.runner.labels.length > 0) {
      baseAttributes['runner.label'] = metrics.runner.labels[0];
    }
  }

  return baseAttributes;
}

/**
 * Creates a job span with appropriate attributes
 * @param {Object} tracer - OpenTelemetry tracer
 * @param {Object} metrics - Collected metrics
 * @param {Object} baseAttributes - Base attributes for the span
 * @returns {Object} Job span
 */
function createJobSpan(tracer, metrics, baseAttributes) {
  return tracer.startSpan(`Job: ${metrics.job.name}`, {
    startTime: metrics.job.startedAt,
    attributes: {
      ...baseAttributes,
      'job.name': metrics.job.name,
      'job.id': metrics.job.id.toString(),
      'job.status': metrics.job.status,
      'job.conclusion': metrics.job.conclusion || 'unknown',
    },
  });
}

/**
 * Creates step spans as children of the job span
 * @param {Object} tracer - OpenTelemetry tracer
 * @param {Object} metrics - Collected metrics
 * @param {Object} baseAttributes - Base attributes for spans
 * @param {Object} jobContext - Job context for creating child spans
 */
function createStepSpans(tracer, metrics, baseAttributes, jobContext) {
  for (const step of metrics.steps) {
    if (step.startedAt && step.completedAt) {
      const stepSpan = tracer.startSpan(
        `Step: ${step.name}`,
        {
          startTime: step.startedAt,
          attributes: {
            ...baseAttributes,
            'job.name': metrics.job.name,
            'step.name': step.name,
            'step.number': step.number.toString(),
            'step.status': step.status,
            'step.conclusion': step.conclusion || 'unknown',
          },
        },
        jobContext
      );

      // Mark span as error if step failed
      if (step.conclusion === 'failure') {
        stepSpan.setStatus({ code: 2, message: 'Step failed' }); // SpanStatusCode.ERROR = 2
        stepSpan.recordException(new Error(`Step "${step.name}" failed`));
      }

      stepSpan.end(step.completedAt);
      core.debug(`Created span for step: ${step.name}`);
    }
  }
}

/**
 * Records traces for collected workflow data
 * @param {Object} tracer - OpenTelemetry tracer
 * @param {Object} metrics - Collected metrics from GitHub
 * @returns {Object} Root span for the job
 */
function recordTraces(tracer, metrics) {
  core.info('Recording traces to OpenTelemetry');

  const baseAttributes = buildTraceBaseAttributes(metrics);
  const jobSpan = createJobSpan(tracer, metrics, baseAttributes);

  // Set job span as active in context for creating child spans
  const jobContext = trace.setSpan(context.active(), jobSpan);

  // Create child spans for each step
  createStepSpans(tracer, metrics, baseAttributes, jobContext);

  // End the job span
  if (metrics.job.completedAt) {
    if (metrics.job.conclusion === 'failure') {
      jobSpan.setStatus({ code: 2, message: 'Job failed' });
    }
    jobSpan.end(metrics.job.completedAt);
  }

  core.info(`Recorded traces for job and ${metrics.steps.length} steps`);
  return jobSpan;
}

/**
 * Shuts down tracer provider
 * @param {Object} tracerProvider - TracerProvider instance
 * @returns {Promise<void>}
 */
async function shutdownTracer(tracerProvider) {
  core.info('Exporting traces and shutting down TracerProvider');
  try {
    core.info('Triggering trace export...');
    await tracerProvider.forceFlush();
    core.info('Traces exported successfully');

    core.info('Shutting down TracerProvider...');
    await tracerProvider.shutdown();
    core.info('TracerProvider shut down successfully');
  } catch (error) {
    core.error(`Error during trace export/shutdown: ${error.message}`);
    core.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

module.exports = {
  createMeterProvider,
  recordMetrics,
  shutdown,
  createTracerProvider,
  recordTraces,
  shutdownTracer,
};
