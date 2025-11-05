const core = require('@actions/core');
const fs = require('fs');
const { getConfig } = require('./lib/config');
const { createTracerProvider } = require('./lib/exporter');
const { trace, context } = require('@opentelemetry/api');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');

/**
 * Main action entry point
 * Validates configuration and creates root trace span
 */
async function run() {
  try {
    core.info('OpenTelemetry metrics collection action initialized');

    // Validate configuration early (checks repo visibility, SA permissions, etc.)
    core.info('Validating configuration...');
    const config = await getConfig();

    core.info(`✓ Configuration validated successfully`);
    core.info(`  Project: ${config.gcpProjectId}`);
    core.info(`  Service: ${config.serviceName}`);
    core.info(`  Namespace: ${config.serviceNamespace}`);
    core.info(`  Metric prefix: ${config.metricPrefix}`);

    // Create tracer provider and start root span for the job
    core.info('');
    core.info('Creating root trace span for workflow job...');
    const { tracer } = createTracerProvider(config);

    const jobName = process.env.GITHUB_JOB || 'unknown-job';
    const rootSpan = tracer.startSpan(`Job: ${jobName}`);

    // Export trace context in W3C Trace Context format
    const propagator = new W3CTraceContextPropagator();
    const carrier = {};
    const spanContext = trace.setSpan(context.active(), rootSpan);

    propagator.inject(spanContext, carrier, {
      set: (c, key, value) => { c[key] = value; },
    });

    const traceparent = carrier.traceparent;

    if (traceparent) {
      // Export to GITHUB_ENV so all subsequent steps can access it
      const envFile = process.env.GITHUB_ENV;
      if (envFile) {
        fs.appendFileSync(envFile, `TRACEPARENT=${traceparent}\n`);
        core.info(`✓ Exported trace context to environment: TRACEPARENT=${traceparent}`);
      }

      // Also export as action output
      core.setOutput('traceparent', traceparent);
      core.setOutput('trace-id', rootSpan.spanContext().traceId);
      core.setOutput('span-id', rootSpan.spanContext().spanId);

      // Save span info to state for post-action
      core.saveState('traceparent', traceparent);
      core.saveState('trace-id', rootSpan.spanContext().traceId);
      core.saveState('span-id', rootSpan.spanContext().spanId);

      core.info('');
      core.info('Subsequent steps can use this trace context to create child spans:');
      core.info(`  TRACEPARENT=${traceparent}`);
      core.info(`  Trace ID: ${rootSpan.spanContext().traceId}`);
      core.info(`  Span ID: ${rootSpan.spanContext().spanId}`);
    }

    // Don't end the span yet - post-action will handle that
    core.info('');
    core.info('Metrics and traces will be collected and exported after the job completes');
  } catch (error) {
    core.setFailed(`Configuration validation failed: ${error.message}`);
  }
}

run();
