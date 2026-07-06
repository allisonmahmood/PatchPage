export function getDraftPublicUrl(options: {
  draftId: string;
  publicBaseUrl: string;
  requestBaseUrl?: string;
}): string {
  const baseUrl = normalizeUrl(options.publicBaseUrl || options.requestBaseUrl || "");
  return `${baseUrl}/d/${options.draftId}`;
}

export function getRequestBaseUrl(request: { protocol: string; hostname: string; port?: number }): string {
  const port = request.port ? `:${request.port}` : "";
  return `${request.protocol}://${request.hostname}${port}`;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
