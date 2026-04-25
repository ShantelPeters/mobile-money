variable "project" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the DB subnet group"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group ID for the database"
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage allocation in GB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Maximum autoscaling storage in GB"
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the default database"
  type        = string
  default     = "mobilemoney_stellar"
}

variable "db_username" {
  description = "Master database username"
  type        = string
  default     = "mobilemoney"
  sensitive   = true
}

variable "db_password" {
  description = "Master database password"
  type        = string
  sensitive   = true
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment"
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Number of days to retain automated backups"
  type        = number
  default     = 7
}

# ── Disaster Recovery ──────────────────────────────────────────────────────
variable "dr_replica_enabled" {
  description = "Create a cross-region read replica for disaster recovery"
  type        = bool
  default     = false
}

variable "dr_region" {
  description = "AWS region for the DR replica (e.g. eu-west-1)"
  type        = string
  default     = "eu-west-1"
}

variable "dr_replica_instance_class" {
  description = "RDS instance class for the DR replica"
  type        = string
  default     = "db.t3.small"
}

variable "dr_private_subnet_ids" {
  description = "Private subnet IDs in the DR region for the replica subnet group"
  type        = list(string)
  default     = []
}

variable "dr_security_group_id" {
  description = "Security group ID in the DR region for the replica"
  type        = string
  default     = ""
}
