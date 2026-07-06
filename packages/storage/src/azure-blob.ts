import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { requireConfigValue } from "@patchpage/config";
import type { HtmlStorage } from "./types.js";

export interface AzureBlobStorageOptions {
  account: string | null;
  container: string | null;
  connectionString: string | null;
}

export class AzureBlobHtmlStorage implements HtmlStorage {
  private readonly containerClient: ContainerClient;

  constructor(options: AzureBlobStorageOptions) {
    const containerName = requireConfigValue("AZURE_STORAGE_CONTAINER", options.container);

    if (options.connectionString) {
      this.containerClient =
        BlobServiceClient.fromConnectionString(options.connectionString).getContainerClient(
          containerName
        );
      return;
    }

    const account = requireConfigValue("AZURE_STORAGE_ACCOUNT", options.account);
    const credential = new DefaultAzureCredential();
    const serviceClient = new BlobServiceClient(
      `https://${account}.blob.core.windows.net`,
      credential
    );
    this.containerClient = serviceClient.getContainerClient(containerName);
  }

  async putHtmlObject(key: string, html: string): Promise<void> {
    const blob = this.containerClient.getBlockBlobClient(key);
    await blob.upload(html, Buffer.byteLength(html, "utf8"), {
      blobHTTPHeaders: {
        blobContentType: "text/html; charset=utf-8",
        blobCacheControl: "no-store"
      }
    });
  }

  async getHtmlObject(key: string): Promise<string> {
    const blob = this.containerClient.getBlobClient(key);
    const response = await blob.download();
    if (!response.readableStreamBody) {
      throw new Error("Azure Blob response did not include a readable stream.");
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
