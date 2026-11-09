import type { Plugin } from "@opencode/plugin"
import { isAbsolute, resolve } from "node:path"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, ShellSupplier, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import type { Endpoints } from "./github.js"
import { GitHubRpc } from "./rpc.js"
import { defaultEffect, parentEntity } from "./model.js"
import { GitHubService, PLUGIN_ID } from "./service.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface GitHubOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-github`. */
  readonly dataDirectory?: string
  /** Per-host API/web base URLs, for unusual GitHub Enterprise setups (and tests). */
  readonly endpoints?: Readonly<Record<string, Endpoints>>
}

export function parseOptions(raw: unknown): GitHubOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  if (options.dataDirectory !== undefined && typeof options.dataDirectory !== "string") throw new Error(`${PLUGIN_ID}: dataDirectory must be a string`)
  let endpoints: Record<string, Endpoints> | undefined
  if (options.endpoints !== undefined) {
    if (!options.endpoints || typeof options.endpoints !== "object") throw new Error(`${PLUGIN_ID}: endpoints must map host -> { web, api }`)
    endpoints = {}
    for (const [host, value] of Object.entries(options.endpoints as Record<string, unknown>)) {
      const entry = value as Record<string, unknown>
      if (typeof entry?.web !== "string" || typeof entry?.api !== "string" || !/^https?:\/\//.test(entry.web) || !/^https?:\/\//.test(entry.api)) {
        throw new Error(`${PLUGIN_ID}: endpoints.${host} needs web and api URLs`)
      }
      endpoints[host.toLowerCase()] = { web: entry.web.replace(/\/$/, ""), api: entry.api.replace(/\/$/, "") }
    }
  }
  return { ...(options.dataDirectory !== undefined && { dataDirectory: options.dataDirectory as string }), ...(endpoints && { endpoints }) }
}

const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const service = await GitHubService.open(pluginDataDir(PLUGIN_ID, options.dataDirectory), options.endpoints ? host => options.endpoints![host] : undefined)
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, parent: parentEntity, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)

        const tools = createTools(service)
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve().then(() => ctx.tool.reload()).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        // GUI only: permissions, sign-in, tokens, export/import. Never exposed as agent tools.
        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(GitHubRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(GitHubRpc, handlers as never))

        // Credentials for git/gh commands matched to an account. Every other command is untouched.
        const directories = new Map<string, string>()
        const shell = new ShellSupplier({
          plugin: PLUGIN_ID, redactor: service.redactor, warn,
          prepare: async (command, caller) => {
            if (!/\b(git|gh)\b/.test(command)) return undefined
            let base = directories.get(caller.sessionID)
            if (!base) {
              base = (await ctx.session.get({ sessionID: caller.sessionID as never })).location.directory as string
              directories.set(caller.sessionID, base)
              if (directories.size > 1000) directories.delete(directories.keys().next().value!)
            }
            const cwd = caller.workdir ? (isAbsolute(caller.workdir) ? caller.workdir : resolve(base, caller.workdir)) : base
            return service.prepareCommand(command, { ...caller, cwd })
          },
        })
        registrations.push({ dispose: () => shell.dispose() })
        registrations.push(await ctx.tool.hook("execute.before", event => shell.before(event)))
        registrations.push(await ctx.shell.hook("create.before", event => shell.create(event)))
        registrations.push(await ctx.tool.hook("execute.after", event => shell.after(event as never)))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
