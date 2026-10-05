# AeroTrace alert rules

The app sends OpenTelemetry metrics to the collector sidecar in each task, service or app. The collector forwards them to the cloud's own monitoring:

| Cloud | Where metrics land | Name you query |
| --- | --- | --- |
| AWS | CloudWatch, namespace `AeroTrace` (EMF via `/aerotrace/metrics`) | `aerotrace.approvals.oldest_age_seconds` |
| Azure | Application Insights `customMetrics` table | `name == "aerotrace.approvals.oldest_age_seconds"` |
| GCP | Cloud Monitoring | `custom.googleapis.com/aerotrace/aerotrace.approvals.oldest_age_seconds` |

Histograms arrive as distributions on GCP, as `_count`/`_sum`-style statistics in CloudWatch (EMF keeps min, max, sum and count per period), and as `value`/`valueCount`/`valueMin`/`valueMax` columns in App Insights.

## Metrics the app emits

| Metric | Type | Attributes | What it tells you |
| --- | --- | --- | --- |
| `aerotrace.http.server.duration` | histogram (s) | `route`, `status` | Latency and status of every API call |
| `aerotrace.jobs.duration` | histogram (s) | `kind`, `outcome` | How long audits and imports take, and how they end |
| `aerotrace.jobs.queued` | gauge | | Jobs ready to run and not yet picked up |
| `aerotrace.audits` | counter | `verdict`, `trigger` | Audits finished, by verdict and by what started them (manual, schedule, API) |
| `aerotrace.agent.step.duration` | histogram (s) | `agent` | Time each audit agent spends per step |
| `aerotrace.agent.retries` | counter | `agent` | Agent steps retried |
| `aerotrace.agent.breaker_trips` | counter | `agent` | Circuit breaker opened for an agent (usually the LLM endpoint) |
| `aerotrace.approvals.pending` | gauge | | Decisions waiting for a human |
| `aerotrace.approvals.oldest_age_seconds` | gauge | | Age of the oldest waiting decision |
| `aerotrace.passkey.failures` | counter | | Failed passkey ceremonies (sign-in or decision signing) |

## Suggested rules

Severity: **page** means someone should look now, **ticket** means during working hours.

| Rule | Condition | For | Severity | Created by Terraform |
| --- | --- | --- | --- | --- |
| API errors | 5xx share of `aerotrace.http.server.duration` count > 5% | 5 min | page | Platform equivalent on all three (ALB 5xx rate, App Insights request failure rate, Cloud Run 5xx ratio) |
| API latency | p95 of `aerotrace.http.server.duration` > 2 s, excluding upload routes | 10 min | ticket | AWS (ALB target p95) |
| Queue backlog | `aerotrace.jobs.queued` > 50 | 10 min | ticket | No. Add once you know normal nightly peaks |
| Queue stuck | `aerotrace.jobs.queued` > 0 and no `aerotrace.jobs.duration` samples | 15 min | page | No |
| Failing audits | rate of `aerotrace.jobs.duration{outcome="failed"}` > 0 | 1 h | ticket | No |
| Slow audits | p95 of `aerotrace.jobs.duration{kind="audit"}` > 2x last week's p95 | 30 min | ticket | No |
| Agent retries | `aerotrace.agent.retries` increase > 20 per agent | 15 min | ticket | No |
| Breaker open | `aerotrace.agent.breaker_trips` increase > 0 | instant | ticket (page if the LLM is required) | No |
| Approvals piling up | `aerotrace.approvals.pending` > 25 | 1 h | ticket | No |
| **Approval waiting too long** | `aerotrace.approvals.oldest_age_seconds` > 172800 (2 days) | 5 min | ticket | **Yes, all three** (GCP: set `enable_app_metric_alerts = true` after first deploy) |
| Passkey failures | `aerotrace.passkey.failures` increase > 10 | 10 min | ticket. Several from one account can mean a lost device, or someone trying | No |
| No completed audits | `aerotrace.audits` increase = 0 on a day with schedules | 24 h | ticket | No |

The Prometheus rules in `deploy/monitoring/alerts.yml` cover the same ground for Docker Compose and Kubernetes installs.

## Platform alerts Terraform also creates

- **AWS** (`deploy/terraform/aws/observability.tf`, SNS topic + email): ALB 5xx rate > 5%, ALB target p95 > 2 s, RDS CPU > 80%, RDS free storage < 10%, ECS running tasks below desired (web and worker), approval age.
- **Azure** (`deploy/terraform/azure/observability.tf`, action group + email): Container App restarts > 3 in 15 min, zero replicas, Postgres CPU > 80%, Postgres storage > 85%, request failure rate > 5% (App Insights query), approval age (App Insights query).
- **GCP** (`deploy/terraform/gcp/observability.tf`, email channel): Cloud Run web 5xx ratio > 5%, Cloud SQL CPU > 80%, Cloud SQL disk > 85%, approval age (optional, see above).

## Adding one

Keep thresholds in Terraform next to the existing ones, so a change goes through review. In CloudWatch, metrics with attributes are published both with all their attributes as dimensions and with none (the collector's default rollup); alarm on the no-dimension series unless you need a per-route or per-agent alarm.
