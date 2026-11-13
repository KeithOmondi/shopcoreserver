# ---------------------------------------------------------------- WAF on the ALB
# Edge protections that should never reach the pods: per-IP rate limiting, AWS managed rule
# sets (OWASP top 10 patterns, known bad inputs, IP reputation), and a body-size cap.
resource "aws_wafv2_web_acl" "api" {
  name  = local.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_ip
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "per-ip-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesCommonRuleSet          = 10
      AWSManagedRulesKnownBadInputsRuleSet  = 11
      AWSManagedRulesAmazonIpReputationList = 12
      AWSManagedRulesAnonymousIpList        = 13
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

# ---------------------------------------------------------------- Backups & DR
# Aurora continuous backups give 35-day PITR in-region. AWS Backup adds daily snapshots
# copied to the DR region and a vault lock so backups cannot be deleted (ransomware, mistakes).
resource "aws_backup_vault" "primary" {
  name        = "${local.name}-primary"
  kms_key_arn = aws_kms_key.data.arn
}

resource "aws_kms_key" "dr" {
  provider            = aws.dr
  description         = "${local.name} DR backup vault"
  enable_key_rotation = true
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.name}-dr"
  kms_key_arn = aws_kms_key.dr.arn
}

resource "aws_backup_vault_lock_configuration" "dr" {
  provider            = aws.dr
  backup_vault_name   = aws_backup_vault.dr.name
  min_retention_days  = 7
  max_retention_days  = 400
  changeable_for_days = 3
}

resource "aws_backup_plan" "db" {
  name = "${local.name}-db"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 5 * * ? *)"
    lifecycle { delete_after = 35 }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 90 }
    }
  }
  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 6 1 * ? *)"
    lifecycle {
      cold_storage_after = 30
      delete_after       = 400
    }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 400 }
    }
  }
}

resource "aws_iam_role" "backup" {
  name_prefix = "${local.name}-backup-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "db" {
  name         = "${local.name}-aurora"
  plan_id      = aws_backup_plan.db.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_rds_cluster.main.arn]
}
