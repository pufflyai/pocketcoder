terraform {
  required_version = ">= 1.15.0, < 2.0.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.105.0"
    }
  }
}

# The provider reads DIGITALOCEAN_TOKEN from the operator process.
provider "digitalocean" {}

resource "digitalocean_vpc" "pilot" {
  name        = "pocketcoder-pc84-ams3"
  region      = "ams3"
  ip_range    = "10.110.48.0/20"
  description = "PC-84 owned synthetic fixture"
}

resource "digitalocean_kubernetes_cluster" "pilot" {
  name                             = "pocketcoder-pc84-synthetic"
  region                           = "ams3"
  version                          = "1.34.12-do.0"
  vpc_uuid                         = digitalocean_vpc.pilot.id
  ha                               = false
  auto_upgrade                     = false
  surge_upgrade                    = false
  registry_integration             = false
  kubeconfig_expire_seconds        = 1800
  destroy_all_associated_resources = false
  tags                             = ["pocketcoder-pc84-synthetic"]

  node_pool {
    name       = "pc84-system"
    size       = "s-4vcpu-8gb"
    node_count = 1
    labels     = { "pocketcoder.dev/pool" = "system" }
  }
}

resource "digitalocean_kubernetes_node_pool" "workspaces" {
  cluster_id = digitalocean_kubernetes_cluster.pilot.id
  name       = "pc84-workspaces"
  size       = "s-4vcpu-8gb"
  auto_scale = true
  min_nodes  = 0
  max_nodes  = 1
  labels     = { "pocketcoder.dev/pool" = "workspaces" }

  taint {
    key    = "pocketcoder.dev/workspace"
    value  = "true"
    effect = "NoSchedule"
  }
}

resource "digitalocean_project_resources" "pilot" {
  project   = "126c5d77-926b-475b-8111-e30f3992a338"
  resources = [digitalocean_kubernetes_cluster.pilot.urn]
}

output "cluster_id" {
  value = digitalocean_kubernetes_cluster.pilot.id
}
