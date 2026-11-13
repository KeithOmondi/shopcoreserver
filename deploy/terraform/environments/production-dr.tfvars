# Regional failover target: the same stack, built in the DR region. The Aurora cluster here is
# the promoted Global Database secondary (import it with `terraform import` after failover).
environment          = "production"
region               = "us-west-2"
dr_region            = "us-east-1"
azs                  = ["us-west-2a", "us-west-2b", "us-west-2c"]
vpc_cidr             = "10.42.0.0/16"
redis_node_type      = "cache.r7g.xlarge"
redis_shards         = 6
enable_aurora_global = false
