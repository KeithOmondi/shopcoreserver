# Staging mirrors production topology at production size during load-test windows
# (scale up before the 40k RPS certification run, scale down after).
environment                  = "staging"
region                       = "us-east-1"
dr_region                    = "us-west-2"
vpc_cidr                     = "10.41.0.0/16"
aurora_instance_class        = "db.r7g.4xlarge"
aurora_reader_instance_class = "db.r7g.2xlarge"
aurora_reader_count          = 2
redis_node_type              = "cache.r7g.xlarge"
redis_shards                 = 6
msk_instance_type            = "kafka.m7g.large"
enable_aurora_global         = false
