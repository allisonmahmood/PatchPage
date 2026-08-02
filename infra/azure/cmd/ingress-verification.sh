set -u
set +x
private_az() {
  az "$@" --subscription "$SUBSCRIPTION_ID" 2>/dev/null
}
if ! LIVE_INGRESS="$(
  private_az containerapp ingress show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CONTAINER_APP" \
    --output json
)"; then
  printf 'Could not read live Container App ingress.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$LIVE_INGRESS" |
  jq -e '
    type == "object" and
    .external == true and
    .allowInsecure == false and
    .targetPort == 3000 and
    (.transport | type == "string" and ascii_downcase == "auto") and
    (
      .clientCertificateMode == null or
      (
        .clientCertificateMode |
        type == "string" and
        (length == 0 or ascii_downcase == "ignore")
      )
    ) and
    .corsPolicy == null and
    (.exposedPort == null or .exposedPort == 0) and
    (
      .additionalPortMappings == null or
      (.additionalPortMappings | type == "array" and length == 0)
    ) and
    (
      .stickySessions == null or
      (
        .stickySessions |
        type == "object" and
        (.affinity | type == "string" and ascii_downcase == "none")
      )
    ) and
    (
      .ipSecurityRestrictions == null or
      (.ipSecurityRestrictions | type == "array" and length == 0)
    ) and
    (.traffic | type == "array" and length == 1) and
    (.traffic[0].label == null or .traffic[0].label == "") and
    .traffic[0].latestRevision == true and
    .traffic[0].weight == 100
  ' >/dev/null; then
  printf '%s\n' \
    'Live ingress drifted from the required HTTPS-only port, certificate, CORS, IP restriction, exposed-port, sticky-session, and latest-revision routing policy.' >&2
  exit 1
fi
