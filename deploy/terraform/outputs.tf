output "cluster_name" {
  value = module.eks.cluster_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "db_proxy_writer_endpoint" {
  value = aws_db_proxy.main.endpoint
}

output "db_proxy_reader_endpoint" {
  value = aws_db_proxy_endpoint.reader.endpoint
}

output "db_cluster_writer_endpoint" {
  description = "Direct writer endpoint, used only by the migration Job"
  value       = aws_rds_cluster.main.endpoint
}

output "redis_configuration_endpoint" {
  value = aws_elasticache_replication_group.main.configuration_endpoint_address
}

output "msk_bootstrap_brokers_tls" {
  value = aws_msk_cluster.main.bootstrap_brokers_tls
}

output "waf_acl_arn" {
  value = aws_wafv2_web_acl.api.arn
}

output "app_role_arn" {
  value = module.app_irsa.iam_role_arn
}

output "app_secret_name" {
  value = aws_secretsmanager_secret.app.name
}

output "karpenter_node_role_name" {
  value = module.karpenter.node_iam_role_name
}
