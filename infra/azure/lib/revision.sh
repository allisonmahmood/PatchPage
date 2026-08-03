# Container App revision readiness: one definition of "the app is serving
# exactly the image we pinned, from exactly one revision".
#
# Sourced by cmd/*.sh through ops.sh, which exports PP_OPS_LIB; see ops.sh.
# Requires lib/wrappers.sh and lib/lease.sh.
#
# app-release, app-rollback and infrastructure-change all end by moving the
# Container App to a new revision and then proving it settled. Proving it is the
# hard half: `az containerapp update` returns before the revision is serving,
# and a revision can be created, become active, and still be sharing traffic
# with the revision it was supposed to replace. Three copies of this gate meant
# three chances for one of them to accept a half-rolled app.
#
# The gate is deliberately over-specified. It asserts single-revision mode, a
# succeeded provisioning state, that the latest and latest-ready revision are
# both the pinned one, that exactly one container named `server` carries exactly
# the expected digest, that the ingress traffic rule is the single implicit
# latest-revision rule at weight 100, and -- from the revision list, which is
# the only view that can see revisions the app object does not mention -- that
# the pinned revision is the only active one. Each of those has a failure mode
# where the app looks healthy and is serving the previous image.

# verify_pinned_revision_stable <revision-name> <expected-image>
verify_pinned_revision_stable() {
  stable_gate_pinned_revision="$1"
  stable_gate_expected_image="$2"
  test -n "$stable_gate_pinned_revision" ||
    return 1
  printf '%s\n' "$stable_gate_expected_image" |
    grep -Eq '^.+@sha256:[0-9a-f]{64}$' ||
    return 1
  if ! stable_gate_app_json="$(
    private_az containerapp show \
      --ids "$EXPECTED_CONTAINER_APP_ID" \
      --output json
  )" ||
    ! stable_gate_revision_json="$(
      private_az containerapp revision show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CONTAINER_APP" \
        --revision "$stable_gate_pinned_revision" \
        --output json
    )" ||
    ! stable_gate_revision_list_json="$(
      private_az containerapp revision list \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CONTAINER_APP" \
        --all \
        --output json
    )"; then
    return 1
  fi
  printf '%s\n' "$stable_gate_app_json" |
    jq -e \
      --arg pinned_revision "$stable_gate_pinned_revision" \
      --arg expected_image "$stable_gate_expected_image" \
      '.properties.configuration.activeRevisionsMode == "Single" and
       .properties.provisioningState == "Succeeded" and
       ($pinned_revision | length) > 0 and
       .properties.latestRevisionName == $pinned_revision and
       .properties.latestReadyRevisionName == $pinned_revision and
       (([.properties.template.containers[]? |
          select(.name == "server")]) as $servers |
        ($servers | length) == 1 and
        $servers[0].image == $expected_image) and
       (.properties.configuration.ingress.traffic as $traffic |
        ($traffic | type) == "array" and
        ($traffic | length) == 1 and
        (($traffic[0].revisionName // "") == "") and
        (($traffic[0].label // "") == "") and
        $traffic[0].latestRevision == true and
        $traffic[0].weight == 100)' >/dev/null &&
    printf '%s\n' "$stable_gate_revision_json" |
      jq -e \
        --arg pinned_revision "$stable_gate_pinned_revision" \
        --arg expected_image "$stable_gate_expected_image" \
        '.name == $pinned_revision and
         .properties.active == true and
         .properties.provisioningState == "Provisioned" and
         .properties.trafficWeight == 100 and
         (([.properties.template.containers[]? |
            select(.name == "server")]) as $servers |
          ($servers | length) == 1 and
          $servers[0].image == $expected_image)' >/dev/null &&
    printf '%s\n' "$stable_gate_revision_list_json" |
      jq -e \
        --arg pinned_revision "$stable_gate_pinned_revision" \
        '[.[]? | select(.properties.active == true) | .name] ==
         [$pinned_revision]' >/dev/null
}

# poll_pinned_revision_stable <revision-name> <expected-image>
#
# Re-proves the operation lease before every attempt. Waiting for a rollout is
# the longest anything here holds the lease, and a lease that was broken out
# from under this process is exactly the case where continuing to wait -- and
# then reporting success -- would be worst.
poll_pinned_revision_stable() {
  stable_poll_pinned_revision="$1"
  stable_poll_expected_image="$2"
  stable_poll_attempt=1
  while test "$stable_poll_attempt" -le 120; do
    if ! verify_operation_lease; then
      return 1
    fi
    if verify_pinned_revision_stable \
      "$stable_poll_pinned_revision" \
      "$stable_poll_expected_image"; then
      return 0
    fi
    if test "$stable_poll_attempt" -eq 120; then
      return 1
    fi
    sleep 5
    stable_poll_attempt=$((stable_poll_attempt + 1))
  done
  return 1
}

# The app did not settle. The mutation already happened, so the lease is kept
# on purpose and the process exits 75: a second operator has to look before
# anything else runs here.
container_app_readiness_recovery_required() {
  OPERATION_LEASE_ACTIVE=false
  printf 'Container App readiness failed; second-operator recovery is required.\n' >&2
  printf 'The operation lease remains held for second-operator recovery.\n' >&2
  exit 75
}
