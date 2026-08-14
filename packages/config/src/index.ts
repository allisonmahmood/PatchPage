import { isIP } from "node:net";

const MAX_TRUST_PROXY_HOPS = 32;
const MAX_RATE_LIMIT_PER_MINUTE = 10_000;
const MAX_LIVE_DRAFTS_PER_TOKEN = 1_000_000;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAX = (1n << 32n) - 1n;
const IPV6_MAX = (1n << 128n) - 1n;
const IPV4_MAPPED_IPV6_START = 0xffffn << 32n;
const IPV4_MAPPED_IPV6_END = IPV4_MAPPED_IPV6_START + IPV4_MAX;
const DEPRECATED_TRANSITIONAL_IPV6_PATTERN = /^::(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

interface TrustedProxyRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

export interface ServerConfig {
  port: number;
  publicBaseUrl: string;
  trustProxy: false | number | string[];
  bootstrapApiToken: string | null;
  allowAnonymousUploads: boolean;
  maxHtmlBytes: number;
  protectedApiRateLimitPerMinute: number;
  authenticatedUploadRateLimitPerMinute: number;
  anonymousCreateRateLimitPerMinute: number;
  draftCreateRateLimitPerMinute: number;
  /**
   * The live-draft ceiling one token may hold. Counted from the database on
   * every create, so it survives a restart — unlike the per-minute limiters.
   */
  liveDraftsPerToken: number;
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
    allowAnonymousUploads: strictBoolValue(
      "PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS",
      env.PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS,
      false
    ),
    maxHtmlBytes: intValue(env.PATCHPAGE_MAX_HTML_BYTES, 512 * 1024),
    protectedApiRateLimitPerMinute: rateLimitPerMinuteValue(
      "PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE",
      env.PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE,
      60
    ),
    authenticatedUploadRateLimitPerMinute: rateLimitPerMinuteValue(
      "PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE",
      env.PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE,
      20
    ),
    anonymousCreateRateLimitPerMinute: rateLimitPerMinuteValue(
      "PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE",
      env.PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE,
      5
    ),
    draftCreateRateLimitPerMinute: rateLimitPerMinuteValue(
      "PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE",
      env.PATCHPAGE_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE,
      10
    ),
    liveDraftsPerToken: boundedIntegerValue(
      "PATCHPAGE_LIVE_DRAFTS_PER_TOKEN",
      env.PATCHPAGE_LIVE_DRAFTS_PER_TOKEN,
      1_000,
      MAX_LIVE_DRAFTS_PER_TOKEN
    ),
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
  const ranges: TrustedProxyRange[] = [];
  for (const entry of entries) {
    const range = trustedProxyRange(entry);
    if (!range) {
      throw new Error(`Invalid PATCHPAGE_TRUST_PROXY value: ${value}`);
    }
    ranges.push(range);
  }

  if (coversFullAddressFamily(ranges, 4) || coversFullAddressFamily(ranges, 6)) {
    throw new Error(`Invalid PATCHPAGE_TRUST_PROXY value: ${value}`);
  }

  return entries;
}

function trustedProxyRange(value: string): TrustedProxyRange | null {
  if (value.includes("%")) return null;

  const [address, prefix, extra] = value.split("/");
  if (!address || extra !== undefined) return null;

  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;

  const bitWidth = family === 4 ? IPV4_BITS : IPV6_BITS;
  const prefixLength = prefix === undefined ? bitWidth : parsePrefixLength(prefix, bitWidth);
  if (prefixLength === null) return null;
  if (family === 6 && DEPRECATED_TRANSITIONAL_IPV6_PATTERN.test(address)) return null;

  const range = cidrRange(address, family, prefixLength);
  if (family === 6 && overlapsIpv4MappedIpv6Alias(range)) return null;
  return range;
}

function parsePrefixLength(prefix: string, bitWidth: number): number | null {
  if (!/^[1-9]\d*$/.test(prefix)) return null;
  const prefixLength = Number(prefix);
  return prefixLength <= bitWidth ? prefixLength : null;
}

function cidrRange(address: string, family: 4 | 6, prefixLength: number): TrustedProxyRange {
  const bitWidth = family === 4 ? IPV4_BITS : IPV6_BITS;
  const value = family === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const size = 1n << BigInt(bitWidth - prefixLength);
  const start = (value / size) * size;

  return {
    family,
    start,
    end: start + size - 1n
  };
}

function overlapsIpv4MappedIpv6Alias(range: TrustedProxyRange): boolean {
  return rangesOverlap(
    range.start,
    range.end,
    IPV4_MAPPED_IPV6_START,
    IPV4_MAPPED_IPV6_END
  );
}

function rangesOverlap(start: bigint, end: bigint, otherStart: bigint, otherEnd: bigint): boolean {
  return start <= otherEnd && end >= otherStart;
}

function coversFullAddressFamily(ranges: TrustedProxyRange[], family: 4 | 6): boolean {
  const familyRanges = ranges.filter((range) => range.family === family);
  if (familyRanges.length === 0) return false;

  familyRanges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const max = family === 4 ? IPV4_MAX : IPV6_MAX;
  let nextUncovered = 0n;
  for (const range of familyRanges) {
    if (range.end < nextUncovered) continue;
    if (range.start > nextUncovered) return false;
    if (range.end === max) return true;
    nextUncovered = range.end + 1n;
  }

  return false;
}

function ipv4ToBigInt(address: string): bigint {
  let value = 0n;
  for (const octet of address.split(".")) {
    value = (value << 8n) + BigInt(Number(octet));
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) throw new Error(`Invalid IPv6 address: ${address}`);

  const head = halves[0] ?? "";
  const tail = halves[1] ?? "";
  const headSegments = countIpv6Segments(head);
  const tailSegments = countIpv6Segments(tail);
  const zeroSegments = halves.length === 2 ? IPV6_BITS / 16 - headSegments - tailSegments : 0;
  const segments: number[] = [];

  appendIpv6Segments(segments, head);
  for (let index = 0; index < zeroSegments; index += 1) {
    segments.push(0);
  }
  appendIpv6Segments(segments, tail);

  let value = 0n;
  for (const segment of segments) {
    value = (value << 16n) + BigInt(segment);
  }
  return value;
}

function countIpv6Segments(section: string): number {
  if (!section) return 0;

  let count = 0;
  for (const segment of section.split(":")) {
    count += segment.includes(".") ? 2 : 1;
  }
  return count;
}

function appendIpv6Segments(segments: number[], section: string): void {
  if (!section) return;

  for (const segment of section.split(":")) {
    if (segment.includes(".")) {
      const ipv4 = ipv4ToBigInt(segment);
      segments.push(Number((ipv4 >> 16n) & 0xffffn));
      segments.push(Number(ipv4 & 0xffffn));
    } else {
      segments.push(Number.parseInt(segment, 16));
    }
  }
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

function rateLimitPerMinuteValue(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return boundedIntegerValue(name, value, fallback, MAX_RATE_LIMIT_PER_MINUTE);
}

function boundedIntegerValue(
  name: string,
  value: string | undefined,
  fallback: number,
  max: number
): number {
  const trimmed = stringValue(value);
  if (!trimmed) return fallback;
  if (!/^[1-9]\d*$/.test(trimmed) || Number(trimmed) > max) {
    throw new Error(
      `${name} must be a decimal integer from 1 through ${max}, received: ${value}`
    );
  }
  return Number(trimmed);
}

function strictBoolValue(
  name: string,
  value: string | undefined,
  fallback: boolean
): boolean {
  const trimmed = stringValue(value);
  if (!trimmed) return fallback;
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  throw new Error(`${name} must be true or false, received: ${value}`);
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
