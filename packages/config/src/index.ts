import { isIP } from "node:net";

const MAX_TRUST_PROXY_HOPS = 32;

export interface ServerConfig {
  port: number;
  publicBaseUrl: string;
  trustProxy: false | number | string[];
  bootstrapApiToken: string | null;
  allowAnonymousUploads: boolean;
  maxHtmlBytes: number;
  dbDriver: "postgres" | "json";
  databaseUrl: string | null;
  jsonDbFile: string;
  storageDriver: "filesystem" | "azure-blob";
  storageDir: string;
  azureStorageAccount: string | null;
  azureStorageContainer: string | null;
  azureStorageConnectionString: string | null;
}

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = stringValue(env.DATABASE_URL);
  const dbDriver = enumValue(env.PATCHPAGE_DB_DRIVER, ["postgres", "json"] as const) ??
    (databaseUrl ? "postgres" : "json");

  return {
    port: intValue(env.PORT, 3000),
    publicBaseUrl: stringValue(env.PATCHPAGE_PUBLIC_BASE_URL) ?? "http://localhost:3000",
    trustProxy: trustProxyValue(env.PATCHPAGE_TRUST_PROXY),
    bootstrapApiToken: stringValue(env.PATCHPAGE_BOOTSTRAP_API_TOKEN),
    allowAnonymousUploads: boolValue(env.PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS, false),
    maxHtmlBytes: intValue(env.PATCHPAGE_MAX_HTML_BYTES, 512 * 1024),
    dbDriver,
    databaseUrl,
    jsonDbFile: stringValue(env.PATCHPAGE_DB_FILE) ?? ".local/patchpage-db.json",
    storageDriver:
      enumValue(env.PATCHPAGE_STORAGE_DRIVER, ["filesystem", "azure-blob"] as const) ??
      "filesystem",
    storageDir: stringValue(env.PATCHPAGE_STORAGE_DIR) ?? ".local/drafts",
    azureStorageAccount: stringValue(env.AZURE_STORAGE_ACCOUNT),
    azureStorageContainer: stringValue(env.AZURE_STORAGE_CONTAINER),
    azureStorageConnectionString: stringValue(env.AZURE_STORAGE_CONNECTION_STRING)
  };
}

export function requireConfigValue(name: string, value: string | null | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function stringValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trustProxyValue(value: string | undefined): false | number | string[] {
  if (value === undefined) return false;

  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed) && Number(trimmed) <= MAX_TRUST_PROXY_HOPS) {
    return Number(trimmed);
  }

  const entries = trimmed.split(",").map((entry) => entry.trim());
  if (entries.every(isIpOrCidr)) return entries;

  throw new Error(`Invalid PATCHPAGE_TRUST_PROXY value: ${value}`);
}

function isIpOrCidr(value: string): boolean {
  if (!value.includes("%") && isIP(value)) return true;

  const [address, prefix, extra] = value.split("/");
  if (
    !address ||
    address.includes("%") ||
    !prefix ||
    extra !== undefined ||
    !/^[1-9]\d*$/.test(prefix)
  ) {
    return false;
  }

  const family = isIP(address);
  const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
  return Number(prefix) <= maxPrefix;
}

function intValue(value: string | undefined, fallback: number): number {
  const trimmed = stringValue(value);
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  const trimmed = stringValue(value);
  if (!trimmed) return fallback;
  if (["1", "true", "yes", "on"].includes(trimmed.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(trimmed.toLowerCase())) return false;
  throw new Error(`Expected a boolean value, received: ${value}`);
}

function enumValue<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T
): T[number] | null {
  const trimmed = stringValue(value);
  if (!trimmed) return null;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T[number];
  throw new Error(`Expected one of ${allowed.join(", ")}, received: ${value}`);
}
