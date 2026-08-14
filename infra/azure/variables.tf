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
    # create a validation cycle.
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
    # arithmetic and expansion of OpenTofu's compressed cidrhost output.
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
  description = "Fully qualified immutable PatchPage server image digest reference. The default placeholder is accepted only by targeted bootstrap plans that exclude the Container App."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart:latest"
}

variable "storage_replication_type" {
  description = "Azure Storage account replication type. Defaults to locally redundant: drafts are cheap to re-publish and expire on a 90-day clock, so geo-redundancy is a premium this service does not buy. A self-hoster with different durability needs can still pick any of the listed types."
  type        = string
  default     = "LRS"
  nullable    = false

  validation {
    condition     = contains(["LRS", "ZRS", "GRS", "RAGRS", "GZRS", "RAGZRS"], var.storage_replication_type)
    error_message = "storage_replication_type must be one of LRS, ZRS, GRS, RAGRS, GZRS, or RAGZRS."
  }
}

variable "storage_delete_retention_days" {
  description = "Number of days deleted blobs and containers remain recoverable."
  type        = number
  default     = 30
  nullable    = false

  validation {
    condition = (
      var.storage_delete_retention_days >= 1 &&
      var.storage_delete_retention_days <= 365 &&
      floor(var.storage_delete_retention_days) == var.storage_delete_retention_days
    )
    error_message = "storage_delete_retention_days must be an integer from 1 through 365."
  }
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

variable "postgres_backup_retention_days" {
  description = "Number of days PostgreSQL backups remain available for point-in-time restore."
  type        = number
  default     = 35
  nullable    = false

  validation {
    condition = (
      var.postgres_backup_retention_days >= 7 &&
      var.postgres_backup_retention_days <= 35 &&
      floor(var.postgres_backup_retention_days) == var.postgres_backup_retention_days
    )
    error_message = "postgres_backup_retention_days must be an integer from 7 through 35."
  }
}

variable "max_html_bytes" {
  description = "Maximum accepted HTML artifact size."
  type        = number
  default     = 524288
}

variable "allow_anonymous_uploads" {
  description = "Allow callers without an Authorization header to create new unlisted drafts."
  type        = bool
  default     = false
  nullable    = false
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
  description = "Anonymous-create attempts allowed per canonical client IP per minute."
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

# --- cost posture: circuit breaker, kill switch, and alarms ------------------
#
# Every number the cost posture turns on is a variable so a self-hoster can size
# the guardrails to their own bill, but the defaults are the public instance's
# ratified posture and changing them is a decision, not a tuning exercise.

variable "monthly_circuit_breaker_amount" {
  description = "Monthly spend, in the billing account's currency, at which the circuit breaker fires the kill switch and the instance goes dark."
  type        = number
  default     = 200
  nullable    = false

  validation {
    condition     = var.monthly_circuit_breaker_amount > 0
    error_message = "monthly_circuit_breaker_amount must be greater than zero."
  }
}

variable "monthly_cost_target_amount" {
  description = "Monthly spend the service is aiming to stay under. Advisory only: crossing it notifies the operator and never takes the service down."
  type        = number
  default     = 100
  nullable    = false

  validation {
    condition     = var.monthly_cost_target_amount > 0
    error_message = "monthly_cost_target_amount must be greater than zero."
  }

  validation {
    # A target at or above the breaker would collapse the advisory notice and
    # the outage into one event, which defeats having a target at all.
    condition     = var.monthly_cost_target_amount < var.monthly_circuit_breaker_amount
    error_message = "monthly_cost_target_amount must be below monthly_circuit_breaker_amount so the advisory notice arrives before the circuit breaker fires."
  }
}

variable "budget_start_date" {
  description = "First day of the month the consumption budget starts tracking, as RFC 3339 UTC. Azure rejects a start date that is not the first of a month, and rejects one too far in the past when the budget is first created, so set this to the month you apply in."
  type        = string
  default     = "2026-08-01T00:00:00Z"
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{4}-(?:0[1-9]|1[0-2])-01T00:00:00Z$", var.budget_start_date))
    error_message = "budget_start_date must be the first day of a month at midnight UTC, formatted as YYYY-MM-01T00:00:00Z."
  }
}

variable "egress_tripwire_bytes_per_day" {
  description = "Container App TxBytes over a rolling day, in bytes, above which the egress tripwire fires the kill switch. The default is 100 GiB."
  type        = number
  default     = 107374182400
  nullable    = false

  validation {
    condition = (
      var.egress_tripwire_bytes_per_day >= 1073741824 &&
      floor(var.egress_tripwire_bytes_per_day) == var.egress_tripwire_bytes_per_day
    )
    error_message = "egress_tripwire_bytes_per_day must be a whole number of bytes and at least 1 GiB; a tripwire below that would fire on ordinary traffic."
  }
}

variable "blob_capacity_alarm_bytes" {
  description = "Total blob storage, in bytes, above which the operator is notified. The default is 50 GiB. Notification only: this alarm never fires the kill switch."
  type        = number
  default     = 53687091200
  nullable    = false

  validation {
    condition = (
      var.blob_capacity_alarm_bytes >= 1073741824 &&
      floor(var.blob_capacity_alarm_bytes) == var.blob_capacity_alarm_bytes
    )
    error_message = "blob_capacity_alarm_bytes must be a whole number of bytes and at least 1 GiB."
  }
}

variable "kill_switch_webhook_expiry" {
  description = "Expiry of the Automation webhook the action group calls to fire the kill switch, as RFC 3339 UTC. Azure caps webhook lifetime at ten years. Past this date the alerts still fire and the runbook still exists, but nothing invokes it, so rotating this before it lapses is a standing operator chore."
  type        = string
  default     = "2036-01-01T00:00:00Z"
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z$", var.kill_switch_webhook_expiry))
    error_message = "kill_switch_webhook_expiry must be an RFC 3339 UTC timestamp, formatted as YYYY-MM-DDTHH:MM:SSZ."
  }
}

variable "operator_alert_email" {
  description = "Address notified when the kill switch fires and when advisory thresholds are crossed. Null leaves both action groups without an email receiver; the kill switch still fires, and alerts are still visible in Azure Monitor."
  type        = string
  default     = null

  validation {
    condition     = var.operator_alert_email == null ? true : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.operator_alert_email))
    error_message = "operator_alert_email must be null or a single email address."
  }
}

variable "kill_switch_az_accounts_version" {
  description = "Az.Accounts version imported into the kill switch Automation account. Connect-AzAccount and Invoke-AzRestMethod both come from this module, so the runbook cannot run without it. Pinned rather than left to the account's defaults so a missing module fails at apply instead of during an incident; bump it deliberately when the pinned version ages out of support."
  type        = string
  default     = "5.5.2"
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.kill_switch_az_accounts_version))
    error_message = "kill_switch_az_accounts_version must be an exact three-part version, as published on the PowerShell Gallery."
  }
}
