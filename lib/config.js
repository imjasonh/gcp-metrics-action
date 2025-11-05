const core = require('@actions/core');
const fs = require('fs');
const path = require('path');

/**
 * Parses and validates action configuration from inputs
 * @returns {Object} Configuration object
 */
function getConfig() {
  const serviceAccountKeyFile = core.getInput('gcp-service-account-key-file');
  let serviceAccountKey = null;

  // Read service account key from file if provided
  if (serviceAccountKeyFile) {
    try {
      const filePath = path.resolve(serviceAccountKeyFile);
      core.info(`Reading service account key from: ${filePath}`);
      serviceAccountKey = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      core.error(`Failed to read service account key file: ${error.message}`);
      throw new Error(`Cannot read service account key file: ${serviceAccountKeyFile}`);
    }
  }

  const config = {
    gcpProjectId: core.getInput('gcp-project-id', { required: true }),
    gcpServiceAccountKey: serviceAccountKey,
    serviceName: core.getInput('service-name') || 'github-actions',
    serviceNamespace: core.getInput('service-namespace') || 'ci',
    metricPrefix: core.getInput('metric-prefix') || 'github.actions',
  };

  // Validate configuration
  if (!config.gcpProjectId) {
    throw new Error('gcp-project-id is required');
  }

  // Log config without sensitive data
  const safeConfig = { ...config, gcpServiceAccountKey: config.gcpServiceAccountKey ? '[REDACTED]' : null };
  core.debug(`Configuration: ${JSON.stringify(safeConfig, null, 2)}`);

  return config;
}

module.exports = { getConfig };
