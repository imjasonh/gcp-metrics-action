const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

/**
 * Checks if a service account has excessive permissions
 * @param {string} projectId - GCP project ID
 * @param {string} serviceAccountEmail - Service account email
 * @param {Object} credentials - Service account credentials
 * @returns {Promise<void>}
 */
async function checkServiceAccountPermissions(projectId, serviceAccountEmail, credentials) {
  try {
    core.info('Checking service account IAM permissions...');

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();

    // Get project IAM policy
    const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`;
    const response = await client.request({ url });

    const policy = response.data;
    const bindings = policy.bindings || [];

    // Find all roles assigned to this service account
    const serviceAccountRoles = [];
    const memberString = `serviceAccount:${serviceAccountEmail}`;

    for (const binding of bindings) {
      if (binding.members && binding.members.includes(memberString)) {
        serviceAccountRoles.push(binding.role);
      }
    }

    core.info(`Service account has ${serviceAccountRoles.length} role(s): ${serviceAccountRoles.join(', ')}`);

    // Check for excessive permissions
    const allowedRoles = ['roles/monitoring.metricWriter'];
    const excessiveRoles = serviceAccountRoles.filter(role => !allowedRoles.includes(role));

    if (excessiveRoles.length > 0) {
      core.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      core.error('⚠️  SECURITY ERROR: Service account has excessive permissions!');
      core.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      core.error('');
      core.error(`Service account: ${serviceAccountEmail}`);
      core.error(`Project: ${projectId}`);
      core.error('');
      core.error('Excessive roles detected:');
      excessiveRoles.forEach(role => core.error(`  - ${role}`));
      core.error('');
      core.error('This service account should ONLY have:');
      core.error('  - roles/monitoring.metricWriter');
      core.error('');
      core.error('To fix, remove excessive roles:');
      excessiveRoles.forEach(role => {
        core.error(`  gcloud projects remove-iam-policy-binding ${projectId} \\`);
        core.error(`    --member="serviceAccount:${serviceAccountEmail}" \\`);
        core.error(`    --role="${role}"`);
      });
      core.error('');
      throw new Error('Service account has excessive permissions - refusing to use');
    }

    if (serviceAccountRoles.length === 0) {
      core.warning('Service account has no IAM roles assigned - metrics export may fail');
    } else {
      core.info('✓ Service account has appropriate minimal permissions');
    }

  } catch (error) {
    if (error.message.includes('excessive permissions')) {
      throw error; // Re-throw security errors
    }
    // Don't fail on API errors (might not have permission to check IAM)
    core.warning(`Could not verify service account permissions: ${error.message}`);
    core.warning('Proceeding without permission check - ensure service account has only roles/monitoring.metricWriter');
  }
}

/**
 * Parses and validates action configuration from inputs
 * @returns {Object} Configuration object
 */
async function getConfig() {
  const serviceAccountKeyFile = core.getInput('gcp-service-account-key-file');
  let serviceAccountKey = null;

  // Read service account key from file if provided
  if (serviceAccountKeyFile) {
    // Check if repository is private when using service account key file
    // GITHUB_REPOSITORY_VISIBILITY is available in GitHub Actions environment
    const repoVisibility = process.env.GITHUB_REPOSITORY_VISIBILITY;

    if (repoVisibility === 'public') {
      core.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      core.error('⚠️  SECURITY ERROR: Service account key in PUBLIC repository!');
      core.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      core.error('');
      core.error('Service account key files should NEVER be committed to public repositories.');
      core.error('');
      core.error('Options:');
      core.error('  1. Make this repository private');
      core.error('  2. Use GitHub Secrets instead of committing the key file');
      core.error('  3. Use Workload Identity Federation (recommended)');
      core.error('');
      throw new Error('Refusing to use service account key file in public repository');
    }

    if (repoVisibility === 'private' || repoVisibility === 'internal') {
      core.info(`✓ Repository is ${repoVisibility} - safe to use service account key file`);
    } else {
      core.warning(`Could not determine repository visibility (got: ${repoVisibility}). Proceeding with caution...`);
    }
    try {
      const filePath = path.resolve(serviceAccountKeyFile);
      core.info(`Reading service account key from: ${filePath}`);

      // Check file permissions
      const stats = fs.statSync(filePath);
      const mode = stats.mode & 0o777; // Get permission bits

      // Warn if file is world-readable (readable by others)
      if (mode & 0o004) {
        core.warning(`Service account key file has world-readable permissions (${mode.toString(8)}). Consider restricting: chmod 600 ${serviceAccountKeyFile}`);
      }

      // Warn if file is group-readable
      if (mode & 0o040) {
        core.warning(`Service account key file has group-readable permissions (${mode.toString(8)}). Consider restricting: chmod 600 ${serviceAccountKeyFile}`);
      }

      serviceAccountKey = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      core.error(`Failed to read service account key file: ${error.message}`);
      throw new Error(`Cannot read service account key file: ${serviceAccountKeyFile}`);
    }
  }

  // Determine GCP project ID and validate service account
  let gcpProjectId = core.getInput('gcp-project-id');
  let serviceAccountEmail = null;
  let keyData = null;

  // If not explicitly provided, try to extract from service account key
  if (serviceAccountKey) {
    try {
      keyData = JSON.parse(serviceAccountKey);

      // Extract project ID if not provided
      if (!gcpProjectId && keyData.project_id) {
        gcpProjectId = keyData.project_id;
        core.info(`Using project ID from service account key: ${gcpProjectId}`);
      }

      // Extract and log service account email
      if (keyData.client_email) {
        serviceAccountEmail = keyData.client_email;
        core.info(`Using service account: ${serviceAccountEmail}`);
      }

      // Validate key structure
      if (!keyData.private_key || !keyData.client_email || !keyData.project_id) {
        core.warning('Service account key appears to be incomplete or malformed');
      }

    } catch (error) {
      core.warning(`Could not parse service account key: ${error.message}`);
    }
  }

  const config = {
    gcpProjectId,
    gcpServiceAccountKey: serviceAccountKey,
    serviceName: core.getInput('service-name') || 'github-actions',
    serviceNamespace: core.getInput('service-namespace') || 'ci',
    metricPrefix: core.getInput('metric-prefix') || 'github.actions',
  };

  // Validate configuration
  if (!config.gcpProjectId) {
    throw new Error('gcp-project-id is required (provide explicitly or via service account key file)');
  }

  // Check service account permissions if using a key file
  if (keyData && serviceAccountEmail && config.gcpProjectId) {
    await checkServiceAccountPermissions(config.gcpProjectId, serviceAccountEmail, keyData);
  }

  // Log config without sensitive data
  const safeConfig = { ...config, gcpServiceAccountKey: config.gcpServiceAccountKey ? '[REDACTED]' : null };
  core.debug(`Configuration: ${JSON.stringify(safeConfig, null, 2)}`);

  return config;
}

module.exports = { getConfig };
