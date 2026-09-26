# Outline plugin

BitSentry code-plugin artifact for Desktop CE/Pro and Dashboard runbook actions.
It has no runtime dependencies; `dist/plugin.js` exports the SDK plugin contract.
The Desktop build compiles it after the SDK declarations. Desktop and
Dashboard supply their own auth for each invocation; the plugin stores no secrets.

## Standalone development

Requires Node.js 22.12+ and pnpm 10.32.1.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
```

The build emits `dist/plugin.js` and TypeScript declarations. The SDK is a
build-time dependency; credentials are supplied by the invoking BitSentry host.
Source publication does not publish a plugin artifact or update the plugin index.

## BitSentry workspace installation

When integrated into the BitSentry monorepo, from its root, run `pnpm run build`. To rebuild Desktop packages and
regenerate the plugin artifacts/index:

```sh
pnpm run desktop:ce:build:packages
bitsentry plugin install outline --index-url /absolute/path/to/apps/desktop-ce/build/plugins/index.yaml
```

The Desktop build generates `build/plugins/outline.plugin.js` and `build/plugins/index.yaml` for local installation before publication. The public
first-party index has **not** been updated. Publishing requires uploading the
built artifact to an approved first-party location and adding its index entry.

For Dashboard, deploy the generated `build/plugins` directory together,
set `BITSENTRY_PLUGIN_INDEX_URL` to the absolute deployed index path, and include
`outline` in `BITSENTRY_CLOUD_PLUGIN_ALLOWLIST`. When using other plugins, merge
their existing entries into that index and retain their allowlist names. The
worker's existing `CloudPluginRuntime` installs and executes the same artifact;
use `pluginId: "outline"`, `pluginActionId` from the table below, and the
`pluginAuth`/`pluginInput` JSON fields in plugin runbook steps. Supply credentials
through the host's secret handling rather than committing them to runbooks. This is
an action plugin, not a continuous ingestion connector or a new Dashboard setup UI.

## Credentials and actions

Set `auth.accessToken` to an Outline API key (a secret field). `auth.apiBase`
defaults to `https://app.getoutline.com/api`. For self-hosting, set the exact HTTPS
API URL, including `/api`, in both `auth.apiBase` and the host environment's
comma-separated `OUTLINE_ALLOWED_API_BASES`. For Desktop this environment belongs
to the Desktop/CLI process; for Dashboard it belongs to the worker. Only an
administrator should allowlist destinations. Redirects are rejected.

| Action ID | Inputs | Risk |
| --- | --- | --- |
| `list_collections` | `limit`, `offset` | read |
| `list_documents` | optional `collectionId`, `limit`, `offset` | read |
| `search_documents` | `query`, optional `collectionId`, `limit`, `offset` | read |
| `get_document` | `id` | read |
| `update_document` | `id`; optional `title`, `text`, `publish`, `editMode`, `lastRevision` | write |
| `delete_document` | `id`, `confirmDelete: true` | write |
| `create_document` | `collectionId`, `title`, `text`; optional `parentDocumentId`, `publish` | write |

Pagination defaults to 25 results at offset 0; maximum page size is 100. Results
retain the API `data` and `pagination` under the action result's `data` property.
The document text is Markdown. Creation defaults to `publish: false` (draft).
Updates accept optional `title`, `text`, `publish`, `editMode` (replace/append/prepend),
and `lastRevision` for optimistic concurrency on supporting Outline versions.
An empty `text` intentionally clears content. Omitted fields stay unchanged.
Deletion requires `confirmDelete: true` and moves the document to trash; the
plugin does not expose irreversible permanent deletion.
Use the collection listing to obtain a destination ID, then pass it to creation.
Calls honor host cancellation/deadlines and have a maximum 30-second timeout.
HTTP failures return `ok: false`; rate limits include `retryAfter`. There are no
automatic retries: a timed-out creation can have succeeded remotely, so check
Outline before retrying. Document content and credentials are never logged.

Example creation input (credentials are supplied separately through host auth):

```json
{
  "collectionId": "YOUR_COLLECTION_UUID",
  "title": "Incident review",
  "text": "# Summary\n\nInvestigation findings and remediation steps.",
  "publish": false
}
```

## API research

Outline is a collaborative knowledge base with collections, Markdown documents,
permissions, revision history, and search. Its API also covers comments, users,
groups, shares, attachments, imports/exports, and webhook subscriptions. API keys
and OAuth tokens use bearer authentication. Grant only the endpoint scopes needed
by the chosen actions. This plugin implements seven document/collection actions;
OAuth acquisition, attachments, and webhooks are outside this first version.
See the [official API reference](https://www.getoutline.com/developers) and
[OpenAPI specification](https://github.com/outline/openapi).

Outline's application is currently source-available under BSL 1.1, not an
OSI open-source license; its API specification has a separate BSD license.
See the [application license](https://github.com/outline/outline/blob/main/LICENSE).

The companion iTop plugin is maintained in
[bitsentry-plugin-itop](https://github.com/bitsentry-ai/bitsentry-plugin-itop).
Dashboard webhook receivers belong to the BitSentry monorepo, not this plugin.

No live Outline instance was supplied. Build/type validation does not establish
connectivity, account permissions, or compatibility with a client's older release.
