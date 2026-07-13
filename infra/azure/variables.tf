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
                can(cidrhost("${trimspace(entry)}/128", 0)) &&
                !can(regex(
                  "^::(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$",
                  trimspace(entry)
                )) &&
                !can(regex(
                  "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$",
                  try(cidrhost("${trimspace(entry)}/128", 0), "")
                ))
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
                    "^::(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$",
                    split("/", trimspace(entry))[0]
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
    error_message = "trust_proxy must be null, a decimal hop count from 1 to 32, or comma-separated literal IP/CIDR entries; blank, boolean, wildcard, malformed, empty, /0, deprecated transitional or IPv4-mapped IPv6 aliases, and noncanonical dotted-tail values are not allowed."
  }

  validation {
    # Keep the range calculation inline: locals derived from var.trust_proxy
    # create a validation cycle on Terraform 1.9.
    condition = var.trust_proxy == null ? true : (
      can(regex("^[1-9][0-9]*$", trimspace(var.trust_proxy))) ? true : alltrue([
        for range_keys in [sort([
          for range in [
            for candidate in [
              for entry in [
                for raw_entry in split(",", var.trust_proxy) : trimspace(raw_entry)
                ] : {
                cidr = length(split("/", entry)) == 1 ? "${entry}/32" : entry
                prefix = length(split("/", entry)) == 1 ? 32 : try(
                  tonumber(split("/", entry)[1]),
                  33
                )
              }
              if(
                length(split("/", entry)) <= 2 &&
                can(regex(
                  "^[0-9]{1,3}(\\.[0-9]{1,3}){3}(?:/[1-9][0-9]*)?$",
                  entry
                )) &&
                try(cidrhost(length(split("/", entry)) == 1 ? "${entry}/32" : entry, 0), "") != "" &&
                try(
                  tonumber(length(split("/", entry)) == 1 ? "32" : split("/", entry)[1]),
                  33
                ) <= 32
              )
              ] : {
              prefix = candidate.prefix
              start = sum([
                for index, octet in split(".", cidrhost(candidate.cidr, 0)) :
                tonumber(octet) * pow(256, 3 - index)
              ])
            }
            ] : format(
            "%010d:%010d",
            range.start,
            range.start + pow(2, 32 - range.prefix) - 1
          )
          ])] : (
          length(range_keys) == 0 ? true : (
            tonumber(split(":", range_keys[0])[0]) != 0 ? true : (
              max([
                for key in range_keys : tonumber(split(":", key)[1])
                ]...) != 4294967295 ? true : !alltrue([
                for index, key in range_keys : index == 0 ? true : (
                  tonumber(split(":", key)[0]) <= max([
                    for previous_key in slice(range_keys, 0, index) :
                    tonumber(split(":", previous_key)[1])
                  ]...) + 1
                )
              ])
            )
          )
        )
      ])
    )
    error_message = "trust_proxy CIDR entries must not cover an entire address family."
  }

  validation {
    # Keep this separate from the IPv4 union check: IPv6 needs 128-bit
    # arithmetic and expansion of Terraform's compressed cidrhost output.
    condition = var.trust_proxy == null ? true : (
      can(regex("^[1-9][0-9]*$", trimspace(var.trust_proxy))) ? true : alltrue([
        for range_keys in [sort([
          for range in [
            for candidate in [
              for entry in [
                for raw_entry in split(",", var.trust_proxy) : trimspace(raw_entry)
                ] : {
                cidr = length(split("/", entry)) == 1 ? "${entry}/128" : entry
                prefix = length(split("/", entry)) == 1 ? 128 : try(
                  tonumber(split("/", entry)[1]),
                  129
                )
                network = try(
                  cidrhost(length(split("/", entry)) == 1 ? "${entry}/128" : entry, 0),
                  ""
                )
              }
              if(
                length(split("/", entry)) <= 2 &&
                strcontains(split("/", entry)[0], ":") &&
                !strcontains(split("/", entry)[0], "%") &&
                try(
                  tonumber(length(split("/", entry)) == 1 ? "128" : split("/", entry)[1]),
                  129
                ) <= 128 &&
                can(cidrhost(length(split("/", entry)) == 1 ? "${entry}/128" : entry, 0)) &&
                strcontains(
                  try(cidrhost(length(split("/", entry)) == 1 ? "${entry}/128" : entry, 0), ""),
                  ":"
                )
              )
              ] : {
              prefix = candidate.prefix
              start = sum([
                for index, segment in concat(
                  split("::", candidate.network)[0] == "" ? [] : split(
                    ":",
                    split("::", candidate.network)[0]
                  ),
                  length(split("::", candidate.network)) == 2 ? [
                    for zero_index in range(
                      8 -
                      (split("::", candidate.network)[0] == "" ? 0 : length(split(
                        ":",
                        split("::", candidate.network)[0]
                      ))) -
                      (split("::", candidate.network)[1] == "" ? 0 : length(split(
                        ":",
                        split("::", candidate.network)[1]
                      )))
                    ) : "0"
                  ] : [],
                  length(split("::", candidate.network)) == 2 ? (
                    split("::", candidate.network)[1] == "" ? [] : split(
                      ":",
                      split("::", candidate.network)[1]
                    )
                  ) : []
                ) :
                parseint(segment, 16) * pow(65536, 7 - index)
              ])
            }
            ] : format(
            "%039.0f:%039.0f",
            range.start,
            range.start + pow(2, 128 - range.prefix) - 1
          )
          ])] : (
          length(range_keys) == 0 ? true : (
            tonumber(split(":", range_keys[0])[0]) != 0 ? true : (
              max([
                for key in range_keys : tonumber(split(":", key)[1])
                ]...) != pow(2, 128) - 1 ? true : !alltrue([
                for index, key in range_keys : index == 0 ? true : (
                  tonumber(split(":", key)[0]) <= max([
                    for previous_key in slice(range_keys, 0, index) :
                    tonumber(split(":", previous_key)[1])
                  ]...) + 1
                )
              ])
            )
          )
        )
      ])
    )
    error_message = "trust_proxy CIDR entries must not cover an entire address family."
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

variable "protected_api_rate_limit_per_minute" {
  description = "Protected API attempts allowed per canonical client IP per minute."
  type        = number
  default     = 60
  nullable    = false

  validation {
    condition = (
      var.protected_api_rate_limit_per_minute >= 1 &&
      var.protected_api_rate_limit_per_minute <= 10000 &&
      floor(var.protected_api_rate_limit_per_minute) == var.protected_api_rate_limit_per_minute
    )
    error_message = "protected_api_rate_limit_per_minute must be an integer from 1 through 10000."
  }
}

variable "authenticated_upload_rate_limit_per_minute" {
  description = "Authenticated upload attempts allowed per API token identity per minute."
  type        = number
  default     = 20
  nullable    = false

  validation {
    condition = (
      var.authenticated_upload_rate_limit_per_minute >= 1 &&
      var.authenticated_upload_rate_limit_per_minute <= 10000 &&
      floor(var.authenticated_upload_rate_limit_per_minute) == var.authenticated_upload_rate_limit_per_minute
    )
    error_message = "authenticated_upload_rate_limit_per_minute must be an integer from 1 through 10000."
  }
}

variable "anonymous_create_rate_limit_per_minute" {
  description = "Future anonymous-create attempts allowed per canonical client IP per minute."
  type        = number
  default     = 5
  nullable    = false

  validation {
    condition = (
      var.anonymous_create_rate_limit_per_minute >= 1 &&
      var.anonymous_create_rate_limit_per_minute <= 10000 &&
      floor(var.anonymous_create_rate_limit_per_minute) == var.anonymous_create_rate_limit_per_minute
    )
    error_message = "anonymous_create_rate_limit_per_minute must be an integer from 1 through 10000."
  }
}
