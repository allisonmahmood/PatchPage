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

variable "trust_proxy" {
  description = "Optional trusted-proxy hop count or comma-separated IP/CIDR set. Null keeps forwarding headers untrusted."
  type        = string
  default     = null

  validation {
    condition = var.trust_proxy == null ? true : (
      can(regex("^[1-9][0-9]*$", trimspace(var.trust_proxy))) ? (
        tonumber(trimspace(var.trust_proxy)) <= 32
        ) : alltrue([
          for entry in split(",", var.trust_proxy) : (
            trimspace(entry) != "" &&
            (
              length(split("/", trimspace(entry))) == 1 ? (
                can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", trimspace(entry))) ?
                try(cidrhost("${trimspace(entry)}/32", 0), "") == trimspace(entry) :
                !strcontains(trimspace(entry), "%") &&
                strcontains(trimspace(entry), ":") &&
                (
                  !strcontains(trimspace(entry), ".") ||
                  can(regex(
                    ":(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$",
                    trimspace(entry)
                  ))
                ) &&
                can(cidrhost("${trimspace(entry)}/128", 0))
                ) : length(split("/", trimspace(entry))) == 2 ? (
                  can(regex(
                    "^[1-9][0-9]*$",
                    split("/", trimspace(entry))[1]
                    )) && (
                    can(regex(
                      "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$",
                      split("/", trimspace(entry))[0]
                      )) ?
                    try(
                      cidrhost("${split("/", trimspace(entry))[0]}/32", 0),
                      ""
                    ) == split("/", trimspace(entry))[0] &&
                    can(cidrhost(trimspace(entry), 0)) :
                    !strcontains(split("/", trimspace(entry))[0], "%") &&
                    strcontains(split("/", trimspace(entry))[0], ":") &&
                    (
                      !strcontains(split("/", trimspace(entry))[0], ".") ||
                      can(regex(
                        ":(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}$",
                        split("/", trimspace(entry))[0]
                      ))
                    ) &&
                    can(cidrhost(trimspace(entry), 0)) &&
                    !can(regex(
                      "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$",
                      try(cidrhost(
                        "${split("/", trimspace(entry))[0]}/128",
                        0
                      ), "")
                    )) &&
                    !can(regex(
                      "^::ffff:",
                      lower(try(cidrhost(trimspace(entry), 0), ""))
                    )) &&
                    !(
                      try(
                        tonumber(split("/", trimspace(entry))[1]),
                        129
                      ) <= 96 &&
                      try(cidrhost(trimspace(entry), 0), "") == try(cidrhost(
                        "::ffff:0:0/${split("/", trimspace(entry))[1]}",
                        0
                      ), "not-an-ipv6-network")
                    )
                  )
              ) : false
            )
          )
        ])
    )
    error_message = "trust_proxy must be null, a decimal hop count from 1 to 32, or comma-separated literal IP/CIDR entries; blank, boolean, wildcard, malformed, empty, /0, IPv4-mapped IPv6 CIDR, and noncanonical dotted-tail values are not allowed."
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
