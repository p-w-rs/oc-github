import type { Rpc } from "@opencode/plugin/rpc"

// Shared by the server plugin and the GUI. Plain data (type-only import), so the server needs no OpenCode packages.
const output = {} as const
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const
const sessionID = { type: "string", minLength: 1, maxLength: 200 }
const id = { type: "string", minLength: 1, maxLength: 64 }

export const GitHubRpc = {
  id: "oc-github.admin",
  methods: {
    state: { input: object({ sessionID }), output },
    setCells: {
      input: object({
        expectedRevision: { type: "integer", minimum: 0 }, sessionID,
        changes: {
          type: "array", maxItems: 200,
          items: object({ entity: { type: "string" }, capability: { type: "string" }, effect: { enum: ["allow", "ask", "deny", null] }, agent: { type: "string" }, session: { type: "boolean" } }, ["entity", "capability", "effect"]),
        },
      }, ["changes"]),
      output,
    },
    createAccount: { input: object({ id, transport: { enum: ["https", "ssh", "none"] }, auth: { enum: ["browser", "token", "none"] }, host: { type: "string" } }, ["id"]), output },
    removeAccount: { input: object({ id }, ["id"]), output },
    signIn: { input: object({ id }, ["id"]), output },
    cancelSignIn: { input: object({ id }, ["id"]), output },
    refresh: { input: object({ id }, ["id"]), output },
    setToken: { input: object({ id, token: { type: "string", minLength: 1, maxLength: 65536 } }, ["id", "token"]), output },
    signOut: { input: object({ id }, ["id"]), output },
    dismissRequest: { input: object({ id: { type: "string" } }, ["id"]), output },
    setAutoPick: { input: object({ autoPick: { type: "boolean" } }, ["autoPick"]), output },
    exportBundle: { input: object({ passphrase: { type: "string" } }, ["passphrase"]), output },
    previewImport: { input: object({ content: { type: "string", maxLength: 67108864 }, passphrase: { type: "string" } }, ["content", "passphrase"]), output },
    applyImport: { input: object({ content: { type: "string", maxLength: 67108864 }, passphrase: { type: "string" }, mode: { enum: ["merge", "replace"] } }, ["content", "passphrase", "mode"]), output },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type Effect = "allow" | "ask" | "deny"

export interface OrgView { readonly login: string; readonly sso: "ok" | "authorize" | "none"; readonly authorizeUrl?: string; readonly role?: string }
export interface AccountView {
  readonly id: string
  readonly label?: string
  readonly host: string
  readonly transport: string
  readonly auth: string
  readonly login?: string
  readonly scopes?: readonly string[]
  readonly error?: string
  readonly checkedAt?: string
  readonly secrets: Record<string, "set" | "unset">
  readonly orgs: readonly OrgView[]
  /** Owners with their own permission cells that GitHub did not report as orgs (extra owners, left orgs). */
  readonly extraScopes: readonly string[]
  readonly owners: readonly string[]
  readonly signIn?: { readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number; readonly status: string; readonly error?: string }
}

/** Everything the GUI shows. Never contains tokens or keys. */
export interface StateView {
  readonly revision: number
  readonly fingerprint: string
  readonly autoPick: boolean
  readonly accounts: readonly AccountView[]
  readonly agents: readonly { id: string; name: string; mode: string }[]
  readonly capabilities: readonly string[]
  /** Capabilities grouped for the table's column picker. */
  readonly groups: Readonly<Record<string, readonly string[]>>
  readonly defaults: Record<string, Effect>
  readonly cells: Record<string, Record<string, Record<string, Effect>>>
  readonly session?: { readonly root: string; readonly cells: Record<string, Record<string, Effect>> }
  readonly requests: readonly { id: string; entity: string; name: string; label: string; purpose: string }[]
}

export interface ImportPreview {
  readonly createdAt: string
  readonly accounts: readonly { id: string; status: string }[]
  readonly secrets: number
  readonly permissionEntities: number
}

/** The effect a cell shows: its own value, else the agent's `*` row, else the account's (for org rows), else the default. */
export function inherited(state: Pick<StateView, "cells" | "defaults">, entity: string, capability: string, agent: string): Effect {
  const chain = entity.includes("@") ? [entity, entity.slice(0, entity.indexOf("@"))] : [entity]
  for (const item of chain) {
    if (agent !== "*") { const own = state.cells[item]?.[agent]?.[capability]; if (own) return own }
    const any = state.cells[item]?.["*"]?.[capability]
    if (any) return any
  }
  return state.defaults[capability] ?? "ask"
}
