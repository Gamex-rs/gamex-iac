# Gamex — Infrastructure & IAC Specification

> **Repository:** `gamex-rs/gamex-iac`  
> **Version:** 1.0  
> **Date:** 2026-05-12

---

## 1. Purpose

This repository contains all Terraform code that provisions and manages Gamex infrastructure on AWS. It covers both the `gx-dev` and `gx-prod` environments on a single AWS account, the shared resources used by both, and the local Docker Compose setup used by developers.

---

## 2. Tech Stack

| Concern | Technology |
|---|---|
| IaC tool | Terraform >= 1.7 |
| Provider | AWS (`hashicorp/aws` ~> 5.0) |
| State backend | S3 + DynamoDB state locking |
| Secret management | AWS Secrets Manager + SSM Parameter Store |
| Container registry | AWS ECR (one repository per service) |
| DNS | AWS Route 53 |
| TLS | AWS ACM |

---

## 3. Repository Structure

```
gamex-iac/
├── environments/
│   ├── dev/
│   │   ├── main.tf           # Root module for gx-dev
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── terraform.tfvars  # Non-secret dev values (committed)
│   └── prod/
│       ├── main.tf           # Root module for gx-prod
│       ├── variables.tf
│       ├── outputs.tf
│       └── terraform.tfvars  # Non-secret prod values (committed)
├── modules/
│   ├── ecs-service/          # Reusable ECS Fargate service + task definition
│   ├── aurora-mysql/         # Aurora Serverless v2 cluster + instance
│   ├── sqs-queue/            # SQS queue + optional DLQ pair
│   ├── s3-cloudflare/        # S3 bucket + Cloudflare CDN
│   ├── ecr/                  # ECR repository
│   └── networking/           # VPC, subnets, security groups, NAT gateway
├── shared/
│   ├── ecr.tf                # ECR repositories (shared across envs)
│   ├── route53.tf            # Hosted zone (shared)
│   └── backend.tf            # S3 state bucket and DynamoDB lock table
├── docker-compose.yml        # Local development — all services + databases
├── docker-compose.override.yml.example
└── .github/
    └── workflows/
        ├── tf-plan.yml       # Plan on PR
        └── tf-apply.yml      # Apply on merge to main (dev) or tag (prod)
```

---

## 4. Environments

| Environment | Terraform workspace | Resource prefix | Domain |
|---|---|---|---|
| Dev | `dev` | `gx-dev-*` | `dev.gamex.rs`, `api.dev.gamex.rs` |
| Prod | `prod` | `gx-prod-*` | `gamex.rs`, `api.gamex.rs` |

Both environments are on the **same AWS account**, separated by resource naming and VPC isolation.

---

## 5. Shared Resources (provisioned once)

These resources are not environment-specific and are managed in `shared/`:

| Resource | Purpose |
|---|---|
| S3 bucket (`gamex-tf-state`) | Terraform remote state |
| DynamoDB table (`gamex-tf-lock`) | State locking |
| Route 53 hosted zone (`gamex.rs`) | DNS for all environments |
| ECR repository per service | One repo, multiple tags (dev / prod image tags differ by git SHA) |

### ECR Repositories

```
gamex/game-catalog-svc
gamex/user-library-svc
gamex/messaging-svc
gamex/notification-svc
```

---

## 6. Per-Environment Resources

Each environment provisions the following via its root module, using shared child modules.

### 6.1 Networking (`modules/networking`)

| Resource | Config |
|---|---|
| VPC | CIDR `10.{env}.0.0/16` (dev: `10.1`, prod: `10.2`) |
| Public subnets (x2) | One per AZ — ALB and NAT gateway |
| Private subnets (x2) | One per AZ — ECS tasks and Aurora |
| Internet Gateway | For public subnets |
| NAT Gateway | One per env (dev: single AZ, prod: one per AZ) |
| Security groups | ALB, ECS tasks, Aurora, SQS (VPC endpoints) |

### 6.2 ECS Cluster

One ECS cluster per environment: `gx-{env}-cluster`

All services run as **ECS Fargate** tasks. No EC2 instances.

### 6.3 ECS Services (`modules/ecs-service`)

One module instance per service:

| Service | CPU | Memory | Min tasks | Max tasks |
|---|---|---|---|---|
| `game-catalog-svc` | 256 | 512 MB | dev: 1, prod: 2 | dev: 2, prod: 4 |
| `user-library-svc` | 512 | 1024 MB | dev: 1, prod: 2 | dev: 2, prod: 4 |
| `messaging-svc` | 256 | 512 MB | dev: 1, prod: 2 | dev: 2, prod: 4 |
| `notification-svc` | 256 | 512 MB | dev: 1, prod: 2 | dev: 2, prod: 4 |

Each module instance provisions:
- ECS task definition (container image from ECR, env vars from SSM/Secrets Manager, CloudWatch log group)
- ECS service with desired count and auto-scaling policy (CPU target 70%)
- IAM task execution role and task role (scoped to required SSM/Secrets paths and SQS queues)
- ALB target group and listener rule (path-based routing via API Gateway or ALB)

### 6.4 Aurora MySQL (`modules/aurora-mysql`)

One Aurora Serverless v2 cluster per service per environment (4 clusters per environment, 8 total):

| Cluster name | Min ACU | Max ACU |
|---|---|---|
| `gx-{env}-games-db` | dev: 0.5, prod: 1 | dev: 2, prod: 8 |
| `gx-{env}-library-db` | dev: 0.5, prod: 1 | dev: 4, prod: 16 |
| `gx-{env}-messaging-db` | dev: 0.5, prod: 1 | dev: 2, prod: 8 |
| `gx-{env}-notifications-db` | dev: 0.5, prod: 1 | dev: 2, prod: 8 |

Each module instance provisions:
- Aurora Serverless v2 cluster (MySQL 8.0 compatible)
- One writer instance
- Subnet group (private subnets)
- Security group rule allowing ECS tasks to connect on port 3306
- Master credentials stored in Secrets Manager: `gx/{env}/{service}-db-credentials`

### 6.5 SQS Queues (`modules/sqs-queue`)

| Queue | DLQ | Max receive count |
|---|---|---|
| `gx-{env}-library-events` | `gx-{env}-library-events-dlq` | 3 |
| `gx-{env}-activity-events` | `gx-{env}-activity-events-dlq` | 3 |

Each module instance provisions the main queue and the DLQ, with a redrive policy linking them.

### 6.6 S3 + Cloudflare (`modules/s3-cloudflare`)

Three Cloudflare CDN entries per environment:

| Entry | Origin | Domain |
|---|---|---|
| Frontend SPA | Cloudflare Pages (`gx-{env}-frontend`) | `{env-prefix}gamex.rs` |
| API gateway | ALB | `api.{env-prefix}gamex.rs` |
| Media (game covers) | S3 (`gx-media`), proxied via Cloudflare | `media.{env-prefix}gamex.rs` |

The media bucket is shared between environments (different path prefixes: `/dev/` and `/prod/`).

Cloudflare handles DNS, CDN caching, and DDoS protection for all domains directly.

### 6.7 Secrets Manager & SSM Parameter Store

Secrets and parameters are namespaced by environment: `gx/{env}/`.

**Secrets Manager** (sensitive values, rotated):

| Path | Value |
|---|---|
| `gx/{env}/rawg-api-key` | RAWG API key |
| `gx/{env}/jwt-private-key` | RS256 private key PEM |
| `gx/{env}/google-oauth` | `{ clientId, clientSecret }` |
| `gx/{env}/facebook-oauth` | `{ appId, appSecret }` |
| `gx/{env}/game-catalog-db` | `{ host, port, user, password, database }` |
| `gx/{env}/user-library-db` | `{ host, port, user, password, database }` |
| `gx/{env}/messaging-db` | `{ host, port, user, password, database }` |
| `gx/{env}/notifications-db` | `{ host, port, user, password, database }` |

**SSM Parameter Store** (non-sensitive config):

| Path | Value |
|---|---|
| `gx/{env}/jwt-public-key` | RS256 public key PEM |
| `gx/{env}/sqs/library-events-url` | SQS queue URL |
| `gx/{env}/sqs/activity-events-url` | SQS queue URL |
| `gx/{env}/s3/media-bucket` | Bucket name |
| `gx/{env}/cloudflare/media-base-url` | Cloudflare media URL |
| `gx/{env}/frontend-base-url` | Frontend origin URL |

---

## 7. IAM Strategy

- Each ECS task has a dedicated **task IAM role** with least-privilege permissions
- Permissions scoped to specific SQS queue ARNs and SSM/Secrets paths for that service
- No service has `*` permissions on any resource
- ECR pull permissions are on the **task execution role**, shared pattern across services

---

## 8. CI/CD

### Terraform Workflows

| Workflow | Trigger | Action |
|---|---|---|
| `tf-plan.yml` | Pull request to `main` | `terraform plan` for dev environment; post plan summary as PR comment |
| `tf-apply-dev.yml` | Merge to `main` | `terraform apply` for dev environment (auto-approve) |
| `tf-apply-prod.yml` | Tag `infra-prod-*` | `terraform apply` for prod environment (manual approval required in GitHub Actions) |

Terraform state is stored in S3 with DynamoDB locking. The GitHub Actions runner assumes an IAM role via OIDC — no long-lived AWS credentials in GitHub Secrets.

---

## 9. Local Development (Docker Compose)

The `docker-compose.yml` at the root of this repo is the single file developers use to run the full Gamex backend stack locally. Service repositories each have their own `docker-compose.yml` for running that service in isolation, but this repo's file wires everything together.

```yaml
# docker-compose.yml
version: "3.9"

services:

  # ── Game Catalog ──────────────────────────────────────────────────────
  game-catalog-svc:
    image: gamex/game-catalog-svc:local
    build:
      context: ../gamex-game-catalog-svc
    ports:
      - "5001:8080"
    env_file: .env
    environment:
      DB_CONNECTION_STRING: "Server=catalog-db;Database=games_db;User=root;Password=localdev;"
      SQS_LIBRARY_EVENTS_URL: "http://localstack:4566/000000000000/gamex-library-events"
    depends_on: [catalog-db, localstack]

  catalog-db:
    image: mysql:8.0
    environment: { MYSQL_DATABASE: games_db, MYSQL_ROOT_PASSWORD: localdev }
    ports: ["3307:3306"]
    volumes: [catalog-db-data:/var/lib/mysql]

  # ── User Library ──────────────────────────────────────────────────────
  user-library-svc:
    image: gamex/user-library-svc:local
    build:
      context: ../gamex-user-library-svc
    ports:
      - "5002:8080"
    env_file: .env
    environment:
      DB_CONNECTION_STRING: "Server=library-db;Database=library_db;User=root;Password=localdev;"
      SQS_LIBRARY_EVENTS_URL: "http://localstack:4566/000000000000/gamex-library-events"
      SQS_ACTIVITY_EVENTS_URL: "http://localstack:4566/000000000000/gamex-activity-events"
    depends_on: [library-db, localstack]

  library-db:
    image: mysql:8.0
    environment: { MYSQL_DATABASE: library_db, MYSQL_ROOT_PASSWORD: localdev }
    ports: ["3308:3306"]
    volumes: [library-db-data:/var/lib/mysql]

  # ── Messaging ─────────────────────────────────────────────────────────
  messaging-svc:
    image: gamex/messaging-svc:local
    build:
      context: ../gamex-messaging-svc
    ports:
      - "5003:8080"
    env_file: .env
    environment:
      DB_CONNECTION_STRING: "Server=messaging-db;Database=messaging_db;User=root;Password=localdev;"
      SQS_ACTIVITY_EVENTS_URL: "http://localstack:4566/000000000000/gamex-activity-events"
    depends_on: [messaging-db, localstack]

  messaging-db:
    image: mysql:8.0
    environment: { MYSQL_DATABASE: messaging_db, MYSQL_ROOT_PASSWORD: localdev }
    ports: ["3309:3306"]
    volumes: [messaging-db-data:/var/lib/mysql]

  # ── Notifications ─────────────────────────────────────────────────────
  notification-svc:
    image: gamex/notification-svc:local
    build:
      context: ../gamex-notification-svc
    ports:
      - "5004:8080"
    env_file: .env
    environment:
      DB_CONNECTION_STRING: "Server=notification-db;Database=notifications_db;User=root;Password=localdev;"
      SQS_ACTIVITY_EVENTS_URL: "http://localstack:4566/000000000000/gamex-activity-events"
    depends_on: [notification-db, localstack]

  notification-db:
    image: mysql:8.0
    environment: { MYSQL_DATABASE: notifications_db, MYSQL_ROOT_PASSWORD: localdev }
    ports: ["3310:3306"]
    volumes: [notification-db-data:/var/lib/mysql]

  # ── LocalStack (SQS emulation) ────────────────────────────────────────
  localstack:
    image: localstack/localstack:3
    ports:
      - "4566:4566"
    environment:
      SERVICES: sqs
    volumes:
      - ./localstack-init:/etc/localstack/init/ready.d  # init scripts to create queues

volumes:
  catalog-db-data:
  library-db-data:
  messaging-db-data:
  notification-db-data:
```

### LocalStack SQS Init Script

`localstack-init/01-create-queues.sh`:

```bash
#!/bin/bash
awslocal sqs create-queue --queue-name gamex-library-events
awslocal sqs create-queue --queue-name gamex-library-events-dlq
awslocal sqs create-queue --queue-name gamex-activity-events
awslocal sqs create-queue --queue-name gamex-activity-events-dlq
```

### Local `.env` file (not committed)

Copy `.env.example` and fill in:

```
RAWG_API_KEY=
JWT_PRIVATE_KEY=<pem>
JWT_PUBLIC_KEY=<pem>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
```

### Running locally

```bash
# From gamex-iac root, with sibling service repos checked out
docker compose up --build

# Frontend (from gamex-frontend repo)
npm run dev
```

All backend services available at:
- Game Catalog: http://localhost:5001
- User Library: http://localhost:5002
- Messaging: http://localhost:5003
- Notifications: http://localhost:5004
- LocalStack SQS: http://localhost:4566

---

## 10. Sibling Repo Layout (expected on developer machine)

```
~/projects/gamex/
├── gamex-iac/                  ← this repo
├── gamex-frontend/
├── gamex-game-catalog-svc/
├── gamex-user-library-svc/
├── gamex-messaging-svc/
└── gamex-notification-svc/
```

The Docker Compose `build.context` paths in `docker-compose.yml` use relative `../` paths and expect this layout.
