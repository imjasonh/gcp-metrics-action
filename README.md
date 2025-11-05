# OpenTelemetry Metrics Exporter for GitHub Actions

A GitHub Action that collects workflow step metrics (duration, status) and exports them to Google Cloud Monitoring via OpenTelemetry.

## Features

- 📊 Collects job and step-level metrics from GitHub Actions workflows
- ⏱️ Records duration histograms for performance tracking
- ✅ Tracks success/failure rates with counters
- 🏷️ Rich metric labels (workflow, job, repository, run info)
- 🔒 Minimal permissions (Monitoring Metric Writer only)
- 🔄 Always runs (even when steps fail)

## Setup

### 1. Create a Google Cloud Service Account

Create a service account with only the permission to write metrics:

```bash
# Set your GCP project ID
PROJECT_ID="your-project-id"

# Create the service account
gcloud iam service-accounts create github-actions-metrics \
  --display-name="GitHub Actions OpenTelemetry Metrics" \
  --description="Service account for GitHub Actions to write OpenTelemetry metrics to Cloud Monitoring" \
  --project="${PROJECT_ID}"

# Grant the Monitoring Metric Writer role
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:github-actions-metrics@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/monitoring.metricWriter" \
  --condition=None

# Create and download a JSON key
gcloud iam service-accounts keys create github-actions-metrics-key.json \
  --iam-account="github-actions-metrics@${PROJECT_ID}.iam.gserviceaccount.com"
```

### 2. Add Service Account Key to GitHub

You have two options:

**Option A: Use GitHub Secrets (Recommended for production)**

1. Copy the contents of the JSON key file:
   ```bash
   cat github-actions-metrics-key.json
   ```

2. In your GitHub repository, go to **Settings → Secrets and variables → Actions**

3. Click **New repository secret**

4. Name: `GCP_SERVICE_ACCOUNT_KEY`

5. Value: Paste the entire JSON content

6. Click **Add secret**

7. Also add your GCP project ID as a secret:
   - Name: `GCP_PROJECT_ID`
   - Value: Your project ID (e.g., `jason-chainguard`)

8. **Securely delete the key file:**
   ```bash
   rm github-actions-metrics-key.json
   ```

**Option B: Commit the key file (For private repos only)**

You can commit the key file directly:

```bash
# Set restrictive permissions (recommended)
chmod 600 github-actions-metrics-key.json

git add github-actions-metrics-key.json
git commit -m "Add service account key for metrics"
git push
```

**⚠️ Security Requirements:**
- **MUST** be a private repository (action will refuse to run in public repos)
- **Recommended:** File permissions should be `600` (owner read/write only)
- **Warning:** For production, use GitHub Secrets or Workload Identity Federation instead

The action includes built-in security checks:
- ✓ Refuses to run if repository is public
- ✓ Warns if key file has overly permissive file permissions
- ✓ Verifies service account has ONLY `roles/monitoring.metricWriter`
- ✓ Errors if service account has excessive permissions
- ✓ Logs repository visibility status

This is mainly intended to be used in `pull_request` workflows where secrets and workload identity federation are not available.

**Service Account Permission Validation:**

The action automatically calls the GCP IAM API to verify that the service account has only the minimal required permissions (`roles/monitoring.metricWriter`). If any additional roles are detected, the action will refuse to run and provide commands to remove the excessive permissions.

This ensures the principle of least privilege is followed, even if the key file is accidentally exposed.

*Note:* The service account needs permission to view IAM policies to perform this check. The `roles/monitoring.metricWriter` role includes the necessary `resourcemanager.projects.getIamPolicy` permission. If the check fails due to insufficient permissions, the action will log a warning and proceed without the check.

## Usage

### Authentication Methods

This action supports two authentication methods:

| Method | Best For | Works With | Setup Complexity |
|--------|----------|------------|------------------|
| **Service Account Key File** | Testing, forks, `pull_request` events | All workflow events | Simple - just create and store a key |
| **Workload Identity Federation** | Production, security-conscious | `push`, `pull_request_target` only | Moderate - requires WIF setup |

**Quick Decision:**
- Using `pull_request` from forks? → **Use Service Account Key File**
- Production workflows on `push`? → **Use Workload Identity Federation**

### Basic Usage (with Service Account Key File)

Add the action as one of the first steps in your workflow. The action will automatically collect metrics in a post-action phase after all other steps complete.

```yaml
name: CI Pipeline

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      # Checkout first
      - uses: actions/checkout@v4

      # Write secret to file
      - name: Setup GCP credentials
        run: echo '${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}' > /tmp/gcp-key.json

      # Enable metrics collection
      - name: Setup OpenTelemetry Metrics
        uses: your-org/otel-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          gcp-service-account-key-file: /tmp/gcp-key.json
          # gcp-project-id is automatically extracted from the service account key
          # You can override it explicitly if needed: gcp-project-id: ${{ secrets.GCP_PROJECT_ID }}

      # Your regular workflow steps
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
      - name: Build
        run: npm run build

      # Metrics are automatically collected and exported after this job completes
```

### Alternative: Using Committed Key File

If you have the key file committed (for testing):

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: your-org/otel-action@v1
    with:
      github-token: ${{ github.token }}
      gcp-service-account-key-file: github-actions-metrics-key.json
      # gcp-project-id is automatically extracted from the key file

  # Your workflow steps...
```

### Advanced Configuration

```yaml
- name: Setup OpenTelemetry Metrics
  uses: your-org/otel-action@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    gcp-service-account-key-file: /tmp/gcp-key.json

    # Optional: Override project ID (defaults to project from service account key)
    # gcp-project-id: ${{ secrets.GCP_PROJECT_ID }}

    # Optional: Customize service name for resource attributes
    service-name: 'my-app-ci'

    # Optional: Customize service namespace
    service-namespace: 'production'

    # Optional: Customize metric name prefix
    metric-prefix: 'ci.metrics'
```

## Metrics Collected

### Job Duration
- **Metric:** `github.actions.job.duration`
- **Type:** Histogram
- **Unit:** milliseconds
- **Labels:**
  - `workflow.name` - Name of the workflow
  - `job.name` - Name of the job
  - `job.status` - Status (completed, in_progress, etc.)
  - `job.conclusion` - Conclusion (success, failure, cancelled, etc.)
  - `repository.owner` - Repository owner
  - `repository.name` - Repository name
  - `repository.full_name` - Full repository name (owner/repo)
  - `run.id` - Workflow run ID
  - `run.number` - Workflow run number
  - `run.attempt` - Run attempt number

### Step Duration
- **Metric:** `github.actions.step.duration`
- **Type:** Histogram
- **Unit:** milliseconds
- **Labels:** All job labels plus:
  - `step.name` - Name of the step
  - `step.number` - Step number
  - `step.status` - Status (completed, in_progress, etc.)
  - `step.conclusion` - Conclusion (success, failure, skipped, etc.)

### Step Count
- **Metric:** `github.actions.step.total`
- **Type:** Counter
- **Labels:** Same as step duration

## Viewing Metrics

Metrics will appear in Google Cloud Monitoring under custom metrics:

1. Go to **Cloud Console → Monitoring → Metrics Explorer**
2. Search for: `custom.googleapis.com/github.actions`
3. Available metrics:
   - `custom.googleapis.com/github.actions/job.duration`
   - `custom.googleapis.com/github.actions/step.duration`
   - `custom.googleapis.com/github.actions/step.total`

### Example Queries

**Average step duration by step name:**
```
custom.googleapis.com/github.actions/step.duration
| filter resource.project_id = "your-project-id"
| group_by [metric.step.name]
| mean
```

**Job failure rate:**
```
custom.googleapis.com/github.actions/step.total
| filter metric.step.conclusion = "failure"
| rate(1m)
```

## Alternative: Using Workload Identity Federation (Recommended)

Instead of service account keys, you can use Workload Identity Federation (WIF). This is the **recommended** approach for production as it doesn't require managing service account key files.

### Important: Workflow Event Limitations

⚠️ **WIF requires `id-token: write` permission, which is only available for:**
- `push` events
- `pull_request_target` events (runs in the context of the target repo)

❌ **WIF will NOT work with:**
- `pull_request` events (runs in the context of the fork, cannot get OIDC tokens)

For pull requests from forks, you must use service account keys instead.

### WIF Configuration

```yaml
name: CI with WIF

on:
  push:
    branches: [ main ]
  pull_request_target:  # Use pull_request_target, not pull_request
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest

    permissions:
      contents: read
      id-token: write  # Required for WIF
      actions: read    # Required to read workflow/job info

    steps:
      - uses: actions/checkout@v4

      # Authenticate with GCP first
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      # Setup metrics collection (no key file needed)
      - uses: your-org/otel-action@v1
        with:
          github-token: ${{ github.token }}
          gcp-project-id: ${{ secrets.GCP_PROJECT_ID }}
          # gcp-service-account-key-file is omitted - uses ADC from WIF

      # Your workflow steps...
      - run: npm install
      - run: npm test
```

### Setting Up Workload Identity Federation

1. Create a Workload Identity Pool and Provider in GCP
2. Grant the service account permissions to the pool
3. Add secrets to GitHub:
   - `WIF_PROVIDER`: Full resource name of the workload identity provider
   - `WIF_SERVICE_ACCOUNT`: Email of the service account
   - `GCP_PROJECT_ID`: Your GCP project ID

See [Google's documentation](https://github.com/google-github-actions/auth#workload-identity-federation) for detailed setup instructions.

## Development

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Build

The action uses [@vercel/ncc](https://github.com/vercel/ncc) to compile the JavaScript and dependencies into a single file for distribution.

```bash
npm run build
```

This creates:
- `dist/index.js` - Main entry point
- `dist/post/index.js` - Post-action with all dependencies

**Important:** The `dist/` directory must be committed for the action to work in GitHub Actions.

### Pre-commit Hooks

This project uses [pre-commit](https://pre-commit.com/) to automatically run tests and build before each commit.

**Setup:**

```bash
# Install pre-commit (if not already installed)
brew install pre-commit  # macOS
# or: pip install pre-commit  # other platforms

# Install the git hook scripts
pre-commit install
```

Now `npm test` and `npm run build` will run automatically before each commit. If either fails, the commit will be aborted.

**Manual execution:**

```bash
# Run hooks on all files
pre-commit run --all-files
```

### Project Structure

```
otel-action/
├── action.yml           # Action definition
├── index.js             # Main entry point (source)
├── post.js              # Post-action (source)
├── dist/                # Compiled action (committed)
│   ├── index.js         # Built main entry
│   └── post/
│       └── index.js     # Built post-action
├── lib/
│   ├── config.js        # Configuration parsing
│   ├── collector.js     # GitHub API metrics collection
│   └── exporter.js      # OpenTelemetry export
└── test/
    ├── collector.test.js
    └── exporter.test.js
```

## License

Apache-2.0

## Contributing

Issues and pull requests welcome!
