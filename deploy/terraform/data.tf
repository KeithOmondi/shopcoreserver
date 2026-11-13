resource "aws_kms_key" "data" {
  description             = "${local.name} data-at-rest encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

# ---------------------------------------------------------------- Aurora PostgreSQL
resource "aws_security_group" "db" {
  name_prefix = "${local.name}-db-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description     = "Postgres from EKS nodes/pods and RDS Proxy"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
    self            = true
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_rds_cluster_parameter_group" "pg" {
  name_prefix = "${local.name}-"
  family      = "aurora-postgresql16"
  # Server-side guards mirror the app's own timeouts, so a misbehaving client cannot hold locks.
  parameter {
    name  = "statement_timeout"
    value = "5000"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "10000"
  }
  parameter {
    name  = "lock_timeout"
    value = "3000"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "250"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,auto_explain"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "auto_explain.log_min_duration"
    value = "1000"
  }
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  lifecycle { create_before_destroy = true }
}

resource "random_password" "db_master" {
  length  = 40
  special = false
}

resource "aws_rds_cluster" "main" {
  cluster_identifier              = local.name
  engine                          = "aurora-postgresql"
  engine_version                  = "16.4"
  database_name                   = "shopcore"
  master_username                 = "shopcore_admin"
  master_password                 = random_password.db_master.result
  db_subnet_group_name            = module.vpc.database_subnet_group_name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.pg.name

  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn
  storage_type          = "aurora-iopt1" # I/O-Optimized: predictable cost at high write IOPS
  deletion_protection   = true
  copy_tags_to_snapshot = true

  backup_retention_period      = 35 # point-in-time restore window (max)
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:04:30-sun:05:30"
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-final"

  enabled_cloudwatch_logs_exports       = ["postgresql"]
  iam_database_authentication_enabled   = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 31

  global_cluster_identifier = var.enable_aurora_global ? aws_rds_global_cluster.main[0].id : null
}

resource "aws_rds_cluster_instance" "writer" {
  identifier                   = "${local.name}-1"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = var.aurora_instance_class
  engine                       = aws_rds_cluster.main.engine
  engine_version               = aws_rds_cluster.main.engine_version
  promotion_tier               = 0
  monitoring_interval          = 15
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled = true
  auto_minor_version_upgrade   = false
}

# Readers in different AZs. A reader of the same class as the writer is promotion tier 1,
# so failover lands on an instance that can carry the write load (~30s failover).
resource "aws_rds_cluster_instance" "reader" {
  count                        = var.aurora_reader_count
  identifier                   = "${local.name}-r${count.index + 1}"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = count.index == 0 ? var.aurora_instance_class : var.aurora_reader_instance_class
  engine                       = aws_rds_cluster.main.engine
  engine_version               = aws_rds_cluster.main.engine_version
  availability_zone            = var.azs[(count.index + 1) % length(var.azs)]
  promotion_tier               = count.index == 0 ? 1 : 2
  monitoring_interval          = 15
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled = true
  auto_minor_version_upgrade   = false
}

resource "aws_appautoscaling_target" "readers" {
  service_namespace  = "rds"
  scalable_dimension = "rds:cluster:ReadReplicaCount"
  resource_id        = "cluster:${aws_rds_cluster.main.id}"
  min_capacity       = var.aurora_reader_count
  max_capacity       = var.aurora_reader_max
}

resource "aws_appautoscaling_policy" "readers" {
  name               = "${local.name}-reader-cpu"
  service_namespace  = aws_appautoscaling_target.readers.service_namespace
  scalable_dimension = aws_appautoscaling_target.readers.scalable_dimension
  resource_id        = aws_appautoscaling_target.readers.resource_id
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification { predefined_metric_type = "RDSReaderAverageCPUUtilization" }
    target_value       = 50
    scale_in_cooldown  = 600
    scale_out_cooldown = 120
  }
}

resource "aws_rds_global_cluster" "main" {
  count                     = var.enable_aurora_global ? 1 : 0
  global_cluster_identifier = "${local.name}-global"
  engine                    = "aurora-postgresql"
  engine_version            = "16.4"
  database_name             = "shopcore"
  storage_encrypted         = true
}

resource "aws_iam_role" "rds_monitoring" {
  name_prefix = "${local.name}-rds-mon-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---------------------------------------------------------------- RDS Proxy
# Multiplexes ~1,500 pod connections (pods x pool) onto a bounded set of DB connections and
# hides failover from clients (connections are held, not dropped, during writer failover).
resource "aws_secretsmanager_secret" "db_master" {
  name_prefix = "${local.name}/db-master-"
  kms_key_id  = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "db_master" {
  secret_id     = aws_secretsmanager_secret.db_master.id
  secret_string = jsonencode({ username = aws_rds_cluster.main.master_username, password = random_password.db_master.result })
}

resource "aws_iam_role" "proxy" {
  name_prefix = "${local.name}-proxy-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  inline_policy {
    name = "secrets"
    policy = jsonencode({
      Version = "2012-10-17"
      Statement = [
        { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.db_master.arn] },
        { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.data.arn] },
      ]
    })
  }
}

resource "aws_db_proxy" "main" {
  name                   = local.name
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = module.vpc.database_subnets
  vpc_security_group_ids = [aws_security_group.db.id]
  require_tls            = true
  idle_client_timeout    = 1800
  debug_logging          = false
  auth {
    auth_scheme = "SECRETS"
    secret_arn  = aws_secretsmanager_secret.db_master.arn
    iam_auth    = "DISABLED"
  }
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name
  connection_pool_config {
    max_connections_percent      = 80
    max_idle_connections_percent = 40
    connection_borrow_timeout    = 3
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name         = aws_db_proxy.main.name
  target_group_name     = aws_db_proxy_default_target_group.main.name
  db_cluster_identifier = aws_rds_cluster.main.id
}

resource "aws_db_proxy_endpoint" "reader" {
  db_proxy_name          = aws_db_proxy.main.name
  db_proxy_endpoint_name = "${local.name}-ro"
  vpc_subnet_ids         = module.vpc.database_subnets
  vpc_security_group_ids = [aws_security_group.db.id]
  target_role            = "READ_ONLY"
}

# ---------------------------------------------------------------- ElastiCache Redis (cluster mode)
resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-redis-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  lifecycle { create_before_destroy = true }
}

resource "random_password" "redis_auth" {
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "shopcore cache + rate limiting"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_node_groups            = var.redis_shards
  replicas_per_node_group    = 1
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = module.vpc.elasticache_subnet_group_name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  parameter_group_name       = "default.redis7.cluster.on"
  snapshot_retention_limit   = 1 # cache is rebuildable; snapshots only speed up warm restarts
  maintenance_window         = "sun:05:30-sun:06:30"
}

# ---------------------------------------------------------------- MSK (Kafka) for domain events
resource "aws_security_group" "msk" {
  name_prefix = "${local.name}-msk-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_msk_configuration" "main" {
  name              = local.name
  kafka_versions    = ["3.6.0"]
  server_properties = <<-EOT
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    unclean.leader.election.enable=false
    num.partitions=24
  EOT
}

resource "aws_msk_cluster" "main" {
  cluster_name           = local.name
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 3
  broker_node_group_info {
    instance_type   = var.msk_instance_type
    client_subnets  = module.vpc.private_subnets
    security_groups = [aws_security_group.msk.id]
    storage_info {
      ebs_storage_info { volume_size = 500 }
    }
  }
  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }
  encryption_info {
    encryption_at_rest_kms_key_arn = aws_kms_key.data.arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }
  enhanced_monitoring = "PER_TOPIC_PER_PARTITION"
}

# ---------------------------------------------------------------- Application secret
# DATABASE_URL etc. are assembled here and synced into the cluster by External Secrets.
# The application DB role (least privilege, no DDL) is created by migration 0000 bootstrap (docs).
resource "aws_secretsmanager_secret" "app" {
  name       = "shopcore/${var.environment}/app"
  kms_key_id = aws_kms_key.data.arn
}
