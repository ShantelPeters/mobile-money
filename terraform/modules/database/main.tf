# ──────────────────────────────────────────────────────────────────────────────
# Database Module – RDS PostgreSQL 16
# Managed PostgreSQL instance matching the project's existing Postgres 16 usage.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.environment}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-db-subnet"
    Environment = var.environment
  }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project}-${var.environment}-pg16-params"
  family = "postgres16"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    Name        = "${var.project}-${var.environment}-pg-params"
    Environment = var.environment
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.project}-${var.environment}-postgres"

  # Engine
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.postgres.name

  # Storage
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database
  db_name  = var.db_name
  username = var.db_username
  password = var.db_password
  port     = 5432

  # Network
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  # Backup & Maintenance — retention must be ≥1 for cross-region replica
  backup_retention_period = max(var.db_backup_retention_days, var.dr_replica_enabled ? 7 : var.db_backup_retention_days)
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"

  # Lifecycle
  skip_final_snapshot       = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "${var.project}-${var.environment}-final-snapshot" : null
  deletion_protection       = var.environment == "production"

  tags = {
    Name        = "${var.project}-${var.environment}-postgres"
    Environment = var.environment
  }
}

# ── Cross-Region DR Read Replica ──────────────────────────────────────────
# Streams WAL from the primary via logical/physical replication.
# Promoted to primary during a regional failover.
resource "aws_db_instance" "dr_replica" {
  count = var.dr_replica_enabled ? 1 : 0

  provider   = aws.dr
  identifier = "${var.project}-${var.environment}-postgres-dr"

  # Replica source — must use the ARN for cross-region
  replicate_source_db = aws_db_instance.main.arn

  # Engine — must match primary
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.dr_replica_instance_class

  # Storage — inherited from source, encryption required
  storage_encrypted = true
  storage_type      = "gp3"

  # Network — deployed into the DR VPC/subnets
  db_subnet_group_name   = aws_db_subnet_group.dr[0].name
  vpc_security_group_ids = [var.dr_security_group_id]
  publicly_accessible    = false

  # Keep replica read-only until promoted
  # No db_name / username / password — inherited from source

  # Backup — keep snapshots on the replica too
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "04:00-05:00"
  maintenance_window      = "sun:05:30-sun:06:30"

  skip_final_snapshot = var.environment != "production"
  deletion_protection = var.environment == "production"

  tags = {
    Name        = "${var.project}-${var.environment}-postgres-dr"
    Environment = var.environment
    Role        = "dr-replica"
    DRRegion    = var.dr_region
  }
}

resource "aws_db_subnet_group" "dr" {
  count    = var.dr_replica_enabled ? 1 : 0
  provider = aws.dr

  name       = "${var.project}-${var.environment}-db-subnet-dr"
  subnet_ids = var.dr_private_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-db-subnet-dr"
    Environment = var.environment
  }
}
