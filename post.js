const core = require('@actions/core');
const github = require('@actions/github');
const { getConfig } = require('./lib/config');
const { collectMetrics } = require('./lib/collector');
const { createMeterProvider, recordMetrics, shutdown } = require('./lib/exporter');

/**
 * Post-action entry point
 * Collects workflow metrics and exports them to Google Cloud Monitoring
 */
async function run() {
  let meterProvider;

  try {
    core.info('Starting OpenTelemetry metrics collection post-action');

    // Get configuration
    const config = await getConfig();

    // Get GitHub token and create Octokit client
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    // Collect metrics from GitHub API
    const metrics = await collectMetrics(octokit, github.context);

    // Initialize OpenTelemetry and export metrics
    const { meterProvider: provider, meter } = createMeterProvider(config);
    meterProvider = provider;

    recordMetrics(meter, metrics, config.metricPrefix);

    // Force flush and shutdown to ensure metrics are exported
    await shutdown(meterProvider);

    core.info('Metrics successfully exported to Google Cloud Monitoring');
  } catch (error) {
    core.error(`Post-action failed: ${error.message}`);
    core.error(error.stack);

    // Try to shutdown gracefully even on error
    if (meterProvider) {
      try {
        await shutdown(meterProvider);
      } catch (shutdownError) {
        core.error(`Error during shutdown: ${shutdownError.message}`);
      }
    }

    // Don't fail the workflow if metrics export fails
    core.warning('Metrics export failed, but workflow will continue');
  }
}

run();
