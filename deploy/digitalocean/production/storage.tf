variable "operator_kubeconfig_file" {
  type        = string
  sensitive   = true
  description = "Finite kubeconfig for the existing named trial cluster, outside workspaces."
}

variable "backup_storage_config_file" {
  type        = string
  sensitive   = true
  description = "Private RustFS client configuration; no credentials belong in source."
}

variable "backup_storage_node" {
  type        = string
  description = "System worker that hosts the private storage endpoint for the recorded trial."
}

provider "kubernetes" {
  config_path    = var.operator_kubeconfig_file
  config_context = "do-ams3-pocketcoder-pc103-recovery"
}

locals {
  storage_config = jsondecode(file(var.backup_storage_config_file))
  storage_labels = { "app.kubernetes.io/name" = "pc103-backup-store" }
}

resource "kubernetes_namespace_v1" "backups" {
  metadata {
    name = "pc103-recovery"
    labels = {
      "pocketcoder.dev/trial"                      = "pc103"
      "pod-security.kubernetes.io/enforce"         = "restricted"
      "pod-security.kubernetes.io/enforce-version" = "latest"
    }
  }
}

resource "kubernetes_secret_v1" "backups" {
  metadata {
    name      = "pc103-backup-store"
    namespace = kubernetes_namespace_v1.backups.metadata[0].name
  }
  data = {
    RUSTFS_ACCESS_KEY = local.storage_config.accessKeyId
    RUSTFS_SECRET_KEY = local.storage_config.secretAccessKey
  }
}

resource "kubernetes_persistent_volume_claim_v1" "backups" {
  metadata {
    name      = "pc103-backup-store"
    namespace = kubernetes_namespace_v1.backups.metadata[0].name
    labels    = local.storage_labels
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "do-block-storage"
    resources {
      requests = { storage = "10Gi" }
    }
  }
  wait_until_bound = false
}

resource "kubernetes_deployment_v1" "backups" {
  depends_on = [kubernetes_network_policy_v1.backups]
  metadata {
    name      = "pc103-backup-store"
    namespace = kubernetes_namespace_v1.backups.metadata[0].name
    labels    = local.storage_labels
  }
  spec {
    replicas = 1
    strategy { type = "Recreate" }
    selector { match_labels = local.storage_labels }
    template {
      metadata { labels = local.storage_labels }
      spec {
        automount_service_account_token = false
        node_selector = {
          "pocketcoder.dev/pool"   = "system"
          "kubernetes.io/hostname" = var.backup_storage_node
        }
        security_context {
          run_as_non_root = true
          run_as_user     = 10001
          fs_group        = 10001
          seccomp_profile { type = "RuntimeDefault" }
        }
        container {
          name  = "rustfs"
          image = "rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff"
          args  = ["/data"]
          env_from {
            secret_ref { name = kubernetes_secret_v1.backups.metadata[0].name }
          }
          env {
            name  = "RUSTFS_CONSOLE_ENABLE"
            value = "false"
          }
          port { container_port = 9000 }
          resources {
            requests = { cpu = "200m", memory = "256Mi" }
            limits   = { cpu = "1", memory = "512Mi" }
          }
          security_context {
            run_as_non_root            = true
            allow_privilege_escalation = false
            capabilities { drop = ["ALL"] }
          }
          readiness_probe {
            http_get {
              path = "/health"
              port = 9000
            }
            initial_delay_seconds = 5
          }
          volume_mount {
            name       = "data"
            mount_path = "/data"
          }
        }
        volume {
          name = "data"
          persistent_volume_claim { claim_name = kubernetes_persistent_volume_claim_v1.backups.metadata[0].name }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "backups" {
  depends_on = [kubernetes_network_policy_v1.backups]
  metadata {
    name      = "pc103-backup-store"
    namespace = kubernetes_namespace_v1.backups.metadata[0].name
  }
  spec {
    type                    = "NodePort"
    external_traffic_policy = "Local"
    selector                = local.storage_labels
    port {
      port        = 9000
      target_port = 9000
      node_port   = 30900
    }
  }
}

resource "kubernetes_network_policy_v1" "backups" {
  metadata {
    name      = "pc103-private-backup-store"
    namespace = kubernetes_namespace_v1.backups.metadata[0].name
  }
  spec {
    pod_selector { match_labels = local.storage_labels }
    policy_types = ["Ingress"]
    ingress {
      ports {
        port     = "9000"
        protocol = "TCP"
      }
      from {
        ip_block { cidr = "${digitalocean_droplet.operator.ipv4_address_private}/32" }
      }
      from {
        namespace_selector {
          match_expressions {
            key      = "pocketcoder.dev/account"
            operator = "Exists"
          }
        }
        pod_selector { match_labels = { "pocketcoder.dev/role" = "controller" } }
      }
    }
  }
}

# Cilium checks the node port before translating this private route to a Pod.
resource "kubernetes_manifest" "controller_backups" {
  manifest = {
    apiVersion = "cilium.io/v2"
    kind       = "CiliumClusterwideNetworkPolicy"
    metadata   = { name = "pc103-controller-backups" }
    spec = {
      endpointSelector = {
        matchLabels = { "k8s:pocketcoder.dev/role" = "controller" }
        matchExpressions = [{
          key      = "k8s:io.cilium.k8s.namespace.labels.pocketcoder.dev/account"
          operator = "Exists"
        }]
      }
      egress = [{
        toEntities = ["host", "remote-node"]
        toPorts    = [{ ports = [{ port = "30900", protocol = "TCP" }] }]
        }, {
        toEndpoints = [{
          matchLabels = {
            "k8s:io.kubernetes.pod.namespace" = kubernetes_namespace_v1.backups.metadata[0].name
            "k8s:app.kubernetes.io/name"      = "pc103-backup-store"
          }
        }]
        toPorts = [{ ports = [{ port = "9000", protocol = "TCP" }] }]
      }]
    }
  }
}
