// Test helper: a fake GitHub on 127.0.0.1 with the device flow, the API calls the plugin makes (including SAML SSO
// headers), and real git repos served by `git http-backend` behind token Basic auth.
import { execFile, spawn } from "node:child_process"
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface FakeGitHub {
  readonly host: string
  readonly web: string
  readonly api: string
  readonly reposDir: string
  /** The user approves the pending device code in the browser. */
  approve(): void
  /** Creates a bare repo `<owner>/<repo>.git` with one commit on main. */
  createRepo(owner: string, repo: string): Promise<string>
  /** Requests received, for assertions. */
  readonly log: { method: string; path: string; auth?: string }[]
  stop(): Promise<void>
}

export async function startFakeGitHub(options: { login: string; token: string; orgs: string[]; ssoBlocked?: string[]; authorizedKeys?: string }): Promise<FakeGitHub> {
  const reposDir = await mkdtemp(join(tmpdir(), "ocg-fake-"))
  let approved = false
  const log: FakeGitHub["log"] = []
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(JSON.stringify(body))
  }
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${options.token}`
  const blocked = options.ssoBlocked ?? []
  const orgId = (login: string) => 1000 + [...options.orgs, ...blocked].indexOf(login)

  const git = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : ""
    if (basic.slice(basic.indexOf(":") + 1) !== options.token) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake github"' }); res.end("auth required"); return
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: reposDir, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: basic.slice(0, basic.indexOf(":")), REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["content-encoding"] && { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] }),
      },
      stdio: ["pipe", "pipe", "inherit"],
    })
    req.pipe(child.stdin)
    const chunks: Buffer[] = []
    child.stdout.on("data", chunk => chunks.push(chunk))
    child.on("close", () => {
      const output = Buffer.concat(chunks)
      const split = output.indexOf("\r\n\r\n")
      const headerText = output.subarray(0, split).toString()
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of headerText.split("\r\n")) {
        const [name, ...rest] = line.split(":")
        if (!name) continue
        if (name.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0])
        else headers[name] = rest.join(":").trim()
      }
      res.writeHead(status, headers)
      res.end(output.subarray(split + 4))
    })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x")
    log.push({ method: req.method!, path: url.pathname, ...(req.headers.authorization && { auth: req.headers.authorization.split(" ")[0] }) })
    const chunks: Buffer[] = []
    if (/\.git\//.test(url.pathname)) return git(req, res, url)
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    if (url.pathname === "/login/device/code") return send(res, 200, { device_code: "device-123", user_code: "ABCD-1234", verification_uri: `http://${host}/login/device`, expires_in: 900, interval: 1 })
    if (url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(body)
      if (form.get("device_code") !== "device-123") return send(res, 200, { error: "bad_verification_code" })
      return send(res, 200, approved ? { access_token: options.token, token_type: "bearer", scope: "repo,read:org,admin:public_key" } : { error: "authorization_pending" })
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { message: "Not Found" })
    if (!authorized(req)) return send(res, 401, { message: "Bad credentials" })
    const path = url.pathname.slice(4)
    if (path === "/user") return send(res, 200, { login: options.login, id: 4242, name: "Test User" }, { "x-oauth-scopes": "repo, read:org, admin:public_key" })
    if (path === "/user/orgs") {
      return send(res, 200, options.orgs.map(login => ({ login, id: orgId(login) })), blocked.length ? { "x-github-sso": `partial-results; organizations=${blocked.map(orgId).join(",")}` } : {})
    }
    const byId = /^\/organizations\/(\d+)$/.exec(path)
    if (byId) { const login = blocked.find(name => orgId(name) === Number(byId[1])); return login ? send(res, 200, { login, id: Number(byId[1]) }) : send(res, 404, { message: "Not Found" }) }
    const repos = /^\/orgs\/([^/]+)\/repos$/.exec(path)
    if (repos && blocked.includes(repos[1]!)) return send(res, 403, { message: "Resource protected by organization SAML enforcement." }, { "x-github-sso": `required; url=https://github.com/orgs/${repos[1]}/sso?authorization_request=req-1` })
    const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path)
    if (membership) return options.orgs.includes(membership[1]!) ? send(res, 200, { role: "member", state: "active" }) : send(res, 404, { message: "Not Found" })
    if (path === "/user/keys" && req.method === "POST") {
      const key = JSON.parse(body).key as string
      if (options.authorizedKeys) await appendFile(options.authorizedKeys, `${key}\n`)
      return send(res, 201, { id: 1, key })
    }
    return send(res, 404, { message: "Not Found" })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    host, web: `http://${host}`, api: `http://${host}/api`, reposDir, log,
    approve: () => { approved = true },
    async createRepo(owner, repo) {
      const bare = join(reposDir, owner, `${repo}.git`)
      await mkdir(join(reposDir, owner), { recursive: true })
      await exec("git", ["init", "-q", "--bare", "-b", "main", bare])
      await exec("git", ["-C", bare, "config", "http.receivepack", "true"])
      const work = await mkdtemp(join(tmpdir(), "ocg-seed-"))
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@example.com", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@example.com" }
      await exec("git", ["init", "-q", "-b", "main", work], { env })
      await exec("git", ["-C", work, "commit", "-q", "--allow-empty", "-m", "seed"], { env })
      await exec("git", ["-C", work, "push", "-q", bare, "main"], { env })
      await rm(work, { recursive: true, force: true })
      return bare
    },
    async stop() { await new Promise(resolve => server.close(resolve)); await rm(reposDir, { recursive: true, force: true }) },
  }
}
