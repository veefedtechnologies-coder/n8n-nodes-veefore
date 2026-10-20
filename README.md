# n8n-nodes-veefore

Run protected actions from n8n workflows and AI agents through
[Veefore](https://docs.veefore.com): policy, risk, human approval and a
credential broker, decided at the Veefore gateway. The workflow never holds the
provider secret, and a refused action never happens.

Full guide: <https://docs.veefore.com/build/n8n>

## Install

- n8n UI: **Settings → Community nodes → Install** → `n8n-nodes-veefore`
- Self-hosted: `npm install n8n-nodes-veefore` in `~/.n8n/nodes`, or build this
  package and point `N8N_CUSTOM_EXTENSIONS` at a directory containing it
  (n8n then names the node `CUSTOM.veefore`)

Restart n8n afterwards.

## Set up in Veefore first

In the Veefore console open **Integrations → n8n**: choose or create the agent
n8n acts as, tick the tools it may use, and create the connection secret. You
get two values.

## Credential: Veefore API

- **Key ID** (`key_…`): names the agent's key.
- **Connection Secret** (`vf_secret_…`): the key's private half, shown once in
  the console. It only signs a two-minute identity assertion; Veefore never
  receives it, and it grants nothing beyond the agent's own tools and policy.
- **Gateway URL**: prefilled with `https://gateway.veefore.com`.

Saving the credential tests it against the gateway.

## Operations

- **Run Tool**: pick a tool (listed live from Veefore) and fill its fields,
  built from the tool's parameter schema; or send JSON. Three outputs:
  **Allowed**, **Refused** and **Needs Approval**. Whether a person must
  approve is decided by your Veefore policy. By default the node waits for that
  decision, for as long as the approval is open, then runs the approved action
  or routes to Refused; or choose to continue on **Needs Approval** without
  waiting.
- **Check Only**: the decision without running anything.
- **List Tools** and **Get Approval**.

## Veefore Tools (for an AI Agent)

Connect **Veefore Tools** to an AI Agent's Tool input and **Add Action** for
each of the agent's actions, as many as you like. Each is offered to the model
as a tool, and Veefore decides every call. Every action has its own **Tool
Name**, **Tool Description** and **Purpose** (shown to approvers).

- **Veefore performs it**: the gateway carries it out. Its **Parameters** come
  from Veefore, required ones first; each is filled by the model (with a hint
  you can edit) or set to a fixed value the model never sees.
- **n8n performs it**: adding one shows an **n8n Tools** input. Connect the n8n
  tool that performs it (Gmail, Slack, HTTP Request, …) there instead of to the
  agent, and set its fields in that tool. The model sees it by its own name,
  and it runs only after Veefore allows that exact call. Tools wired in for
  anything else are not offered.

Allowed: it runs once. Refused: nothing runs, and the model is told why. Needs
approval: the node waits up to **Wait for a Decision** (2 minutes by default).
Still undecided: an action Veefore performs is carried out by Veefore if it is
approved later; for one n8n performs, the user asks again once approved and the
identical call goes ahead without a second approval. No answer from Veefore
means nothing runs.

2.3.0 removed **Veefore Tool** (one action per node) and **Veefore Guard**:
replace either with Veefore Tools and add the same action.

## Important

Installing this node does not protect a workflow that also contains a direct
Gmail, HTTP Request or Code node. Register the instance in Veefore so it can
verify the workflows and report those paths.

## Build

```bash
npm install --ignore-scripts
npm run build   # n8n-node build
npm run lint    # n8n-node lint, including the n8n Cloud checks
```

No runtime dependencies; only `n8n-workflow` (peer) and `node:crypto`.
Compatible with n8n 1.x and 2.x; verified on 2.43.7.

## Publishing and n8n Cloud verification

n8n Cloud installs only verified community nodes. Verification requires a
package published to npm **from GitHub Actions with a provenance statement**,
and npm generates provenance only from a **public** repository.

1. Create a public GitHub repository (for example `n8n-nodes-veefore`) and copy
   this directory into its root, including `.github/workflows/publish.yml`.
2. On npmjs.com, publish once by hand only if the name must be reserved;
   otherwise let the workflow do the first publish. Then open the package →
   **Settings → Publish access → Trusted Publishers → Add → GitHub Actions**:
   your organization, the repository name, workflow `publish.yml`.
3. In the repository: `npm run release`. It lints, builds, bumps the
   version, tags and pushes; the tag runs the workflow, which publishes with
   provenance.
4. Check the published package: `npx @n8n/scan-community-package n8n-nodes-veefore`.
5. Submit it in the [n8n Creator Portal](https://creators.n8n.io). n8n reviews
   it against its technical and UX guidelines; on approval it appears in the
   nodes panel of n8n Cloud.
