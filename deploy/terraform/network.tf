locals {
  name = "shopcore-${var.environment}"
}

# Three-AZ VPC. One NAT gateway per AZ: a single shared NAT is a single point of failure
# and a cross-AZ data charge for every egress byte.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.16"

  name = local.name
  cidr = var.vpc_cidr
  azs  = var.azs

  private_subnets     = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 4, i)] # /20 each: pods use VPC IPs
  public_subnets      = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 8, 48 + i)]
  database_subnets    = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 8, 64 + i)]
  elasticache_subnets = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 8, 80 + i)]

  enable_nat_gateway     = true
  single_nat_gateway     = false
  one_nat_gateway_per_az = true

  create_database_subnet_group    = true
  create_elasticache_subnet_group = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = true
  create_flow_log_cloudwatch_log_group = true
  flow_log_max_aggregation_interval    = 60

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1, "karpenter.sh/discovery" = local.name }
}

# Keep S3 / ECR / STS traffic off the NAT gateways.
module "vpc_endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.16"

  vpc_id = module.vpc.vpc_id
  endpoints = {
    s3      = { service = "s3", service_type = "Gateway", route_table_ids = module.vpc.private_route_table_ids }
    ecr_api = { service = "ecr.api", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
    ecr_dkr = { service = "ecr.dkr", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
    sts     = { service = "sts", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
    secrets = { service = "secretsmanager", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
  }
  create_security_group      = true
  security_group_name_prefix = "${local.name}-vpce-"
  security_group_rules = {
    https_from_vpc = { cidr_blocks = [var.vpc_cidr], description = "HTTPS from VPC" }
  }
}
