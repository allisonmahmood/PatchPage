export interface HtmlStorage {
  putHtmlObject(key: string, html: string): Promise<void>;
  getHtmlObject(key: string): Promise<string>;
  deleteHtmlObject(key: string): Promise<void>;
}

export interface StorageOptions {
  driver: "filesystem" | "azure-blob";
  storageDir: string;
  azureStorageAccount: string | null;
  azureStorageContainer: string | null;
  azureStorageConnectionString: string | null;
}
