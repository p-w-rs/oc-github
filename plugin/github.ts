import type { Discovery, OrgInfo } from "./model.js"

/** Where to reach a GitHub host. Overridable for tests and unusual Enterprise setups. */
export interface Endpoints { readonly web: string; readonly api: string }
export function endpoints(host: string, override?: (host: string) => Endpoints | undefined): Endpoints {
  return override?.(host) ?? (host === "github.com"
    ? { web: "https://github.com", api: "https://api.github.com" }
    : { web: `https://${host}`, api: `https://${host}/api/v3` })
}

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly headers?: Headers) { super(message) }
}

const UA = "oc-github"

async function form(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST", signal,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams(body),
  })
  const text = await response.text()
  let data: Record<string, unknown>
  try { data = JSON.parse(text) } catch { throw new GitHubError(`GitHub returned ${response.status}: ${text.slice(0, 200)}`, response.status) }
  if (!response.ok && !data.error) throw new GitHubError(`GitHub returned ${response.status}`, response.status)
  return data
}

export interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly expiresAt: number
  readonly interval: number
}
export interface TokenGrant {
  readonly token: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly scopes: string[]
}

/** Starts the OAuth device flow: the user enters `userCode` at `verificationUri` in any browser. */
export async function startDeviceFlow(ep: Endpoints, clientId: string, scopes: readonly string[], signal?: AbortSignal): Promise<DeviceCode> {
  const data = await form(`${ep.web}/login/device/code`, { client_id: clientId, scope: scopes.join(" ") }, signal)
  if (data.error) throw new GitHubError(`Sign-in could not start: ${data.error_description ?? data.error}`)
  return {
    deviceCode: String(data.device_code), userCode: String(data.user_code), verificationUri: String(data.verification_uri),
    expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000, interval: Math.max(1, Number(data.interval ?? 5)),
  }
}

const grant = (data: Record<string, unknown>): TokenGrant => ({
  token: String(data.access_token),
  ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
  ...(typeof data.expires_in === "number" && { expiresAt: Date.now() + data.expires_in * 1000 }),
  scopes: typeof data.scope === "string" && data.scope ? data.scope.split(/[ ,]+/) : [],
})

/** Polls until the user finishes (or denies, or the code expires). */
export async function pollDeviceFlow(ep: Endpoints, clientId: string, code: DeviceCode, signal?: AbortSignal, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): Promise<TokenGrant> {
  let interval = code.interval
  while (Date.now() < code.expiresAt) {
    await sleep(interval * 1000)
    signal?.throwIfAborted()
    const data = await form(`${ep.web}/login/oauth/access_token`, {
      client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }, signal)
    if (data.access_token) return grant(data)
    switch (data.error) {
      case "authorization_pending": continue
      case "slow_down": interval = Number(data.interval ?? interval + 5); continue
      case "access_denied": throw new GitHubError("Sign-in was cancelled in the browser")
      case "expired_token": throw new GitHubError("The sign-in code expired; start again")
      default: throw new GitHubError(`Sign-in failed: ${data.error_description ?? data.error}`)
    }
  }
  throw new GitHubError("The sign-in code expired; start again")
}

/** Exchanges a refresh token (GitHub Apps with expiring tokens). */
export async function refreshToken(ep: Endpoints, clientId: string, refresh: string): Promise<TokenGrant> {
  const data = await form(`${ep.web}/login/oauth/access_token`, { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh })
  if (!data.access_token) throw new GitHubError(`Could not refresh the sign-in: ${data.error_description ?? data.error}`)
  return grant(data)
}

export async function api<T = unknown>(ep: Endpoints, token: string, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const response = await fetch(`${ep.api}${path}`, {
    method: init.method ?? "GET", signal: init.signal,
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": UA, "x-github-api-version": "2022-11-28",
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
  if (!response.ok) {
    const message = data && typeof data === "object" && "message" in data ? String((data as { message: unknown }).message) : `HTTP ${response.status}`
    throw new GitHubError(message, response.status, response.headers)
  }
  return { data: data as T, headers: response.headers, status: response.status }
}

/** Parses `X-GitHub-SSO`: `required; url=...` or `partial-results; organizations=1,2`. */
export function parseSso(header: string | null): { url?: string; orgIds: number[] } {
  if (!header) return { orgIds: [] }
  const url = /url=([^;\s]+)/.exec(header)?.[1]
  const ids = /organizations=([\d,\s]+)/.exec(header)?.[1]?.split(",").map(id => Number(id.trim())).filter(Number.isFinite) ?? []
  return { ...(url && { url }), orgIds: ids }
}

/**
 * Who the token belongs to and which orgs it reaches, including SAML SSO orgs that still need the token authorized
 * (GitHub lists those in `X-GitHub-SSO` instead of the response body).
 */
export async function discover(ep: Endpoints, token: string, signal?: AbortSignal): Promise<Discovery> {
  const user = await api<{ login: string; id: number; name?: string | null }>(ep, token, "/user", { signal })
  const scopes = user.headers.get("x-oauth-scopes")?.split(",").map(scope => scope.trim()).filter(Boolean)
  const orgs: OrgInfo[] = []
  let page = 1
  const pending = new Set<number>()
  for (;;) {
    let response
    try { response = await api<{ login: string; id: number }[]>(ep, token, `/user/orgs?per_page=100&page=${page}`, { signal }) }
    catch (error) {
      // Tokens without read:org can still be used; orgs just are not listed.
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) break
      throw error
    }
    for (const id of parseSso(response.headers.get("x-github-sso")).orgIds) pending.add(id)
    for (const org of response.data) orgs.push({ login: org.login, id: org.id, sso: "none" })
    if (response.data.length < 100 || page >= 10) break
    page++
  }
  for (const id of pending) {
    if (orgs.some(org => org.id === id)) continue
    try {
      const org = await api<{ login: string }>(ep, token, `/organizations/${id}`, { signal })
      orgs.push({ login: org.data.login, id, sso: "authorize", ...(await authorizeUrl(ep, token, org.data.login, signal)) })
    } catch { orgs.push({ login: `org-${id}`, id, sso: "authorize" }) }
  }
  // Orgs listed normally may still use SSO; a membership lookup tells us the role and surfaces an SSO requirement.
  for (const [index, org] of orgs.entries()) {
    if (org.sso === "authorize") continue
    try {
      const membership = await api<{ role?: string }>(ep, token, `/user/memberships/orgs/${org.login}`, { signal })
      orgs[index] = { ...org, ...(membership.data.role && { role: membership.data.role }), sso: membership.headers.get("x-github-sso") ? "ok" : org.sso }
    } catch (error) {
      const sso = error instanceof GitHubError ? parseSso(error.headers?.get("x-github-sso") ?? null) : { orgIds: [] }
      if (sso.url) orgs[index] = { ...org, sso: "authorize", authorizeUrl: sso.url }
    }
  }
  return {
    login: user.data.login, userId: user.data.id, ...(user.data.name && { name: user.data.name }),
    noreplyEmail: `${user.data.id}+${user.data.login}@users.noreply.${new URL(ep.web).host}`,
    ...(scopes && { scopes }), orgs: orgs.sort((a, b) => a.login.localeCompare(b.login)), checkedAt: new Date().toISOString(),
  }
}

async function authorizeUrl(ep: Endpoints, token: string, org: string, signal?: AbortSignal): Promise<{ authorizeUrl?: string }> {
  try { await api(ep, token, `/orgs/${org}/repos?per_page=1`, { signal }); return {} }
  catch (error) {
    const url = error instanceof GitHubError ? parseSso(error.headers?.get("x-github-sso") ?? null).url : undefined
    return url ? { authorizeUrl: url } : {}
  }
}

/** Adds an SSH public key to the signed-in account (needs admin:public_key / write:public_key). */
export async function addSshKey(ep: Endpoints, token: string, title: string, key: string): Promise<void> {
  try { await api(ep, token, "/user/keys", { method: "POST", body: { title, key } }) }
  catch (error) {
    if (error instanceof GitHubError && error.status === 422 && /already in use/i.test(error.message)) return
    throw error
  }
}
