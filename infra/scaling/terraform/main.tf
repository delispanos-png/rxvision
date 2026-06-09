# RxVision app-tier auto-provisioning on Hetzner Cloud.
# Scale out = bump `node_count` in terraform.tfvars and `terraform apply`.
# App nodes run web+api+worker ONLY and connect to the SHARED MongoDB/Redis node.

terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.45" }
  }
}

variable "hcloud_token" { type = string, sensitive = true }
variable "node_count" { type = number, default = 1 }       # ← scale knob
variable "server_type" { type = string, default = "cpx21" } # 3 vCPU / 4 GB
variable "location" { type = string, default = "nbg1" }
variable "ssh_key_name" { type = string }                   # an existing key in your HCloud project
variable "data_private_ip" { type = string, default = "10.0.1.10" } # the DB node's private IP

provider "hcloud" { token = var.hcloud_token }

resource "hcloud_network" "net" {
  name     = "rxvision-net"
  ip_range = "10.0.0.0/16"
}
resource "hcloud_network_subnet" "sub" {
  network_id   = hcloud_network.net.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.0.1.0/24"
}

resource "hcloud_server" "app" {
  count       = var.node_count
  name        = "rxvision-app-${count.index + 1}"
  server_type = var.server_type
  location    = var.location
  image       = "ubuntu-22.04"
  ssh_keys    = [var.ssh_key_name]
  user_data   = templatefile("${path.module}/../bootstrap-node.sh", { data_ip = var.data_private_ip })
  labels      = { role = "app", app = "rxvision" }

  network {
    network_id = hcloud_network.net.id
    ip         = "10.0.1.${count.index + 20}"
  }
  depends_on = [hcloud_network_subnet.sub]
}

resource "hcloud_load_balancer" "lb" {
  name               = "rxvision-lb"
  load_balancer_type = "lb11"
  location           = var.location
}
resource "hcloud_load_balancer_network" "lbnet" {
  load_balancer_id = hcloud_load_balancer.lb.id
  network_id       = hcloud_network.net.id
}
resource "hcloud_load_balancer_target" "app" {
  count            = var.node_count
  type             = "server"
  load_balancer_id = hcloud_load_balancer.lb.id
  server_id        = hcloud_server.app[count.index].id
  use_private_ip   = true
  depends_on       = [hcloud_load_balancer_network.lbnet]
}
resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.lb.id
  protocol         = "https"
  listen_port      = 443
  destination_port = 443
  health_check {
    protocol = "http"
    port     = 8000
    interval = 15
    timeout  = 10
    retries  = 3
    http { path = "/health" }
  }
}

output "load_balancer_ip" { value = hcloud_load_balancer.lb.ipv4 }
output "app_nodes" { value = [for s in hcloud_server.app : s.ipv4_address] }
