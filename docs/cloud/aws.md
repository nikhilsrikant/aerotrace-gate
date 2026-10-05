# AeroTrace Gate on AWS

This guide takes you from an empty AWS account to a running gate with GitHub deploying every release. Terraform is in `deploy/terraform/aws`, the workflow in `.github/workflows/deploy-aws.yml`.

## What gets built

- A VPC across two availability zones. Public subnets hold only the load balancer and NAT; tasks and the database sit in private subnets.
- An Application Load Balancer with TLS 1.3/1.2 (`ELBSecurityPolicy-TLS13-1-2-2021-06`), HTTP redirected to HTTPS, invalid headers dropped, and an optional WAF.
- ECS Fargate: a `web` service (2 tasks, scales on CPU), a `worker` service (scales 1 to 10 on CPU) and a `migrate` task definition you run before each release. Every task has an ADOT collector sidecar. Containers run as UID 10001 with a read-only root filesystem and a writable `/tmp`.
- RDS PostgreSQL 16: Multi-AZ, KMS-encrypted, 14 days of backups, Performance Insights, `rds.force_ssl=1`, deletion protection.
- S3 bucket for evidence: versioned, SSE-KMS with its own key, public access blocked, non-TLS requests denied, Glacier Instant Retrieval after 365 days.
- KMS signing key `alias/aerotrace-prod-signing` (`ECC_NIST_P256`, `SIGN_VERIFY`). Only the task role may sign.
- Secrets Manager: `aerotrace/prod/database-url`, `session-secret`, `admin-password`, `db-master`. The task role can also read secrets you add under `aerotrace/prod/connectors/`.
- CloudWatch log groups, X-Ray traces, an `AeroTrace` metric namespace, alarms and an SNS topic.
- ECR repository `aerotrace-gate` (scan on push, immutable tags) and an IAM role GitHub can assume through OIDC.

## Prerequisites

- An AWS account and credentials with admin rights for the first apply.
- Terraform 1.6 or later, the AWS CLI v2, Docker with buildx, and `jq`.
- The final hostname, for example `gate.example.com`, and access to its DNS.
- An ACM certificate for that hostname **in the same region**, already issued:

```bash
aws acm request-certificate --domain-name gate.example.com --validation-method DNS --region us-east-1
# add the CNAME it asks for to your DNS, then wait:
aws acm wait certificate-validated --certificate-arn <arn> --region us-east-1
```

## 1. Configure

```bash
cd deploy/terraform/aws
cp terraform.tfvars.example terraform.tfvars
```

Set at least `public_url`, `acm_certificate_arn`, `admin_email`, `github_repo` and `alarm_email`. Put a remote state backend in `versions.tf` (an S3 bucket with encryption and a lock table). State contains the database password.

If the image you are about to run cannot read `*_REF` variables yet, set `secret_delivery = "platform"`. ECS then injects `DATABASE_URL`, `SESSION_SECRET` and `ADMIN_PASSWORD` from Secrets Manager itself.

## 2. Create the registry and push the first image

The task definitions point at an image in ECR, so the repository has to exist and hold the image before ECS can start anything.

```bash
terraform init
terraform apply -target=aws_ecr_repository.app

REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO%%/*}"

cd ../../..
docker buildx build --platform linux/amd64 --build-arg VERSION=3.0.0 -t "$REPO:3.0.0" --push .
cd deploy/terraform/aws
```

Use the same tag as `image_tag` in `terraform.tfvars`. Tags are immutable, so a pushed tag can't be overwritten.

## 3. Apply everything

```bash
terraform plan -out tf.plan
terraform apply tf.plan
```

This takes 15 to 25 minutes, mostly RDS. Web and worker tasks start straight away and log database errors until migrate has created the schema. That is expected.

If you set `alarm_email`, confirm the SNS subscription email.

## 4. Run migrate the first time

```bash
CLUSTER=$(terraform output -raw cluster_name)
FAMILY=$(terraform output -raw migrate_task_family)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw task_security_group_id)

TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[?name==`app`].exitCode' --output text     # expect 0
```

Logs are in the log group from `terraform output log_group_name`, stream `migrate/app/<task id>`. Migrate creates the schema and, on an empty database, the first administrator from `ADMIN_EMAIL` and the generated password.

Then restart the services so they come up against the ready schema:

```bash
aws ecs update-service --cluster "$CLUSTER" --service "$(terraform output -raw web_service_name)" --force-new-deployment >/dev/null
aws ecs update-service --cluster "$CLUSTER" --service "$(terraform output -raw worker_service_name)" --force-new-deployment >/dev/null
```

## 5. DNS

Point the hostname at the load balancer. With Route 53, use an alias record (`alb_dns_name` and `alb_zone_id`). Elsewhere, a CNAME to `alb_dns_name`.

```bash
curl -fsS https://gate.example.com/api/health
curl -fsS https://gate.example.com/api/ready
```

## 6. First sign-in

```bash
aws secretsmanager get-secret-value --secret-id aerotrace/prod/admin-password --query SecretString --output text
```

Open `https://gate.example.com`, sign in with `admin_email` and that password, and set a new password when asked. Then enrol a passkey. The passkey is bound to the host in `PUBLIC_URL`. If people will also reach the app on another name, set `RP_ID` (a parent domain) and `RP_ORIGINS` in `extra_environment` **before** anyone enrols; moving later means everyone enrols again.

The bootstrap password in Secrets Manager stops mattering once it is changed. You may delete its value or leave it.

## 7. Connect GitHub

The workflow builds the image, pushes it to ECR, registers new task definition revisions, runs migrate and waits for exit code 0, then updates both services, waits for them to settle and checks that the deployment circuit breaker did not roll back. Finally it calls `/api/health` and `/api/ready` on the public URL.

1. In the repository, create an environment named `production`. Add required reviewers if you want an approval step, and under *Deployment branches and tags* allow `main` and tags matching `v*`.
2. Set the variables from Terraform:

```bash
terraform output -json github_variables | jq -r 'to_entries[] | "\(.key)\t\(.value)"' |
  while IFS=$'\t' read -r k v; do gh variable set "$k" --env production --body "$v"; done
```

| Variable | Terraform output |
| --- | --- |
| `AWS_REGION` | region |
| `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arn` |
| `ECR_REPOSITORY_URL` | `ecr_repository_url` |
| `ECS_CLUSTER` | `cluster_name` |
| `ECS_WEB_SERVICE`, `ECS_WORKER_SERVICE` | `web_service_name`, `worker_service_name` |
| `ECS_WEB_FAMILY`, `ECS_WORKER_FAMILY`, `ECS_MIGRATE_FAMILY` | `*_task_family` |
| `ECS_SUBNETS` | `private_subnet_ids`, comma-joined |
| `ECS_SECURITY_GROUP` | `task_security_group_id` |
| `ECS_LOG_GROUP` | `log_group_name` |
| `AEROTRACE_PUBLIC_URL` | `public_url` |

3. Run it: *Actions → deploy-aws → Run workflow*, or push a tag such as `v3.0.1`. A tag deploys an image tagged with the tag name; a manual run uses the commit SHA unless you type a tag.

The deploy role trusts tokens whose subject is `repo:<owner>/<repo>:environment:production` or `repo:<owner>/<repo>:ref:refs/heads/main`. It may push to this one ECR repository, register task definitions, run the migrate family on this cluster, update these two services and pass these two roles. Nothing else.

**Terraform changes and the services.** The services ignore `task_definition` in Terraform because the workflow owns revisions. When you change an environment variable in Terraform, apply creates a new revision; the next workflow run copies the latest revision and only swaps the image, so the change goes out with that deploy. To ship it right away, run the workflow with the current image tag.

## Evidence connector tokens

Evidence sources ([connectors.md](../connectors.md)) read their Git, Jira and CI tokens from Secrets Manager. Terraform sets `CONNECTOR_SECRET_PREFIXES=aws-sm://aerotrace/prod/connectors/` on web and worker and lets the task role read secrets under that path. It does not create any; you add them. Encrypt them with the data key, which the task role can already decrypt:

```bash
aws secretsmanager create-secret \
  --name aerotrace/prod/connectors/github \
  --kms-key-id "$(terraform output -raw connector_secret_kms_key)" \
  --secret-string 'github_pat_...'
```

In the source, type the token reference by name, not ARN: `aws-sm://aerotrace/prod/connectors/github`. An ARN doesn't start with the prefix, so the app refuses it. A JSON secret works too; pick one key with `#`, as in `aws-sm://aerotrace/prod/connectors/jira#token`. `terraform output connector_secret_prefix` prints the prefix for your name and environment.

If GitHub Enterprise or Jira Data Center sits on a private address, set `connector_allowed_hosts = "github.internal.example.com"` and apply. The tasks can only make outbound connections on port 443, so a host that needs plain http also needs an extra egress rule. Like any other environment change, the new value reaches the running services with the next deploy (see *Terraform changes and the services* above).

## Rotating the signing key

KMS asymmetric keys do not rotate automatically. Rotation means a new key:

```bash
cd deploy/terraform/aws
OLD=$(terraform output -raw signing_key_arn)
ALIAS=$(terraform output -raw signing_key_alias)
terraform state rm aws_kms_key.signing aws_kms_alias.signing   # Terraform forgets the old key; AWS keeps it
aws kms delete-alias --alias-name "$ALIAS"                     # free the alias name
terraform apply                                                 # new key, same alias, new task definition revisions
```

Then run the deploy workflow with the current image tag so web and worker start on the new revisions. Check `https://gate.example.com/api/keys`: it should list both the old and the new public key. The app keeps every public key it has used, so decisions signed with the old key still verify.

Once you are satisfied, stop the old key from signing anything else:

```bash
aws kms disable-key --key-id "$OLD"
```

Keep it disabled rather than deleted. An auditor may want to fetch its public key from KMS directly.

## Backups and restore

- **Database.** Automated backups with point-in-time recovery for 14 days (`db_backup_retention_days`). A final snapshot `aerotrace-prod-db-final` is taken if the instance is ever deleted.
- **Evidence.** Versioning keeps every earlier version of every object. The app's role cannot delete versions.

Restore the database to a point in time into a new instance:

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier aerotrace-prod-db \
  --target-db-instance-identifier aerotrace-prod-db-restored \
  --restore-time 2026-10-01T09:30:00Z \
  --db-subnet-group-name aerotrace-prod-db \
  --vpc-security-group-ids <db security group id> \
  --db-parameter-group-name aerotrace-prod-pg16 \
  --multi-az
```

Check the restored data (from a task in the VPC), then point the app at it by writing a new `database-url` secret value with the new host and forcing a new deployment of both services. Afterwards, either keep the restored instance and bring it under Terraform with `terraform import`, or swap identifiers (`modify-db-instance --new-db-instance-identifier`) so the original name points at the restored data.

An old evidence object: `aws s3api list-object-versions --bucket <bucket> --prefix evidence/<key>` and copy the version you want back on top.

## Pilot or production

| Setting | Pilot | Production |
| --- | --- | --- |
| `db_instance_class` | `db.t4g.small` | `db.m7g.large` or larger |
| `db_multi_az` | `false` | `true` |
| `nat_gateway_ha` | `false` (one NAT) | `true` (one per AZ) |
| `web_desired_count` | 1 | 2 or more |
| `worker_desired_count` / `worker_max_count` | 1 / 2 | 2 / 10-20 |
| `enable_waf` | `false` | `true` |
| `container_insights` | `false` | `true` |
| `log_retention_days` | 30 | 365 or your retention policy |

NAT gateways, the ALB and RDS are the fixed costs. A pilot with the settings above runs on a small monthly budget; Multi-AZ RDS roughly doubles the database line.

## Teardown

Everything that holds data is protected. To remove an environment on purpose:

1. Set `deletion_protection = false` in `terraform.tfvars` and `terraform apply`.
2. Empty the evidence bucket, all versions included (the console's *Empty* button does this), and delete the images in ECR.
3. `terraform destroy`.

What stays behind: the final RDS snapshot (delete it by hand when you no longer need it), KMS keys in their 30-day pending-deletion window (cancel with `aws kms cancel-key-deletion` if you change your mind), and secrets in their 7-day recovery window. If the GitHub OIDC provider was created here and other roles use it, set `create_github_oidc_provider = false` and `terraform state rm` it before destroying.

## Notes

- The ADOT collector image defaults to `:latest`. Pin a version for production (`otel_collector_image`).
- Interface VPC endpoints (Secrets Manager, KMS, ECR, Logs) are not created; that traffic goes through NAT over TLS. Add them if your policy forbids AWS API calls leaving the VPC.
- The EMF log group is `/aerotrace/metrics` in every environment, because the collector config names it. Two environments in one account share it, told apart by the `deployment.environment` resource attribute.
