variable "retained_source_cloud_init_file" {
  type        = string
  sensitive   = true
  default     = null
  description = "Original private startup file for a fenced source retained during writer migration."
}

# Move the original operator state here once, before planning its replacement.
# This keeps the source available for the immutable handoff's provider fence checks.
resource "digitalocean_droplet" "operator_source" {
  count     = var.retained_source_cloud_init_file == null ? 0 : 1
  name      = "pocketcoder-pc103-operator-source"
  region    = "ams3"
  size      = "s-2vcpu-4gb"
  image     = "ubuntu-24-04-x64"
  vpc_uuid  = digitalocean_vpc.recovery.id
  ssh_keys  = [var.operator_ssh_key_id]
  user_data = file(var.retained_source_cloud_init_file)
  tags      = ["pocketcoder-pc103-recovery"]
  lifecycle {
    prevent_destroy = true
  }
}
