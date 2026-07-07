variable "subscription_id" {
  description = "Azure subscription id for this deployment. Keep real values in ignored terraform.tfvars."
  type        = string
}

variable "location" {
  description = "Azure region for the PatchPage stack. Central US is the current recommendation because Azure PostgreSQL is available there for this subscription."
  type        = string
  default     = "centralus"
}

variable "environment_name" {
  description = "Environment slug used in resource names."
  type        = string
  default     = "prod"
}

variable "public_base_url" {
  description = "Public PatchPage base URL returned by upload responses."
  type        = string
  default     = "https://post.patchyhq.com"
}

variable "server_image" {
  description = "Fully qualified PatchPage server image reference. Use the quickstart placeholder until ACR has a real image."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart:latest"
}

variable "postgres_admin_login" {
  description = "Postgres administrator username."
  type        = string
  default     = "patchadmin"
}

variable "postgres_database_name" {
  description = "PatchPage metadata database name."
  type        = string
  default     = "patchpage"
}

variable "postgres_sku_name" {
  description = "Azure PostgreSQL Flexible Server SKU."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "Azure PostgreSQL storage size in MB."
  type        = number
  default     = 32768
}

variable "max_html_bytes" {
  description = "Maximum accepted HTML artifact size."
  type        = number
  default     = 524288
}
