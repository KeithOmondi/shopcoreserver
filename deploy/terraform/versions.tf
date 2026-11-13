terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.81"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state with locking. Bucket/table are bootstrapped once per account (see docs/DEPLOYMENT.md).
  backend "s3" {
    key     = "shopcore/terraform.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "shopcore"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Cross-region replica target for backups / DR.
provider "aws" {
  alias  = "dr"
  region = var.dr_region
}
