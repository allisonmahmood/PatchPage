import { AzureBlobHtmlStorage } from "./azure-blob.js";
import { FileSystemHtmlStorage } from "./filesystem.js";
import type { HtmlStorage, StorageOptions } from "./types.js";

export function createHtmlStorage(options: StorageOptions): HtmlStorage {
  if (options.driver === "azure-blob") {
    return new AzureBlobHtmlStorage({
      account: options.azureStorageAccount,
      container: options.azureStorageContainer,
      connectionString: options.azureStorageConnectionString
    });
  }

  return new FileSystemHtmlStorage(options.storageDir);
}
