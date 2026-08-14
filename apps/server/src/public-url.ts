export function getDraftPublicUrl(options: {
  draftId: string;
  publicBaseUrl: string;
  requestBaseUrl?: string;
}): string {
  const baseUrl = normalizeUrl(options.publicBaseUrl || options.requestBaseUrl || "");
  return `${baseUrl}/d/${options.draftId}`;
}

/**
 * Where a reader goes to report a draft, root-relative on purpose. The footer
 * link lives inside a served page, so keeping it same-origin by construction
 * means a misconfigured public origin can never route a report off the host
 * that served the page — and the link needs no configuration to be correct.
 */
export function getDraftReportPath(draftId: string): string {
  return `/report/${draftId}`;
}

export function getRequestBaseUrl(request: { protocol: string; hostname: string; port?: number }): string {
  const port = request.port ? `:${request.port}` : "";
  return `${request.protocol}://${request.hostname}${port}`;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
