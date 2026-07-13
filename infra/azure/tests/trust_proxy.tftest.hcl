mock_provider "azurerm" {}

run "omits_trusted_proxy_by_default" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
  }

  assert {
    condition = length([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting if setting.name == "PATCHPAGE_TRUST_PROXY"
    ]) == 0
    error_message = "The safe default must leave PATCHPAGE_TRUST_PROXY unset."
  }
}

run "wires_trusted_proxy_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "2"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(setting.value == "2", false) : false
    ])
    error_message = "Configured trusted-proxy values must be wired into the Container App environment."
  }
}

run "wires_trusted_proxy_networks" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "192.0.2.10, 10.0.0.0/8, 2001:db8::1, 2001:db8:1234::/48"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(
        setting.value ==
        "192.0.2.10, 10.0.0.0/8, 2001:db8::1, 2001:db8:1234::/48",
        false
      ) : false
    ])
    error_message = "Configured trusted-proxy networks must be wired into the Container App environment."
  }
}

run "wires_partial_trusted_proxy_networks" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0.0.0.0/1, 192.0.2.0/24, ::1, ::/96, 2001:db8::/32"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(
        setting.value == "0.0.0.0/1, 192.0.2.0/24, ::1, ::/96, 2001:db8::/32",
        false
      ) : false
    ])
    error_message = "Partial trusted-proxy network sets must remain valid."
  }
}

run "wires_native_ipv6_partial_networks" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "8000::/1, 0:0:0:0:0:0:c000:200/120"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(
        setting.value == "8000::/1, 0:0:0:0:0:0:c000:200/120",
        false
      ) : false
    ])
    error_message = "Native partial IPv6 networks must remain valid."
  }
}

run "rejects_boolean_trust" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "true"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_blanket_trust" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "all"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_false_boolean_trust" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "false"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_wildcard_trust" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "*"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_blank_value" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = ""
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_whitespace_only_value" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "   "
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_zero_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_leading_zero_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "01"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_signed_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "+1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_negative_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "-1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_out_of_range_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "33"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_fractional_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "1.5"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_scientific_hop_count" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "1e2"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_empty_network_entry" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "10.0.0.0/8,"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_leading_empty_network_entry" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = ",127.0.0.1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_middle_empty_network_entry" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "127.0.0.1,,10.0.0.0/8"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_malformed_network" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "10.0.0.0/33"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_malformed_literal" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "not-an-ip"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv6_zone_identifier" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "fe80::1%eth0"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv6_out_of_range_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "2001:db8::/129"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_blanket_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0.0.0.0/0"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv6_blanket_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/0"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv4_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0.0.0.0/1,128.0.0.0/1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_reordered_ipv4_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "128.0.0.0/1,0.0.0.0/1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_alternate_ipv4_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0.0.0.0/2,64.0.0.0/2,128.0.0.0/1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_overlapping_ipv4_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0.0.0.0/2,64.0.0.0/2,128.0.0.0/2,192.0.0.0/2,192.0.2.0/24"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv6_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/1,8000::/1"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_alternate_ipv6_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "8000::/1,::/2,4000::/2"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_nested_ipv6_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/1,8000::/2,c000::/2"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_overlapping_ipv6_full_family_union" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/2,4000::/2,8000::/2,c000::/2,2001:db8::/32"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv4_mapped_ipv6_blanket_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::ffff:0:0/96"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_deprecated_transitional_ipv6_blanket_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::0.0.0.0/96"
  }

  expect_failures = [var.trust_proxy]
}

run "wires_compressed_native_ipv6_compatible_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/96"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(setting.value == "::/96", false) : false
    ])
    error_message = "Native ::/96 IPv6 networks must remain valid."
  }
}

run "wires_expanded_native_ipv6_compatible_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0:0:0:0:0:0:0:0/96"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(
        setting.value == "0:0:0:0:0:0:0:0/96",
        false
      ) : false
    ])
    error_message = "Expanded native ::/96 IPv6 networks must remain valid."
  }
}

run "rejects_specific_deprecated_transitional_ipv6_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::192.0.2.0/120"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_deprecated_transitional_ipv6_literal" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::192.0.2.10"
  }

  expect_failures = [var.trust_proxy]
}

run "wires_hex_native_ipv6_compatible_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0:0:0:0:0:0:c000:200/120"
  }

  assert {
    condition = anytrue([
      for setting in azurerm_container_app.server.template[0].container[0].env :
      setting.name == "PATCHPAGE_TRUST_PROXY" ? try(
        setting.value == "0:0:0:0:0:0:c000:200/120",
        false
      ) : false
    ])
    error_message = "Hex IPv4-compatible native IPv6 CIDRs must remain valid."
  }
}

run "rejects_ipv4_mapped_ipv6_literal" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::ffff:192.0.2.10"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv4_mapped_ipv6_blanket_supernet" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::fffe:0:0/95"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_noncanonical_ipv4_mapped_ipv6_blanket_supernet" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::ffff:0:0/95"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_specific_ipv4_mapped_ipv6_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::ffff:10.0.0.0/104"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_noncanonical_dotted_ipv4_tail_in_ipv6_literal" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "2001:db8::192.168.001.001"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_noncanonical_dotted_ipv4_tail_in_ipv6_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "2001:db8::192.168.001.001/120"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_expanded_ipv4_mapped_ipv6_cidr" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "0:0:0:0:0:ffff:a00:0/104"
  }

  expect_failures = [var.trust_proxy]
}

run "rejects_ipv6_supernet_covering_all_mapped_ipv4_peers" {
  command = plan

  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    public_base_url = "https://drafts.self-hoster.dev"
    trust_proxy     = "::/1"
  }

  expect_failures = [var.trust_proxy]
}
