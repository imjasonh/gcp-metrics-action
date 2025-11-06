# GCP Metrics Exporter for GitHub Actions

A GitHub Action that collects workflow step metrics and traces, and exports them to Google Cloud Monitoring and Cloud Trace.

## Features

- 📊 **Metrics**: Duration histograms and success/failure counters for jobs and steps
- 🔍 **Traces**: Distributed traces showing job and step execution timeline with parent-child relationships
- 🏷️ Rich attributes and labels (workflow, job, repository, run info, step attribution)
- 🔒 Minimal permissions (only metric writer and trace agent)
- 🔄 Always runs (even when steps fail)

## Setup

### 1. Create a Google Cloud Service Account

Create a service account with minimal permissions to write metrics and traces:

```bash
# Set your GCP project ID
PROJECT_ID="your-project-id"

# Create the service account
gcloud iam service-accounts create github-actions-otel \
  --display-name="GitHub Actions OpenTelemetry" \
  --description="Service account for GitHub Actions to export metrics and traces" \
  --project="${PROJECT_ID}"

# Grant required roles
SA_EMAIL="github-actions-otel@${PROJECT_ID}.iam.gserviceaccount.com"

# For metrics
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/monitoring.metricWriter" \
  --condition=None

# For traces
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudtrace.agent" \
  --condition=None

# Create and download a JSON key
gcloud iam service-accounts keys create github-actions-metrics-key.json \
  --iam-account="${SA_EMAIL}"
```

**Roles explained:**
- `roles/monitoring.metricWriter` - Write custom metrics to Cloud Monitoring
- `roles/cloudtrace.agent` - Write traces to Cloud Trace

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

8. **Securely delete the key file:**
   ```bash
   rm github-actions-metrics-key.json
   ```

**Option B: Commit the key file (For private repos only)**

You can commit the key file directly:

```bash
git add github-actions-metrics-key.json
git commit -m "Add service account key for metrics"
git push
```

**⚠️ Security Requirements:**
- **MUST** be a private repository (action will refuse to run this way in public repos)
- **Warning:** For production, use GitHub Secrets or Workload Identity Federation instead

The action includes built-in security checks:
- ✓ Refuses to run if repository is public (checked via GitHub API)
- ✓ **Best-effort:** Verifies service account has ONLY `roles/monitoring.metricWriter`
- ✓ Errors if excessive permissions are detected

This is mainly intended to be used in `pull_request` workflows where secrets and workload identity federation are not available.

**Service Account Permission Validation:**

The action attempts to call the GCP IAM API to verify that the service account has only minimal required permissions (`roles/monitoring.metricWriter`).

**Important:** This check requires the service account to have `resourcemanager.projects.getIamPolicy` permission, which is **not** included in `roles/monitoring.metricWriter`. Therefore:

- ✅ **If successful:** Will error and refuse to run if excessive permissions are detected
- ⚠️ **If unsuccessful:** Will log an info message and proceed (this is expected with minimal permissions)

**To enable the permission check** (optional, adds minimal permissions):

```bash
# Create a custom role with only the getIamPolicy permission
gcloud iam roles create githubActionsMetricsChecker \
  --project=jason-chainguard \
  --title="GitHub Actions Metrics Permission Checker" \
  --permissions=resourcemanager.projects.getIamPolicy

# Grant it to the service account
gcloud projects add-iam-policy-binding jason-chainguard \
  --member="serviceAccount:github-actions-metrics@jason-chainguard.iam.gserviceaccount.com" \
  --role="projects/jason-chainguard/roles/githubActionsMetricsChecker" \
  --condition=None
```

With this optional permission, the action can verify it has no excessive roles and provide specific remediation commands if issues are found.

## Usage

### Authentication Methods

This action supports two authentication methods:

| Method | Best For | Works With | Setup Complexity |
|--------|----------|------------|------------------|
| **Service Account Key File** | Private repos, weaker security | `pull_request` only | Simplest - only supported for private repos |
| **Service Account Key File (Secret)** | Production, good security | `push`, `pull_request_target` only | Simple - just create and store a key |
| **Workload Identity Federation** | Production, best security | `push`, `pull_request_target` only | Moderate - requires WIF setup |

**Quick Decision:**
- Using `pull_request` from private forks? → **Use Service Account Key File**
- Production workflows on `push`? → **Use GitHub Secret or Workload Identity Federation**

### Basic Usage (with Secrets)

The simplest approach is to use GitHub Secrets directly:

```yaml
name: CI Pipeline

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: imjasonh/gcp-metrics-action@...
        with:
          github-token: ${{ github.token }}
          gcp-service-account-key: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}
          # gcp-project-id is automatically extracted from the service account key

      # Your regular workflow steps
      - run: npm install
      - run: npm test
      - run: npm run build

      # Metrics and traces are automatically collected and exported after this job completes
```

### Alternative: Using Committed Key File

If you have the key file committed to a _private repo_:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: imjasonh/gcp-metrics-action@...
    with:
      github-token: ${{ github.token }}
      gcp-service-account-key-file: github-actions-metrics-key.json
  # Your workflow steps...
```

### Advanced Configuration

```yaml
- name: Setup OpenTelemetry Metrics
  uses: imjasonh/gcp-metrics-action@...
  with:
    github-token: ${{ github.token }}
    gcp-service-account-key: ${{ secrets.GCP_SERVICE_ACCOUNT_KEY }}

    # Optional: Override project ID (defaults to project from service account key)
    # gcp-project-id: 'my-project-id'

    # Optional: Customize service name for resource attributes
    service-name: 'my-app-ci'

    # Optional: Customize service namespace
    service-namespace: 'production'

    # Optional: Customize metric name prefix
    metric-prefix: 'ci.metrics'
```

## Data Collected

### Metrics

#### Job Duration
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
  - `git.sha` - Commit SHA
  - `git.ref` - Full ref (e.g., refs/heads/main, refs/pull/123/merge)
  - `git.ref_name` - Short ref name (e.g., main, feature-branch) *
  - `git.base_ref` - Base branch for PRs (e.g., main) *
  - `git.head_ref` - Head branch for PRs (e.g., feature-branch) *
  - `event.name` - Event that triggered workflow (push, pull_request, etc.)
  - `event.actor` - User who triggered the workflow
  - `pull_request.number` - PR number (if applicable) *
  - `runner.os` - Runner operating system (Linux, Windows, macOS)
  - `runner.arch` - Runner architecture (X64, ARM64, etc.)
  - `runner.name` - Runner name *
  - `runner.label` - Primary runner label (e.g., ubuntu-latest, ubuntu-4-cores) *

\* = Optional attributes, only present when applicable

#### Job Estimated Cost
- **Metric:** `github.actions.job.estimated_cost`
- **Type:** Histogram
- **Unit:** USD
- **Labels:** Same as job duration
- **Note:** Only recorded when runner OS is known. Automatically calculates cost based on:
  - **Standard runners:** Linux: $0.008/min, Windows: $0.016/min, macOS: $0.08/min
  - **Larger runners:** Detected from runner label (e.g., ubuntu-4-cores, ubuntu-8-cores)
    - Pricing scales from $0.016/min (2-cores) to $1.024/min (64-cores Windows)
  - **Self-hosted runners:** Not recorded (cost = $0)
  - Ref: https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions

**Benefits:**
- Track cost trends for specific workflows over time
- Alert on cost increase

#### Repository Size
- **Metric:** `github.actions.repo.size`
- **Type:** Gauge
- **Unit:** KB (kilobytes)
- **Labels:** Same as job duration
- **Note:** Records the current repository size at workflow run time

**Benefits:**
- Track repository growth over time
- Correlate build performance with repository size
- Alert when repository grows too large
- Identify when to implement size optimizations

#### Step Duration
- **Metric:** `github.actions.step.duration`
- **Type:** Histogram
- **Unit:** milliseconds
- **Labels:** All job labels plus:
  - `step.name` - Name of the step
  - `step.number` - Step number
  - `step.status` - Status (completed, in_progress, etc.)
  - `step.conclusion` - Conclusion (success, failure, skipped, etc.)

#### Artifact Size
- **Metric:** `github.actions.artifact.size`
- **Type:** Histogram
- **Unit:** bytes
- **Labels:** All job labels plus:
  - `artifact.name` - Name of the artifact
- **Note:** Recorded once per artifact. Only available when artifacts are found (typically not until after workflow completes)

**Benefits:**
- Track size trends for specific artifacts over time
- Count unique artifacts by counting time series
- Monitor total storage usage across all artifacts
- Alert on artifact size growth

### Traces

The action creates distributed traces showing the execution timeline of your workflow:

- **Job Span**: Root span covering the entire job execution
  - Span name: `Job: {job-name}`
  - Includes all job attributes (workflow, repository, run info, job status/conclusion)
  - Marked as error if job fails

- **Step Spans**: Child spans for each workflow step
  - Span name: `Step: {step-name}`
  - Parent: Job span (creates hierarchical trace)
  - Includes all step attributes (name, number, status, conclusion)
  - Marked as error if step fails
  - Accurate start/end times from GitHub API

**Benefits:**
- Visualize workflow execution in Cloud Trace timeline view
- Identify slow steps at a glance
- See step dependencies and parallelization
- Correlate failures across steps
- Track execution patterns over time

## Viewing Data

### Viewing Metrics

Metrics will appear in Google Cloud Monitoring under custom metrics:

1. Go to **Cloud Console → Monitoring → Metrics Explorer**
2. Search for: `custom.googleapis.com/github.actions`
3. Available metrics:
   - `custom.googleapis.com/github.actions/job.duration`
   - `custom.googleapis.com/github.actions/job.estimated_cost`
   - `custom.googleapis.com/github.actions/repo.size`
   - `custom.googleapis.com/github.actions/step.duration`
   - `custom.googleapis.com/github.actions/artifact.size` (when artifacts available)

![Metrics in Cloud Monitoring](metrics.png)

### Example Queries

**Average step duration by step name:**
```
custom.googleapis.com/github.actions/step.duration
| filter resource.project_id = "your-project-id"
| group_by [metric.step.name]
| mean
```

**Job failure rate over time:**
```
custom.googleapis.com/github.actions/job.duration
| filter metric.job.conclusion = "failure"
| group_by [], .rate(1h)
```

**Metrics for a specific PR:**
```
custom.googleapis.com/github.actions/job.duration
| filter metric.pull_request.number = "123"
```

**Build duration by branch:**
```
custom.googleapis.com/github.actions/job.duration
| filter metric.git.ref_name != ""
| group_by [metric.git.ref_name]
| mean
```

**Metrics triggered by specific user:**
```
custom.googleapis.com/github.actions/step.duration
| filter metric.event.actor = "username"
```

**Compare push vs pull_request performance:**
```
custom.googleapis.com/github.actions/job.duration
| group_by [metric.event.name]
| mean
```

**Artifact size over time by artifact name:**
```
custom.googleapis.com/github.actions/artifact.size
| group_by [metric.artifact.name]
| mean
```

**Count of unique artifacts being uploaded:**
```
custom.googleapis.com/github.actions/artifact.size
| group_by [metric.artifact.name]
| count
```

**Total CI costs:**
```
custom.googleapis.com/github.actions/job.estimated_cost
| sum
```

**Monthly CI costs by runner type:**
```
custom.googleapis.com/github.actions/job.estimated_cost
| group_by [metric.runner.os, metric.runner.label]
| sum
```

**Most expensive workflows:**
```
custom.googleapis.com/github.actions/job.estimated_cost
| group_by [metric.workflow.name]
| sum
| top 10
```

**Most expensive jobs:**
```
custom.googleapis.com/github.actions/job.estimated_cost
| group_by [metric.job.name]
| sum
| top 10
```

### Viewing Traces

Traces will appear in Google Cloud Trace:

1. Go to **Cloud Console → Trace → Trace Explorer**
2. You'll see traces for each workflow job execution
3. Click on a trace to see the timeline:
   - Job span showing total execution time
   - Step spans showing individual step durations
   - Failed steps highlighted in red
   - Hover over spans to see attributes (workflow name, repository, etc.)

![Traces in Cloud Trace](traces.png)

**Trace URL format:**
```
https://console.cloud.google.com/traces/list?project=your-project-id
```

**Benefits of the trace view:**
- See all steps in a single timeline
- Identify bottlenecks visually
- Understand step execution order
- Correlate metrics with traces for deeper insights

## Advanced: Creating Custom Trace Spans

The action exports the root trace context so your workflow steps can create child spans:

### Using the Trace Context

The action sets the `TRACEPARENT` environment variable (W3C Trace Context format) that subsequent steps can use:

```yaml
steps:
  - uses: imjasonh/gcp-metrics-action@...
    id: gcp-metrics
    with:
      github-token: ${{ github.token }}
      gcp-service-account-key: ${{ secrets.SERVICE_ACCOUNT_KEY }}

  # TRACEPARENT is now available in environment
  # Your application can use it to create child spans

  - name: Your instrumented step
    run: |
      # The TRACEPARENT env var is automatically set
      echo "Trace context: $TRACEPARENT"
      echo "Span ID: ${{ steps.gcp-metrics.outputs.span-id }}"
      # Your app can use this to create child spans under the job span
```

### Available Outputs

- `traceparent` - W3C Trace Context header value (use this for most instrumentation)
- `trace-id` - OpenTelemetry Trace ID (32-character hex string)
- `span-id` - Root span ID for this job (16-character hex string)

### Example: Node.js App with OpenTelemetry

```yaml
- uses: ./
  with:
    github-token: ${{ github.token }}
    gcp-service-account-key-file: key.json

- name: Run instrumented app
  env:
    # TRACEPARENT already set automatically
    OTEL_EXPORTER_OTLP_ENDPOINT: https://your-collector:4318
  run: |
    # Your app reads TRACEPARENT and creates child spans
    node my-app.js
```

Your application can use standard OpenTelemetry libraries to read `TRACEPARENT` and create child spans that will appear under the job span in Cloud Trace.

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

      # Setup metrics collection
      - uses: imjasonh/gcp-metrics-action@...
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
/
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
