import { Plugin, SettingsPage } from "@opencode/plugin/gui"

// Milestone 1 placeholder; the accounts view and permission tables come next.
export default Plugin.define({
  setup(ctx) {
    ctx.add(SettingsPage, {
      id: "github",
      title: "GitHub",
      icon: "github",
      entries: [{ id: "github", title: "GitHub", description: "Accounts, orgs and permissions for agents", keywords: "github git gh account sso oc-github" }],
      render: () => (
        <ctx.ui.SettingsLayout title="GitHub" description="Accounts, orgs and permissions for agents.">
          <p>oc-github is installed. The accounts view arrives in the next milestone; until then ask your agent to list accounts (github_list).</p>
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})
