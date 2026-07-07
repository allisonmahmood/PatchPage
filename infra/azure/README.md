# PatchPage Azure Infrastructure

PatchPage's hosted deployment runs on Azure, but the application remains a portable Docker image.

Current hosted target:

- Azure region: Central US
- App host: Azure Container Apps
- Image registry/build: Azure Container Registry
- Metadata database: Azure Database for PostgreSQL Flexible Server
- HTML object storage: private Azure Blob Storage
- Blob auth: user-assigned managed identity
- DNS: `post.patchyhq.com`

## State Bootstrap

Create remote Terraform state once. Do not commit the generated backend config.

```sh
az group create --name rg-patchpage-tfstate --location centralus
az storage account create --name <globally-unique-state-account> \
  --resource-group rg-patchpage-tfstate \
  --location centralus \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false
az storage container create --name tfstate \
  --account-name <globally-unique-state-account> \
  --auth-mode login
```

Create `backend.hcl` locally:

```hcl
resource_group_name  = "rg-patchpage-tfstate"
storage_account_name = "<globally-unique-state-account>"
container_name       = "tfstate"
key                  = "patchpage-prod.tfstate"
```

## Deploy

```sh
cd infra/azure
cp terraform.tfvars.example terraform.tfvars
# Fill subscription_id. Keep terraform.tfvars ignored.

terraform init -backend-config=backend.hcl
terraform apply -target=azurerm_container_registry.patchpage

TAG=$(git -C ../.. rev-parse --short HEAD)
ACR=$(terraform output -raw acr_name)
LOGIN_SERVER=$(terraform output -raw acr_login_server)
az acr build --registry "$ACR" \
  --image "patchpage-server:$TAG" \
  --file ../../apps/server/Dockerfile \
  ../..

cat >> terraform.tfvars <<EOF
server_image = "$LOGIN_SERVER/patchpage-server:$TAG"
EOF

terraform apply
```

After apply, bind `post.patchyhq.com` to the Container App through Vercel DNS and Azure Container Apps custom domain commands.

## Security Notes

- Do not commit `terraform.tfvars`, `backend.hcl`, `.terraform/`, or generated deployment notes.
- Terraform state contains generated secrets. Keep state in the private Azure state storage account.
- The Blob container is private; public draft viewing goes through the PatchPage server.
- The server uses managed identity for Blob access in production.
- Uploads require API tokens. Anonymous uploads must remain disabled.
