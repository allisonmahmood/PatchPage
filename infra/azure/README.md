# PatchPage Azure self-hosting

This directory is a reusable Azure Container Apps deployment example. It requires an HTTPS public origin on a DNS hostname the deployer owns; it has no default or fallback to the PatchPage maintainer's hosted service.

OpenTofu creates:

- the resource group, Log Analytics workspace, Container Apps environment, and Container App;
- external platform ingress with insecure HTTP disabled;
- the Azure Container Registry and the app's managed identity and role assignments;
- the Blob Storage account and private container, plus the PostgreSQL server/database; and
- generated application secrets and the Container App environment variables, including `PATCHPAGE_PUBLIC_BASE_URL`, `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`, the rate-limit settings, and, when configured, `PATCHPAGE_TRUST_PROXY`.

OpenTofu does **not** create or manage the remote-state resources, container image build, DNS zone or records, Container App custom hostname, managed certificate, or certificate binding. Those steps are deliberately manual and provider-neutral below. OpenTofu creates the initial Container App ingress and image, then ignores later changes to the whole ingress block and the image leaf. These exceptions prevent an infrastructure apply from overwriting the CLI-managed hostname, certificate binding, or release image. Resource postconditions and the live check below fail closed if any ignored security or routing invariant drifts. Any intentional ingress change therefore remains HITL: update the lifecycle rule and restore the manual binding as one coordinated operation.

The PostgreSQL server/database and Blob Storage account/container are persistent data, not release artifacts. Never delete the workload resource group, run `tofu destroy`, or replace a persistent resource to deploy, roll back, repair state, or repair DNS. Routine releases update only the Container App image by immutable registry digest.

## Prerequisites

- OpenTofu 1.9 or newer — `brew install opentofu`, or see [the OpenTofu install guide](https://opentofu.org/docs/intro/install/). CI verifies this directory against 1.12.5, so that is the version to match if you want the same result the tests prove.
- Azure CLI, authenticated to the deployer's own Azure account with `az login`.
- Git for the image tag.
- `dig`, `curl`, `jq`, and `openssl` for the verification commands and workload-binding digest.
- Control of a public DNS hostname. A subdomain with a direct CNAME is recommended.

Do not run this example against a maintainer subscription. Set `SUBSCRIPTION_ID` privately to the exact target subscription. Every mutation block selects it and compares the active account without printing subscription, tenant, or caller details.

### Coming from Terraform

This directory used Terraform 1.9.8 until PatchPage moved to OpenTofu. There is no state migration step. The state format is compatible and the backend is unchanged, so an existing environment picks up the new binary on its next infrastructure change: the flow runs `tofu init` against the same `azurerm` backend and the same state key, and continues from the state already there. Nothing needs to be exported, re-imported, or re-applied first.

Provider addresses resolve through the OpenTofu registry, so the first `tofu init` rewrites `registry.terraform.io/...` to `registry.opentofu.org/...` in `.terraform.lock.hcl` and replaces the recorded hashes. Provider versions are preserved. The checked-in lock file in this repository is already in that form.

Moving back to Terraform remains possible and the state itself reads back unchanged, but the `init` does not reverse symmetrically: the checked-in lock file records `registry.opentofu.org` addresses, so `terraform init -lockfile=readonly` stops with a provider-dependency-change error and the move needs a plain `terraform init` that regenerates the lock against `registry.terraform.io`. That regeneration re-resolves the `~>` constraints rather than reusing the recorded versions, so provider versions float unless they are pinned exactly first — moving back today takes `azurerm` from 4.80.0 to 4.81.0. Either direction stays available only until this directory adopts an OpenTofu-only feature — state encryption being the obvious one — which it deliberately has not.

## State bootstrap

Create remote OpenTofu state once. Set `STATE_STORAGE_ACCOUNT` to a globally unique name containing 3-24 lowercase letters and digits and `STATE_KEY` to a unique environment-specific `*.tfstate` object name before running the block. Privately set `OPERATION_PRINCIPAL_ID` to the Microsoft Entra object ID that will run release/rollback operations and `OPERATION_PRINCIPAL_TYPE` to `User` or `ServicePrincipal`. Group principals are deliberately unsupported because Azure's transitive assigned-to inventory does not accept a group object ID. Never place those private values in this guide or a tracked shell file. Never reuse a state key across environments.
This guarded bootstrap intentionally supports one PatchPage workload per Azure subscription: its fixed state resource group and single operation container are bound to one state key/workload tuple. Do not reuse them for a second environment. Use a separate subscription, or design and review separately named state and operation resources before adding another workload.

The bootstrap creates exactly two private containers in the state account: `tfstate` for backend data and an empty, initially unbound `patchpage-operations` container used only for the operation lease. The initial deployment seals that empty operation container to one state/workload tuple before release use; an existing environment does the same during its first safety-guard adoption. Before granting access, the bootstrap inventories every direct, inherited, and group-derived role assignment effective at the exact `tfstate` container and rejects any assignment, including otherwise benign roles, so the operation identity cannot read state or obtain account keys. It separately creates or verifies one direct `Storage Blob Data Contributor` grant at the exact operation container. Other roles scoped only to that sibling container cannot reach `tfstate`. The state account itself receives the `CanNotDelete` management lock; the surrounding fixed resource group does not.

A normal run leaves `RESUME_STATE_BOOTSTRAP=false`. If this exact block failed after creating part of the dedicated state resource group, set it to `true`; the block accepts only the exact state account and a subset of those two intended containers, rejects foreign resources plus any unexpected active or recoverable container and any used or recoverable state key, then continues idempotently. It inventories immediately after resource-group creation and again immediately before the storage-account lock, so a concurrent foreign resource causes a fail-closed stop without locking that resource. Never use resume to adopt an unrelated state account. Do not commit the generated backend config. The bootstrap deliberately uses storage-account-key authorization for initial container provisioning because an Azure account with management-plane access does not automatically have Blob data-plane OAuth access. Azure CLI retrieves the key without writing it to the backend config; do not enable shell tracing or CLI debug output for this block.


Every runbook in this guide is a command of the Azure operations CLI at `infra/azure/ops.sh`, and `sh infra/azure/ops.sh --help` lists all of them with the exit-code contract. A command exits `0` on success; `1` when the step failed safely and is safe to retry after you fix the reported problem, because nothing is still held; and `75` when it **stopped and a second authorized operator has to act**. On `75` stop: do not retry and do not rerun any flow. Usually the operation lease is deliberately retained, so do not break it either — a mutation may still be in flight, and that second operator must first prove the original process is gone and then run [the stale-lease recovery](#recover-an-abandoned-operation-lease). The initial deployment also exits `75` when an apply may have half landed, where nothing is leased but the same stop-and-escalate rule applies.

Export the inputs this command requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | the target Azure subscription ID |
| `STATE_STORAGE_ACCOUNT` | a globally unique lowercase Storage account name |
| `STATE_KEY` | a unique environment-specific `.tfstate` object name |
| `OPERATION_PRINCIPAL_ID` | the private operation-principal object ID |
| `OPERATION_PRINCIPAL_TYPE` | `User` or `ServicePrincipal` |
| `RESUME_STATE_BOOTSTRAP` | optional; `true` only to resume a partial bootstrap |

```sh
sh infra/azure/ops.sh state-bootstrap
```

## Deploy the Azure resources

Copy the example and edit both required values before the first OpenTofu command:

```sh
AZURE_DIR="$(git rev-parse --show-toplevel)/infra/azure"
cd "$AZURE_DIR"
cp terraform.tfvars.example terraform.tfvars
```

- Set `subscription_id` to the target subscription ID and export the same value as `SUBSCRIPTION_ID` in the shell.
- Replace the deliberately invalid `public_base_url` with the deployer's real origin. It must be HTTPS with a public DNS hostname and no credentials, port, path, query, fragment, or trailing slash.
- Keep `trust_proxy = null` for the initial deployment. This omits `PATCHPAGE_TRUST_PROXY` so forwarded client-address headers remain untrusted. Enable it only after completing [the client-IP HITL verification](#4-verify-and-enable-client-ip-attribution).
- Keep `max_html_bytes = 524288` unless you intentionally change the maximum accepted HTML artifact size.
- Keep `allow_anonymous_uploads = false` unless this self-hosted deployment intentionally accepts create-only requests without credentials. OpenTofu converts the boolean to `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`; changing it does not enable anonymous uploads on any maintainer-hosted environment.
- Keep the rate-limit defaults unless the deployment needs a different local safety envelope: `protected_api_rate_limit_per_minute = 60`, `authenticated_upload_rate_limit_per_minute = 20`, and `anonymous_create_rate_limit_per_minute = 5`. Each value must be an integer from `1` through `10000`; OpenTofu wires them to the matching `PATCHPAGE_*_RATE_LIMIT_PER_MINUTE` Container App environment variables.

OpenTofu rejects the maintainer's domains, localhost/private-style names, reserved example names, common placeholder values, unsafe trusted-proxy values, and any Container App image that is not an immutable lowercase SHA-256 digest reference. The checked-in quickstart default exists only so the targeted registry bootstrap can run before the deployment image exists; every plan that includes the Container App must override it with the generated immutable image value. A normal first run leaves `RESUME_INITIAL_DEPLOY=false` and requires both empty state and an absent workload resource group. If this exact block failed during its targeted registry apply, set `RESUME_INITIAL_DEPLOY=true`: the block accepts only the registry target's data, random suffix, resource-group, and registry addresses; proves every already-managed live resource before mutation; reruns that fixed target; and then resumes through the same no-delete saved-plan gate. It rejects any broader or completed deployment state; use the existing-environment flow instead.
Before running the block, export the exact `STATE_STORAGE_ACCOUNT` and environment-specific `STATE_KEY` recorded by bootstrap, and set `TERRAFORM_DIAGNOSTIC_ROOT` to an existing private directory outside the repository. The block writes provider output to a randomized mode-0600 log below that root. After the saved final apply, it privately reads the exact workload resource IDs from OpenTofu, seals the empty operation container to the state/workload tuple with key authorization, and creates or verifies `CanNotDelete` only on the workload Storage account and PostgreSQL server. It rejects every foreign or inherited lock and never locks the workload resource group. On any failure or abort it preserves the log and prints only a generic reminder; inspect the configured root only in the private operator shell. A successful final apply plus safeguard verification removes the diagnostic directory.


Export the inputs this command requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | the `subscription_id` in `terraform.tfvars` |
| `STATE_STORAGE_ACCOUNT` | from the private state-bootstrap record |
| `STATE_KEY` | from the private state-bootstrap record |
| `TERRAFORM_DIAGNOSTIC_ROOT` | an existing private diagnostic directory outside the repository |
| `RESUME_INITIAL_DEPLOY` | optional; `true` only to resume a failed registry-target apply |

```sh
sh infra/azure/ops.sh deploy-resources
```
If the final saved-plan apply reports a partial deployment the command exits `75`, and `RESUME_INITIAL_DEPLOY` is intentionally not a recovery mechanism: it accepts only registry-target state. Freeze mutations, preserve the remote state and private provider diagnostics, and have a second operator reconcile every state address to its exact live Azure resource ID before reviewing a new no-delete completion plan. Do not remove, forget, import over, or replace a persistent resource to make a plan pass.


At this point Azure's generated Container App hostname is live over HTTPS, but the deployer-owned hostname and certificate are not configured yet.

## Normal app-only releases and rollback

Complete the custom-domain, managed-certificate, deployed-smoke, and private-canary steps below before using this routine release flow. OpenTofu ignores the Container App image leaf in addition to its existing CLI-owned ingress exception. A routine release therefore uses `az containerapp update` and never initializes, plans, or applies OpenTofu. Run it with a release identity that can build in the expected ACR, update the expected Container App, and use the dedicated operation-lease container, but cannot remove management locks, delete the resource group, read OpenTofu state, or administer PostgreSQL or workload Blob data.

Set the following values privately from the same verified deployment and state records before a release: `SUBSCRIPTION_ID`, `STATE_STORAGE_ACCOUNT`, `STATE_CONTAINER`, `STATE_KEY`, `RESOURCE_GROUP`, `CONTAINER_APP`, `ACR`, `EXPECTED_STORAGE_ACCOUNT_ID`, `EXPECTED_POSTGRES_SERVER_ID`, `LOGIN_SERVER`, `CONTAINER_APP_FQDN`, `PUBLIC_BASE_URL`, `CANARY_URL`, and `CANARY_MARKER`. `STATE_CONTAINER` must be the bootstrap-recorded `tfstate` container; the operation container name is fixed as `patchpage-operations`. Set `ROLLBACK_RECORD` to a durable private path outside the repository. The canary must predate the release. Release and rollback need management read only on the exact operation container, Container App, registry, and the two private lock IDs; they do not read the parent state Storage account.

The release, rollback, and infrastructure blocks share a documented Azure Storage container lease on the dedicated empty `patchpage-operations` container. Its sole immutable metadata value is the SHA-256 digest of a versioned tuple containing the subscription, state account and key, workload resource group, Container App, ACR, operation-container ID, and exact workload IDs. Every workflow recomputes and exactly verifies that binding before lease acquisition; a state record mixed with another environment therefore cannot serialize or mutate this workload. Each process proposes a cryptographically random GUID, acquires an infinite lease, and proves ownership by renewing with that exact ID before mutations. Release and exit cleanup also use only that exact ID. Missing or non-empty operation storage, foreign metadata, a held or unexpected lease state, and acquire, renew, or release failures all stop the workflow with generic public output. Authorization is deliberately separate: release, rollback, and stale recovery use Microsoft Entra login as the least-privileged operation principal, while initial deployment, first adoption, and later infrastructure verification use state-account-key authorization. The bootstrap grants `Storage Blob Data Contributor` to the private release/rollback operation principal at this container's exact resource scope only; that role must never be granted on `tfstate`, the state account, the workload account, or either resource group.

Container Apps can expose a new template and `latestRevisionName` before that revision is ready. In Single revision mode, the old revision can continue receiving all traffic while the new revision provisions. The workflows therefore pin the exact stable revision before mutation, require the update-returned or post-apply-observed revision to match Azure's `latestReadyRevisionName`, become the sole active provisioned 100%-traffic revision, and contain the exact immutable image. They do not require a warm replica because the service intentionally permits scale to zero; release and rollback immediately prove wake-up and serving behavior through the native/public health and canary requests. The same exact revision pin is rechecked before releasing the operation lease, so a later revision never satisfies an earlier operation's gate. If a mutation's result or post-mutation readiness cannot be proved, the workflow deliberately leaves the infinite lease held and emits a generic recovery-required error; use only the documented second-operator stale-lease recovery after independently proving the original process is gone.


Export the inputs this command requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | from the private verified deployment record |
| `STATE_STORAGE_ACCOUNT` | from the private verified state record |
| `STATE_CONTAINER` | from the private verified state record |
| `STATE_KEY` | from the private verified state record |
| `RESOURCE_GROUP` | from the private verified deployment record |
| `CONTAINER_APP` | from the private verified deployment record |
| `ACR` | from the private verified deployment record |
| `EXPECTED_STORAGE_ACCOUNT_ID` | from the private verified deployment record |
| `EXPECTED_POSTGRES_SERVER_ID` | from the private verified deployment record |
| `LOGIN_SERVER` | from the private verified deployment record |
| `CONTAINER_APP_FQDN` | from the private verified deployment record |
| `PUBLIC_BASE_URL` | from the private verified deployment record |
| `CANARY_URL` | from the private canary record |
| `CANARY_MARKER` | from the private canary record |
| `ROLLBACK_RECORD` | a durable private path outside the repository |

```sh
sh infra/azure/ops.sh app-release
```

This command exits `75` if it cannot prove the result of its Container App mutation or the readiness that follows it: the infinite lease stays held on purpose and only the documented second-operator recovery may clear it.

Keep `ROLLBACK_RECORD` until the release is verified. The record contains exactly the immutable pre-release `ROLLBACK_IMAGE_REF` and the immutable new `RELEASE_IMAGE_REF`. Set its private absolute path again, keep the verified deployment variables in the shell, and run this complete block. It disables tracing before reading the record, validates both exact lines without sourcing them as shell code, repeats the subscription, lock, and registry checks, acquires the shared operation mutex, and refuses rollback unless the current image still equals `RELEASE_IMAGE_REF`:


Export the inputs this command requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | from the private verified deployment record |
| `STATE_STORAGE_ACCOUNT` | from the private verified state record |
| `STATE_CONTAINER` | from the private verified state record |
| `STATE_KEY` | from the private verified state record |
| `RESOURCE_GROUP` | from the private verified deployment record |
| `CONTAINER_APP` | from the private verified deployment record |
| `ACR` | from the private verified deployment record |
| `EXPECTED_STORAGE_ACCOUNT_ID` | from the private verified deployment record |
| `EXPECTED_POSTGRES_SERVER_ID` | from the private verified deployment record |
| `LOGIN_SERVER` | from the private verified deployment record |
| `CONTAINER_APP_FQDN` | from the private verified deployment record |
| `PUBLIC_BASE_URL` | from the private verified deployment record |
| `CANARY_URL` | from the private canary record |
| `CANARY_MARKER` | from the private canary record |
| `ROLLBACK_RECORD` | the durable private release record written by `app-release` |

```sh
sh infra/azure/ops.sh app-rollback
```

This command exits `75` if it cannot prove the result of its Container App mutation or the readiness that follows it: the infinite lease stays held on purpose and only the documented second-operator recovery may clear it.

The rollback block completes the deployed-image, native/public health, and pre-existing canary checks while it still owns the exact operation lease, then re-reads the final image before releasing that lease. Keep using the separate ignored-ingress invariant procedure after intentional ingress changes. Never roll back by running OpenTofu, selecting a mutable tag, deleting infrastructure, changing DNS, or pointing the public hostname at another environment.

## Existing-environment infrastructure changes

An image release is not an infrastructure change. PostgreSQL, Blob Storage, identities, networking, state, backup, locks, DNS, and certificates require a separate reviewed maintenance window. Before planning, privately set the expected subscription, backend key, state lineage, resource-group ID, Storage account ID, PostgreSQL server ID, registry ID, and Container App ID. The infrastructure operator must already be authorized to retrieve the state-account key for backend/state verification; this block uses that same key authorization to recompute and verify the operation-container workload binding and use the shared lease. Stop on any mismatch; never repair state by deleting the live resource.

Deployments created before these safety guards exist can use this same flow without replacing state or infrastructure. Set `ADOPT_SAFETY_GUARDS=true` only for that first reviewed run. For that adoption run only, privately set `OPERATION_PRINCIPAL_ID` and `OPERATION_PRINCIPAL_TYPE` for the least-privileged identity that will run release and rollback operations; it does not have to be the infrastructure caller. Before any adoption mutation, the block proves the existing state lineage and every exact live resource ID and rejects foreign locks. It creates a missing private operation container with its workload-binding metadata atomically, or seals an existing empty container only when it has no metadata; it never overwrites foreign metadata or container data. It grants only exact-container Blob access, raises state retention without shortening any longer live setting, creates only the two exact persistent-resource locks plus the separate state-account lock, and imports the two OpenTofu-managed workload locks at their deterministic IDs before planning. A partially completed adoption can be rerun: already imported exact lock addresses are verified rather than re-imported. It also resolves a legacy image tag to a separately verified registry digest, updates only the exact Container App under the shared lease, and atomically writes `server-image.auto.tfvars` as mode `0600` so OpenTofu agrees before planning.
Before running this flow, set `TERRAFORM_DIAGNOSTIC_ROOT` to an existing private directory outside the repository. Provider output remains in a randomized mode-0600 log below that root for the duration of each run. Failure or abort preserves it and emits only a generic reminder; a successful saved-plan apply removes it, as does the plan-and-report run that stops at the review gate below.

Required base state addresses before the first safety-guard adoption:

```txt
azurerm_resource_group.patchpage
azurerm_storage_account.drafts
azurerm_storage_container.drafts
azurerm_postgresql_flexible_server.patchpage
azurerm_container_registry.patchpage
azurerm_postgresql_flexible_server_database.patchpage
azurerm_container_app.server
```
After adoption, and for every normal infrastructure run, state must also contain `azurerm_management_lock.drafts_storage` and `azurerm_management_lock.patchpage_postgres` at the exact live lock IDs. The block imports them only in explicit adoption mode and otherwise fails if either binding is absent or mismatched.



### Plan, review, apply

This is the flow to use. It is three commands: `infrastructure-plan` produces and saves the plan a second operator reviews, `infrastructure-apply` applies that exact saved plan, and `infrastructure-abandon` closes the session without applying anything.

The three share a **session**: a mode-`0700` directory named `patchpage-infrastructure-session` under the private root you set as `INFRA_CHANGE_SESSION_ROOT`. It holds the saved plan, that plan's SHA-256, the rendered action inventory, the pinned Container App revision and image, and the operation lease ID. `infrastructure-apply` re-derives every one of those rather than trusting it. Set the root to an existing private directory outside the repository; a saved plan describes the whole environment, and one written inside the repository is one `git add -A` away from being published.

Between the plan and the apply, **the operation lease stays held**. That is the point of the session and it is the one documented exception to `sh infra/azure/ops.sh --help`'s "exit `0` released everything it held": the reviewed plan describes an environment that nothing else may change while the review is happening, so releases, rollbacks and other infrastructure changes are locked out until the session closes. Close it with `infrastructure-apply` or `infrastructure-abandon`. Never break the lease to clear a session — if you believe the planning process is gone, that is the same stop-and-prove situation as any other retained lease, and [the stale-lease recovery](#recover-an-abandoned-operation-lease) is the only way through it.

Export the inputs `infrastructure-plan` requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | the private expected subscription ID |
| `STATE_STORAGE_ACCOUNT` | the private state account name |
| `STATE_CONTAINER` | the private state container name |
| `STATE_KEY` | the private environment-specific state key |
| `EXPECTED_STATE_LINEAGE` | the private expected state lineage |
| `EXPECTED_RESOURCE_GROUP_ID` | the private workload resource-group ID |
| `EXPECTED_STORAGE_ACCOUNT_ID` | the private workload Storage account ID |
| `EXPECTED_POSTGRES_SERVER_ID` | the private PostgreSQL server ID |
| `EXPECTED_ACR_ID` | the private Azure Container Registry ID |
| `EXPECTED_CONTAINER_APP_ID` | the private Container App ID |
| `RESOURCE_GROUP` | the expected workload resource-group name |
| `OPERATION_PRINCIPAL_ID` | the private operation-principal object ID |
| `OPERATION_PRINCIPAL_TYPE` | `User` or `ServicePrincipal` |
| `EXPECTED_LEGACY_IMAGE_DIGEST` | from a separately verified legacy release record; required only for a legacy adoption |
| `TERRAFORM_DIAGNOSTIC_ROOT` | an existing private diagnostic directory outside the repository |
| `INFRA_CHANGE_SESSION_ROOT` | an existing private session directory outside the repository |
| `ADOPT_SAFETY_GUARDS` | optional; `true` only to adopt an existing environment's safety guards |

```sh
sh infra/azure/ops.sh infrastructure-plan
```

It prints the exact address/action inventory, then the review token — the SHA-256 digest of exactly that inventory — then a line stating that the lease is held. It applies nothing. If a session is already open it refuses without touching it; abandon the open one first.

Require a second operator to compare the private environment record, the backup/restore evidence, and that exact address/action inventory. Then apply, with the token they approved and the same `INFRA_CHANGE_SESSION_ROOT`:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | the private expected subscription ID |
| `STATE_STORAGE_ACCOUNT` | the private state account name |
| `STATE_CONTAINER` | the private state container name |
| `STATE_KEY` | the private environment-specific state key |
| `EXPECTED_STATE_LINEAGE` | the private expected state lineage |
| `EXPECTED_RESOURCE_GROUP_ID` | the private workload resource-group ID |
| `EXPECTED_STORAGE_ACCOUNT_ID` | the private workload Storage account ID |
| `EXPECTED_POSTGRES_SERVER_ID` | the private PostgreSQL server ID |
| `EXPECTED_ACR_ID` | the private Azure Container Registry ID |
| `EXPECTED_CONTAINER_APP_ID` | the private Container App ID |
| `RESOURCE_GROUP` | the expected workload resource-group name |
| `TERRAFORM_DIAGNOSTIC_ROOT` | an existing private diagnostic directory outside the repository |
| `INFRA_CHANGE_SESSION_ROOT` | the same private session directory the plan used |
| `INFRA_CHANGE_APPROVAL_SHA256` | the review token the plan printed and a second operator approved |

```sh
INFRA_CHANGE_APPROVAL_SHA256=<the token the plan printed> sh infra/azure/ops.sh infrastructure-apply
```

`infrastructure-apply` refuses unless all three of these hold, and it checks them in this order:

- the saved plan file still hashes to the digest recorded at review time, so a plan that was edited or regenerated is refused rather than applied;
- the approval matches the token recomputed from the inventory the session recorded, so the token proves a second operator read *these* actions;
- the recorded operation lease renews, which only the container this session leased will accept — so a lease that was broken and reacquired between the review and now stops the apply instead of letting it land on an environment somebody else has been changing.

The first two need nothing but the session, and are deliberately checked before this command touches the lease at all: a mistyped token costs nothing and leaves the session exactly as the plan left it, still reviewable and still holding the environment. Only after they pass does it renew the lease, recheck the pinned revision, apply the exact saved plan, prove readiness, release the lease and remove the session.

`ADOPT_SAFETY_GUARDS` is not accepted here. Adoption creates locks, seals the operation container and migrates a legacy image; none of that is described by a plan that has already been reviewed, so it belongs to `infrastructure-plan` and this command refuses the flag rather than ignoring it.

To close a session without applying — a review that says no, or an apply that was refused — abandon it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | the private expected subscription ID |
| `STATE_STORAGE_ACCOUNT` | the private state account name |
| `INFRA_CHANGE_SESSION_ROOT` | the same private session directory the plan used |

```sh
sh infra/azure/ops.sh infrastructure-abandon
```

It renews the recorded lease as proof that the session and the live lease are the same lease, releases it, and removes the session. It loads no OpenTofu, reads no state and runs no plan gate, because a session has to stay closable when the thing it was planning against is what is broken. A session whose lease a second operator has already recovered is not an error: there is nothing to release, so it clears the record and exits `0`. A lease it holds but cannot release is the retained case, and it exits `75` with the session left intact.

### The one-shot alternative

`infrastructure-change` does the plan and the apply in one command, run twice. For one operator at one terminal with a second operator available to review between the two runs, it is the shorter path, and it takes the same inputs as `infrastructure-plan` minus `INFRA_CHANGE_SESSION_ROOT`, plus:

| Variable | Value |
| --- | --- |
| `INFRA_CHANGE_APPROVAL_SHA256` | optional; the review token a first run printed, set only on the approved rerun |

```sh
sh infra/azure/ops.sh infrastructure-change
```

The first run does not apply anything. It plans, prints the exact address/action inventory, prints the review token, releases the operation lease, and stops at the review gate with exit `0`. After the review, rerun it with the approved token:

```sh
INFRA_CHANGE_APPROVAL_SHA256=<the token the first run printed> sh infra/azure/ops.sh infrastructure-change
```

Understand what this carries between the two runs and what it does not. The rerun **replans against current state** and recomputes the token from the new inventory, so it can only apply actions equal to the ones that were approved: if the state drifted so the plan changed in between, the recorded token no longer matches and the command stops with exit `1` and a fresh token to review. What it cannot carry forward is the plan itself, or the environment — it gives the lease back at the review gate, so a release, a rollback or another infrastructure change can land in the window, and the plan the rerun applies is a new plan that merely renders the same inventory. Where either of those matters, use `infrastructure-plan` and `infrastructure-apply`. Never carry a token over from a different environment or an earlier plan.

Both flows exit `75` if the apply, or the readiness proof that follows it, cannot be proved: the infinite lease stays held on purpose and only the documented second-operator recovery may clear it.

### Recover an abandoned operation lease

An infinite lease survives `SIGKILL`, terminal loss, and operator-machine loss. Never break it merely because a command failed: the original process may still be mutating Azure. If the owner-specific exit trap could not release it, stop release, rollback, and infrastructure work. A second authorized operator must independently verify that the first process is gone, compare the live image and private operation record, and explicitly accept responsibility for recovery. Only that second operator runs the block below with the same private state and workload inputs used by release. It proves the exact operation-container management ID and recomputed immutable workload binding with Microsoft Entra login, without reading the parent state account, before it breaks the abandoned lease. It then proves recovery by acquiring, renewing, and releasing a new cryptographically random GUID lease. Any container-identity/binding mismatch, missing/non-empty container, or break, acquire, renew, or release failure remains fail-closed.


Export the inputs this command requires, then run it:

| Variable | Value |
| --- | --- |
| `SUBSCRIPTION_ID` | from the private verified deployment record |
| `STATE_STORAGE_ACCOUNT` | from the private verified state record |
| `STATE_CONTAINER` | from the private verified state record |
| `STATE_KEY` | from the private verified state record |
| `RESOURCE_GROUP` | from the private verified deployment record |
| `CONTAINER_APP` | from the private verified deployment record |
| `ACR` | from the private verified deployment record |
| `EXPECTED_STORAGE_ACCOUNT_ID` | from the private verified deployment record |
| `EXPECTED_POSTGRES_SERVER_ID` | from the private verified deployment record |
| `CONFIRM_STALE_OPERATION_LEASE` | `second-operator-confirmed-no-active-operation`, set only after independent second-operator verification |

```sh
sh infra/azure/ops.sh stale-lease-recovery
```


Source-local retention is not an independent backup. Before accepting durable production data or changing a persistent resource, configure independently protected Blob and PostgreSQL backups outside the workload resource group, document the accepted RPO/RTO, and complete an isolated end-to-end restore. Re-run that drill at least every 90 days. Geo-replication improves regional availability but replicates deletion; management locks protect control-plane deletion but not Blob data-plane deletion.

Workload Storage defaults to geo-redundant replication (`GRS`). Existing environments that still use `LRS` will plan an in-place Storage account update on the first infrastructure apply after that default change; review cost and replication behavior before approving. PostgreSQL flexible-server backups remain platform-local by default (`geo_redundant_backup_enabled` is unset); regional database recovery therefore depends on the independent backup drill above rather than Storage GRS symmetry.

PostgreSQL backup retention defaults to 35 days (`postgres_backup_retention_days`). Existing environments left on the platform default (about 7 days) will plan an in-place flexible-server update on the first infrastructure apply after that default change; review the added backup storage cost before approving.

## Configure the custom domain and managed certificate

The commands below follow [Microsoft's managed-certificate flow](https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates). They read Azure resource names and DNS values from OpenTofu so there are no copied resource-name placeholders.

Load the outputs and make sure the Azure CLI is using the same subscription:


This command takes no inputs: it reads every value from OpenTofu, so run it from a shell where `tofu output` works for this deployment. It is the one command whose result is the variables it leaves behind — `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `CONTAINER_APP`, `CONTAINER_APP_ENVIRONMENT`, `CONTAINER_APP_FQDN`, `CONTAINER_APP_STATIC_IP`, `DOMAIN_VERIFICATION_ID`, `PUBLIC_BASE_URL` and the normalized `CUSTOM_DOMAIN` — which every later custom-domain command reads. Source it into the shell you will run the rest of this section in:

```sh
. infra/azure/cmd/custom-domain-context.sh
```

`sh infra/azure/ops.sh custom-domain-context` runs the same checks as a standalone verification, but a child process cannot hand its variables back, so the later commands would not see them.

### Verify the OpenTofu-ignored ingress invariants

Every OpenTofu plan and apply checks these invariants through resource postconditions. Because OpenTofu deliberately preserves the CLI-managed custom-domain state by ignoring the complete ingress block, also read the live Azure ingress before DNS or certificate work and after every intentional ingress change.


Run this in the shell that sourced the context above; it reads `SUBSCRIPTION_ID`, `RESOURCE_GROUP` and `CONTAINER_APP` from there.

```sh
sh infra/azure/ops.sh ingress-verification
```

### 1. Create and verify DNS records

Use the DNS provider that is authoritative for the deployer's domain. Do not proxy the record while Azure issues or renews the managed certificate.

For a subdomain, create these records:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | the relative subdomain label | `$CONTAINER_APP_FQDN` |
| TXT | `asuid.` plus the relative subdomain label | `$DOMAIN_VERIFICATION_ID` |

The CNAME must point directly to the generated Container App FQDN, without an intermediate CNAME or proxy. Set the real zone and relative label in the shell, then verify public DNS propagation:

```sh
set +x
private_dig() {
  dig "$@" 2>/dev/null
}
DNS_ZONE="${DNS_ZONE:?Set DNS_ZONE to the DNS zone you control}"
DNS_SUBDOMAIN="${DNS_SUBDOMAIN:?Set DNS_SUBDOMAIN to the relative hostname label}"
DNS_ZONE="$(printf '%s\n' "$DNS_ZONE" | sed 's/\.$//' | tr '[:upper:]' '[:lower:]')"
DNS_SUBDOMAIN="$(printf '%s\n' "$DNS_SUBDOMAIN" | sed 's/^\.*//;s/\.*$//' | tr '[:upper:]' '[:lower:]')"

if test "$CUSTOM_DOMAIN" != "$DNS_SUBDOMAIN.$DNS_ZONE"; then
  printf 'DNS_ZONE and DNS_SUBDOMAIN do not compose the configured hostname.\n' >&2
  exit 1
fi

ACTUAL_CNAME="$(
  private_dig +short CNAME "$CUSTOM_DOMAIN" |
    sed -n '1{s/\.$//;p;}' |
    tr '[:upper:]' '[:lower:]'
)"
if test "$ACTUAL_CNAME" != "$CONTAINER_APP_FQDN"; then
  printf 'The CNAME has not propagated to the expected target.\n' >&2
  exit 1
fi

ACTUAL_VERIFICATION_ID="$(private_dig +short TXT "asuid.$CUSTOM_DOMAIN" | tr -d '"')"
if ! printf '%s\n' "$ACTUAL_VERIFICATION_ID" | grep -Fqx -- "$DOMAIN_VERIFICATION_ID"; then
  printf 'The asuid TXT record has not propagated with the expected value.\n' >&2
  exit 1
fi

VALIDATION_METHOD="CNAME"
```

For an apex domain instead, create these records:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `$CONTAINER_APP_STATIC_IP` |
| TXT | `asuid` | `$DOMAIN_VERIFICATION_ID` |

Set the real apex zone in the shell and verify propagation:


Run this in the shell that sourced the context above; it reads `CUSTOM_DOMAIN`, `CONTAINER_APP_STATIC_IP` and `DOMAIN_VERIFICATION_ID` from there. Export the one value the context cannot know first:

| Variable | Value |
| --- | --- |
| `DNS_ZONE` | the apex DNS zone you control |

```sh
sh infra/azure/ops.sh apex-dns
```

Certificate authorities apply the first CAA RRset found while walking from the custom hostname toward the DNS root. At each original tree label, CAA lookup follows and normalizes its CNAME chain first; if that alias-aware lookup is empty, the walk resumes at the original label's parent, as required by RFC 8659. Ambiguous targets, loops, excessive alias depth, command errors, missing status, and every DNS status other than `NOERROR` fail closed. That effective policy, wherever it is inherited from, must allow DigiCert with an unparameterized `issue "digicert.com"` record. Parameterized DigiCert records fail this check because the guide cannot prove that Azure satisfies issuer-specific constraints. Any issuer-critical property outside the standard `issue`, `issuewild`, and `iodef` tags also fails closed because the guide cannot prove DigiCert supports it:


Run this in the shell that sourced the context above; it reads `CUSTOM_DOMAIN` from there and needs nothing else.

```sh
sh infra/azure/ops.sh caa-policy
```

The direct CNAME/A record, public ingress, and DigiCert CAA permission must remain in place for certificate renewal.

### 2. Add the hostname, create the managed certificate, and bind it

`hostname add` registers the validated custom hostname. The subsequent `hostname bind` command finds or creates Azure's free managed certificate, waits for issuance, and binds it to the hostname. For a subdomain, `VALIDATION_METHOD` is `CNAME`; for an apex domain it is `HTTP`.


Run this in the shell that sourced the context above; it reads `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `CONTAINER_APP`, `CONTAINER_APP_ENVIRONMENT` and `CUSTOM_DOMAIN` from there, and `VALIDATION_METHOD` from whichever DNS section above you completed. Like the context command it hands a value forward — `MANAGED_CERTIFICATE_ID`, which the certificate binding below requires — so source it into the same shell:

```sh
. infra/azure/cmd/hostname-mutation.sh
```

Certificate issuance can take several minutes. The bind command captured the exact managed-certificate resource ID selected by Azure. After issuance, confirm that this exact resource succeeded for the normalized hostname and that the SNI binding still points to the same ID:


Run this in the shell that sourced the context and the hostname mutation above; it reads `SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `CONTAINER_APP`, `CONTAINER_APP_ENVIRONMENT` and `CUSTOM_DOMAIN` from there. The one value it names as its own required input is the certificate ID the hostname mutation handed forward:

| Variable | Value |
| --- | --- |
| `MANAGED_CERTIFICATE_ID` | the managed-certificate resource ID `. infra/azure/cmd/hostname-mutation.sh` left in the shell |

```sh
sh infra/azure/ops.sh certificate-binding
```

### 3. Verify HTTPS and the configured upload origin

Set `CANARY_RECORD` to a private path outside the repository if this first successful smoke should become the durable pre-release canary. The block writes the URL and marker there with mode `0600`; it never prints either value.
OpenTofu disables insecure ingress. Verify the exact HTTPS redirect, health response, authenticated upload response, configured draft origin, and fetched draft content as one fail-closed smoke. This uses the sensitive bootstrap token from OpenTofu state; do not enable shell tracing or paste its value into logs.


Run this in the shell that sourced the context above; it reads `PUBLIC_BASE_URL` and `CUSTOM_DOMAIN` from there and reads the bootstrap token straight from OpenTofu, so `tofu output` must work for this deployment.

| Variable | Value |
| --- | --- |
| `CANARY_RECORD` | optional; a private absolute path outside the repository to record the canary in |

```sh
sh infra/azure/ops.sh deployed-smoke
```

Repository tests execute these guide blocks against failure-injection stubs, but they do not contact Azure or public DNS. DNS, certificate, HTTPS, and upload acceptance against the deployer's real subscription and zone remains intentionally human-in-the-loop.

### 4. Verify and enable client IP attribution

OpenTofu cannot determine Azure Container Apps' forwarding chain or prove which peer addresses reach this application. The `trust_proxy` default is therefore `null`: the Container App receives no `PATCHPAGE_TRUST_PROXY` variable, Fastify ignores `X-Forwarded-For`, and persisted upload `source_ip` values identify the direct socket peer. Do not replace this default with a guessed Azure hop count or network.

Complete this verification in the real deployment:

1. Inventory every reachable path to the Container App: the generated `*.azurecontainerapps.io` hostname, the custom hostname, and any CDN, WAF, gateway, or additional reverse proxy. A fixed hop count is valid only if every path that remains reachable has the same depth.
2. With `trust_proxy = null`, send controlled authenticated uploads from an independently known public client address through each path. The resulting `draft_versions.source_ip` shows the socket peer seen by PatchPage. PatchPage deliberately does not persist the raw `X-Forwarded-For` chain, so inspect that header at the application boundary with an approved temporary diagnostic revision or equivalent ingress observability. Remove temporary header logging after the observation and do not log API tokens.
3. Record the socket peer, the right-to-left forwarded chain, whether each proxy overwrites or appends incoming forwarding headers, and whether the observed path is invariant. Repeat enough requests and revisions to detect changing peer addresses.
4. Choose either a decimal count from `1` through `32` for a proven fixed-depth path, or comma-separated literal IP/CIDR entries for stable, verified proxy source networks. OpenTofu rejects deprecated `::` plus dotted-IPv4 transitional aliases, IPv4-mapped IPv6 aliases, and CIDR lists whose effective union covers an entire address family. Do not use broad address ranges merely because they include the observed peer.
5. Set the observed value in `terraform.tfvars`, review the environment change, and apply it:

   ```hcl
   # Example form only; use the value established by the observation above.
   trust_proxy = "2"
   ```

   Apply this as an existing-environment infrastructure change through the saved-plan and no-delete gate above. Do not run an ad hoc `tofu apply`.

6. From the same known client, perform a new authenticated upload through every reachable path while supplying a canary header such as `X-Forwarded-For: 198.51.100.123`. Query the matching upload and confirm that both persisted fields equal the independently known client address and never the spoof canary:

   ```sql
   SELECT
     draft_versions.source_ip AS version_source_ip,
     upload_events.source_ip AS event_source_ip
   FROM draft_versions
   JOIN upload_events
     ON upload_events.draft_version_id = draft_versions.id
   WHERE draft_versions.draft_id = 'replace-with-the-canary-draft-id'
   ORDER BY upload_events.created_at DESC
   LIMIT 1;
   ```

7. If any path attributes the spoof value, a proxy peer, or a different header position, restore `trust_proxy = null` and correct the topology or trust rule before using the address for audit.

This verification remains an operator responsibility after deploy. Repeat it whenever Azure ingress behavior, DNS paths, custom domains, CDN/WAF layers, proxy source ranges, or Container App networking changes. Repository and OpenTofu tests validate parsing and environment wiring only; they do not establish the hosted trust boundary.

## Intentional retirement

There is no routine teardown command for a durable PatchPage environment. Retiring only the app while retaining PostgreSQL and Blob data is a separate operation and must not touch the persistent resources.

A full data retirement requires:

1. Freeze writes and name the exact private subscription, backend key, state lineage, environment, and resource IDs.
2. Verify current independent Blob and PostgreSQL recovery points outside the target scope and complete an isolated end-to-end restore.
3. Export and approve the exact address inventory from the verified state. `prevent_destroy` is expected to block a destroy plan at this point.
4. In a separate reviewed change, intentionally remove the relevant `prevent_destroy` rules.
5. Generate a saved destroy plan, extract its delete-address manifest, and require an exact match with the pre-approved inventory and scope.
6. Remove only the two out-of-band exact-resource locks (`protect-patchpage-drafts` and `protect-patchpage-postgres`) just in time with a separately authorized identity.
7. Apply only the approved saved plan. Never manually delete the PostgreSQL database first and never delete the resource group first.
8. Verify the state account and state history, independent backups, DNS zone, nameservers, and certificates that are outside the retirement scope still exist.

Never use retirement to repair state, DNS, certificates, image rollout, or environment naming. Never improvise deletion in the portal or CLI.

## Security notes

- Do not commit `terraform.tfvars`, `backend.hcl`, `.terraform/`, saved plans, state snapshots, private canary/rollback records, or generated deployment notes.
- OpenTofu state and saved plans contain generated secrets. Keep state in the private protected account, create plans only in mode-0700 temporary directories, and never upload either as CI or public artifacts.
- The Blob container is private; public draft viewing goes through the PatchPage server.
- The server uses managed identity for Blob access in production.
- Uploads require API tokens by default. Anonymous creation remains disabled unless this deployment explicitly sets `allow_anonymous_uploads = true`.
- Keep `trust_proxy = null` until the live forwarding chain has passed the HITL verification above; an incorrect trust rule permits spoofed audit attribution.
- Never paste subscription or tenant IDs, caller details, Activity Log claims, state lineage, resource IDs, domain-verification values, certificate rows, unlisted draft URLs, tokens, connection strings, storage keys, or backup evidence into public issues, PRs, logs, or chat.
- Management locks and `prevent_destroy` reduce accidental control-plane deletion; they are not authorization boundaries and do not replace independently tested backups.
