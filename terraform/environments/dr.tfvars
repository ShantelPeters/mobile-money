# ──────────────────────────────────────────────────────────────────────────────
# Production + DR Environment
# Extends production.tfvars with a cross-region read replica in eu-west-1.
# Apply with:
#   terraform apply -var-file=environments/production.tfvars \
#                   -var-file=environments/dr.tfvars
# ──────────────────────────────────────────────────────────────────────────────

# Primary region stays us-east-1 (set in production.tfvars)

# ── Disaster Recovery ──────────────────────────────────────────────────────
dr_replica_enabled        = true
dr_region                 = "eu-west-1"
dr_replica_instance_class = "db.t3.small"

# Pre-provisioned VPC in eu-west-1 — replace with real subnet/sg IDs
# Run `terraform output` after provisioning the DR VPC to get these values.
dr_private_subnet_ids = [
  "subnet-REPLACE_EU_WEST_1A",
  "subnet-REPLACE_EU_WEST_1B",
]
dr_security_group_id = "sg-REPLACE_EU_WEST_1_DB_SG"
