terraform {
  required_version = ">= 1.15.0, < 2.0.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.105.0"
    }
  }
}

# Read the finite token from the operator process, outside repositories and workspaces.
provider "digitalocean" {}

variable "operator_ssh_key_id" {
  type        = string
  description = "Existing operator SSH public key ID; never a private key."
}

variable "operator_sources" {
  type        = list(string)
  description = "Approved operator source CIDRs for SSH."
  validation {
    condition     = length(var.operator_sources) > 0 && alltrue([for cidr in var.operator_sources : can(cidrhost(cidr, 0))])
    error_message = "Provide the approved operator source CIDRs."
  }
}

resource "digitalocean_vpc" "recovery" {
  name        = "pocketcoder-pc103-ams3"
  region      = "ams3"
  ip_range    = "10.110.64.0/20"
  description = "PC-103 disposable recovery proof; production layout candidate"
}

resource "digitalocean_kubernetes_cluster" "recovery" {
  name                             = "pocketcoder-pc103-recovery"
  region                           = "ams3"
  version                          = "1.34.12-do.0"
  vpc_uuid                         = digitalocean_vpc.recovery.id
  ha                               = true
  auto_upgrade                     = false
  surge_upgrade                    = false
  registry_integration             = false
  kubeconfig_expire_seconds        = 1800
  destroy_all_associated_resources = false
  tags                             = ["pocketcoder-pc103-recovery"]

  node_pool {
    name       = "pc103-system"
    size       = "s-2vcpu-4gb"
    node_count = 2
    labels     = { "pocketcoder.dev/pool" = "system" }
  }
}

resource "digitalocean_kubernetes_node_pool" "workspaces" {
  cluster_id = digitalocean_kubernetes_cluster.recovery.id
  name       = "pc103-workspaces"
  size       = "s-4vcpu-8gb"
  auto_scale = false
  node_count = 1
  labels     = { "pocketcoder.dev/pool" = "workspaces" }

  taint {
    key    = "pocketcoder.dev/workspace"
    value  = "true"
    effect = "NoSchedule"
  }
}

resource "digitalocean_droplet" "operator" {
  name     = "pocketcoder-pc103-operator"
  region   = "ams3"
  size     = "s-2vcpu-4gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = digitalocean_vpc.recovery.id
  ssh_keys = [var.operator_ssh_key_id]
  tags     = ["pocketcoder-pc103-recovery"]
}

resource "digitalocean_firewall" "operator" {
  name        = "pocketcoder-pc103-operator"
  droplet_ids = [digitalocean_droplet.operator.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.operator_sources
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "443"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_volume" "manager" {
  name                     = "pocketcoder-pc103-manager"
  region                   = "ams3"
  size                     = 10
  initial_filesystem_type  = "ext4"
  initial_filesystem_label = "pc103-manager"
  tags                     = ["pocketcoder-pc103-recovery"]
}

resource "digitalocean_volume" "journal" {
  name                     = "pocketcoder-pc103-journal"
  region                   = "ams3"
  size                     = 1
  initial_filesystem_type  = "ext4"
  initial_filesystem_label = "pc103-journal"
  tags                     = ["pocketcoder-pc103-recovery"]
}

resource "digitalocean_volume_attachment" "manager" {
  droplet_id = digitalocean_droplet.operator.id
  volume_id  = digitalocean_volume.manager.id
}

resource "digitalocean_volume_attachment" "journal" {
  droplet_id = digitalocean_droplet.operator.id
  volume_id  = digitalocean_volume.journal.id
}

resource "digitalocean_project_resources" "recovery" {
  project = "126c5d77-926b-475b-8111-e30f3992a338"
  resources = [
    digitalocean_kubernetes_cluster.recovery.urn,
    digitalocean_droplet.operator.urn,
    digitalocean_volume.manager.urn,
    digitalocean_volume.journal.urn,
  ]
}

output "cluster_id" {
  value = digitalocean_kubernetes_cluster.recovery.id
}
