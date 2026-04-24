# Disaster Recovery Runbook — Multi-Region Database Failover

## Overview

The primary database runs in **us-east-1** (RDS PostgreSQL 16, Multi-AZ).  
A cross-region read replica streams WAL continuously to **eu-west-1**.  
RTO target: **< 15 minutes** | RPO target: **< 30 seconds** (WAL lag).

---

## Architecture

```
us-east-1 (primary)          eu-west-1 (DR)
┌─────────────────┐           ┌──────────────────────┐
│  RDS Primary    │──WAL──▶  │  RDS Read Replica    │
│  (Multi-AZ)     │           │  (cross-region)      │
└─────────────────┘           └──────────────────────┘
        ▲                              ▲
        │                              │ (after promotion)
┌─────────────────┐           ┌──────────────────────┐
│  ECS App        │           │  ECS App (DR)        │
│  DATABASE_URL   │           │  DR_DATABASE_URL     │
└─────────────────┘           └──────────────────────┘
```

---

## Normal Operations

### Check replication lag

```bash
# On the primary — shows bytes behind for each replica
aws rds describe-db-instances \
  --db-instance-identifier mobile-money-production-postgres \
  --query 'DBInstances[0].StatusInfos'

# Or via psql on the primary
psql $DATABASE_URL -c "SELECT * FROM pg_stat_replication;"
```

### Check replica health via app

```bash
curl https://api.yourdomain.com/ready | jq '.checks | {dr_replica, dr_mode}'
```

---

## Failover Procedure (Region Outage)

> **Declare incident first.** Page the on-call engineer via PagerDuty before proceeding.

### Step 1 — Confirm primary is unreachable

```bash
# Should time out or return an error
psql $DATABASE_URL -c "SELECT 1" --connect-timeout=5
```

### Step 2 — Promote the DR replica

```bash
# Get the replica identifier from Terraform output
REPLICA_ID=$(terraform -chdir=terraform output -raw dr_replica_arn | cut -d: -f7)

aws rds promote-read-replica \
  --db-instance-identifier "$REPLICA_ID" \
  --region eu-west-1

# Wait for promotion to complete (typically 1–3 minutes)
aws rds wait db-instance-available \
  --db-instance-identifier "$REPLICA_ID" \
  --region eu-west-1

echo "Replica promoted. New endpoint:"
aws rds describe-db-instances \
  --db-instance-identifier "$REPLICA_ID" \
  --region eu-west-1 \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text
```

### Step 3 — Update application configuration

Set `DR_DATABASE_URL` to the promoted replica's connection string and redeploy:

```bash
# ECS parameter store update
aws ssm put-parameter \
  --name "/mobile-money/production/DR_DATABASE_URL" \
  --value "postgresql://mobilemoney:<password>@<promoted-endpoint>:5432/mobilemoney_stellar" \
  --type SecureString \
  --overwrite \
  --region eu-west-1

# Force new ECS deployment to pick up the new env var
aws ecs update-service \
  --cluster mobile-money-production \
  --service mobile-money-production \
  --force-new-deployment \
  --region eu-west-1
```

### Step 4 — Verify

```bash
# App should report dr_mode: active
curl https://api.yourdomain.com/ready | jq .

# Smoke test a write
curl -X POST https://api.yourdomain.com/api/transactions/deposit \
  -H "Authorization: Bearer $TEST_TOKEN" \
  -d '{"amount":"100","phoneNumber":"+237670000000","provider":"mock"}'
```

### Step 5 — Update DNS (if using Route 53 failover routing)

```bash
# Point the CNAME / alias to the eu-west-1 ALB
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch file://dns-failover-eu-west-1.json
```

---

## Failback Procedure (Primary Region Restored)

1. Provision a new primary in us-east-1 from the latest snapshot of the promoted replica:
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier "$REPLICA_ID" \
     --target-db-instance-identifier mobile-money-production-postgres \
     --restore-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
     --region us-east-1
   ```
2. Once the new primary is available, set up a new read replica in eu-west-1 pointing to it.
3. Unset `DR_DATABASE_URL` and redeploy the app to route writes back to us-east-1.
4. Update DNS back to the us-east-1 ALB.

---

## Latency Impact on Writes

Run the write latency test before and after enabling the DR replica:

```bash
# Primary only
DATABASE_URL=$PRIMARY_URL npm run test:write-latency

# Primary + promoted DR replica
DATABASE_URL=$PRIMARY_URL DR_DATABASE_URL=$DR_URL npm run test:write-latency
```

Expected cross-region overhead (us-east-1 → eu-west-1): **80–120 ms** additional mean latency on writes when routing to the DR replica. Normal operations against the primary are unaffected — the replica is read-only and receives WAL asynchronously.

---

## Terraform: Enabling the DR Replica

```bash
cd terraform

terraform apply \
  -var-file=environments/production.tfvars \
  -var-file=environments/dr.tfvars
```

To disable (saves cost in non-production):

```bash
terraform apply \
  -var-file=environments/production.tfvars \
  -var 'dr_replica_enabled=false'
```

---

## Contacts

| Role            | Contact                  |
|-----------------|--------------------------|
| On-call DBA     | PagerDuty — `db-oncall`  |
| Platform Lead   | PagerDuty — `platform`   |
| Incident Bridge | Slack `#incidents`       |
