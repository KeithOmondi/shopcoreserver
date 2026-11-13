variable "environment" {
  type        = string
  description = "Environment name (staging, production)"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "dr_region" {
  type        = string
  default     = "us-west-2"
  description = "Region for cross-region backup copies and the Aurora Global Database secondary"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "azs" {
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
  description = "Three AZs: the capacity plan assumes the service survives the loss of any one"
}

variable "eks_version" {
  type    = string
  default = "1.31"
}

# ---- Data tier sizing (derivation in docs/CAPACITY.md) ----
variable "aurora_instance_class" {
  type    = string
  default = "db.r7g.4xlarge" # writer: 16 vCPU / 128 GiB
}

variable "aurora_reader_instance_class" {
  type    = string
  default = "db.r7g.2xlarge"
}

variable "aurora_reader_count" {
  type        = number
  default     = 2
  description = "Baseline readers; Aurora auto scaling adds up to aurora_reader_max on CPU"
}

variable "aurora_reader_max" {
  type    = number
  default = 6
}

variable "redis_node_type" {
  type    = string
  default = "cache.r7g.xlarge" # 4 vCPU: enhanced I/O threads offload networking
}

variable "redis_shards" {
  type        = number
  default     = 6
  description = "~80k ops/s at 40k RPS (rate-limit EVALSHA + cache GET per request); keeps each shard's single command thread < 50%"
}

variable "msk_instance_type" {
  type    = string
  default = "kafka.m7g.large"
}

variable "enable_aurora_global" {
  type        = bool
  default     = true
  description = "Aurora Global Database secondary in dr_region (RPO ~1s, RTO minutes)"
}

variable "waf_rate_limit_per_ip" {
  type        = number
  default     = 3000
  description = "Requests per 5-minute window per client IP before WAF blocks (edge-level abuse protection)"
}
