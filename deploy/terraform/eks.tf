# EKS with a small managed node group for cluster add-ons and Karpenter for application capacity.
# Karpenter provisions right-sized nodes in seconds when the HPA adds pods (spike handling)
# and consolidates them afterwards (cost).
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = local.name
  cluster_version = var.eks_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = false # operators reach the API via VPN / SSM; CI via a runner in the VPC
  enable_irsa                    = true
  authentication_mode            = "API"

  cluster_enabled_log_types = ["api", "audit", "authenticator"]
  cluster_encryption_config = { resources = ["secrets"] } # envelope-encrypt Kubernetes Secrets with KMS

  cluster_addons = {
    coredns                = { most_recent = true }
    kube-proxy             = { most_recent = true }
    vpc-cni                = { most_recent = true, configuration_values = jsonencode({ env = { ENABLE_PREFIX_DELEGATION = "true" } }) }
    eks-pod-identity-agent = { most_recent = true }
    aws-ebs-csi-driver     = { most_recent = true }
  }

  eks_managed_node_groups = {
    system = {
      instance_types = ["m7g.large"]
      ami_type       = "AL2023_ARM_64_STANDARD"
      min_size       = 3
      max_size       = 6
      desired_size   = 3
      labels         = { "workload" = "system" }
      taints = {
        system = { key = "CriticalAddonsOnly", value = "true", effect = "NO_SCHEDULE" }
      }
    }
  }

  node_security_group_tags = { "karpenter.sh/discovery" = local.name }
}

module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 20.31"

  cluster_name          = module.eks.cluster_name
  enable_v1_permissions = true
  node_iam_role_additional_policies = {
    AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }
}

resource "aws_ecr_repository" "app" {
  name                 = "shopcore"
  image_tag_mutability = "IMMUTABLE" # a tag always means the same bits; rollbacks are exact
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 200 images (rollback window)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 200 }
      action       = { type = "expire" }
    }]
  })
}

# Pod role: read only this service's secret.
module "app_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name = "${local.name}-app"
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["shopcore:shopcore"]
    }
  }
  role_policy_arns = { secrets = aws_iam_policy.app_secrets.arn }
}

resource "aws_iam_policy" "app_secrets" {
  name = "${local.name}-app-secrets"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [aws_secretsmanager_secret.app.arn]
    }]
  })
}
