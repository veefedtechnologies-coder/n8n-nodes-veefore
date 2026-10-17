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

## Credential: Veefore Agent API

Gateway URL, agent ID, key ID and the agent's Ed25519 private key, plus the
optional runtime connection ID from the Veefore console. The key signs a
two-minute identity assertion; it grants no authority of its own. It is not a
Veefore administrator credential.

## Operations

Execute action · Authorize (dry run, single-use authorization) · Get approval
status · List permitted tools. Usable as an AI Agent tool.

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
