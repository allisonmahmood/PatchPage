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
  description = "Deployer-owned public HTTPS origin returned by upload responses. Use only scheme and DNS hostname, with no trailing slash."
  type        = string
  nullable    = false

  validation {
    condition = (
      length(var.public_base_url) <= 261 &&
      can(regex(
        "^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$",
        var.public_base_url
      ))
    )
    error_message = "public_base_url must be a deployer-owned HTTPS origin with no credentials, port, path, query, fragment, or trailing slash."
  }

  validation {
    condition = (
      !can(regex(
        "^https://(?:[a-z0-9-]+\\.)*(?:patchyhq\\.com|example\\.(?:com|net|org)|example|invalid|localhost|local|test|internal|lan|home|home\\.arpa|corp)$",
        lower(var.public_base_url)
      )) &&
      !can(regex(
        "(?:^https://|\\.)(?:placeholder|replace|replace-me|replace-with-your-domain|your-domain|yourdomain|domain-you-control)(?:\\.|$)",
        lower(var.public_base_url)
      ))
    )
    error_message = "public_base_url must not use a PatchPage maintainer domain, a reserved hostname, or a placeholder value."
  }
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
