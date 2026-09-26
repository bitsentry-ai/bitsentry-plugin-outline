# Outline plugin

Search/read knowledge and create, update, or delete Markdown documents through
the BitSentry SDK in Desktop or Dashboard, or the standalone debug CLI.

## Build and SDK contract

Requires Node.js 22.12+ and pnpm 10.32.1. This repository owns its dependencies
and `pnpm-lock.yaml`, including when checked out under Desktop CE.

```sh
pnpm --ignore-workspace install --frozen-lockfile
pnpm --ignore-workspace run build
pnpm --ignore-workspace run typecheck
pnpm --ignore-workspace run lint
```

The build validates the plugin against the published SDK schema, checks unique
action/field IDs, CRUD coverage, write labels, and matching versions. It produces
`build/outline.plugin.js`, `build/index.yaml`, `build/descriptor.json`, and
`build/checksums.sha256`. CI uploads that directory as the `plugin` artifact.

The SDK contract is `actions[]` with declared fields, `riskLevel`, and `execute`.
Both plugins use `create_*`, `get_*`, `update_*`, and `delete_*` action IDs
for CRUD, plus list/search and provider-specific actions. The SDK does not
require every integration to expose CRUD methods. Host results use
`pluginId`, `actionId`, `ok`, `status`, `summary`, and optional `data`. Provider
payloads stay inside `data`. No SDK change is required. A type-only compatibility
declaration accepts optional cancellation/deadlines from newer hosts while
remaining compatible with the published SDK 0.1.0.

## Install in BitSentry

```sh
bitsentry plugin install outline --index-url /absolute/path/to/this-repository/build/index.yaml
bitsentry plugin info outline --json
```

Desktop CE's build orchestrates an isolated frozen install/build for this
submodule; it does not add these dependencies to CE's lockfile. The combined
Desktop artifact index remains at `apps/desktop-ce/build/plugins/index.yaml`.
Dashboard can use that index via `BITSENTRY_PLUGIN_INDEX_URL`; include `outline`
in an explicitly configured `BITSENTRY_CLOUD_PLUGIN_ALLOWLIST`.
Desktop and Dashboard resolve their own credentials. No Prisma migration is
needed to install or execute this plugin. Dashboard webhook receivers are a
separate backend feature. Building does not update the public plugin catalog.

## Debug without the Desktop app

After building, list action IDs, fields, and defaults without connecting:

```sh
pnpm --ignore-workspace run debug
```

Create a credentials file named `auth.local.json`, restrict its permissions, and
set `BITSENTRY_PLUGIN_AUTH_FILE` to its absolute path. `*.local.json` and `.env*`
are ignored by Git. Never commit real credentials. The debug command reads auth
from the file; it does not put credentials in command-line arguments.

Auth file shape:

```json
{"apiBase":"https://outline.example.com/api","accessToken":"YOUR_API_KEY"}
```

`apiBase` defaults to `https://app.getoutline.com/api`. For self-hosting, set
`OUTLINE_ALLOWED_API_BASES` on the invoking host to the exact HTTPS API URL,
including `/api` (comma-separated for multiple instances). Redirects are rejected.

```sh
export OUTLINE_ALLOWED_API_BASES=https://outline.example.com/api
export BITSENTRY_PLUGIN_AUTH_FILE=/absolute/path/to/auth.local.json
pnpm --ignore-workspace run debug --action list_collections --show-data
pnpm --ignore-workspace run debug --action search_documents --input search.local.json --show-data
```

Example `search.local.json`: `{"query":"database restart","limit":10}`.
Use `--show-data` to include provider results; otherwise output contains only the
SDK summary/status. Results may contain internal document content. Writes require
`--confirm-write` in this debug CLI, in addition to action-specific confirmations.

## Actions

| Action | Main inputs | Risk |
| --- | --- | --- |
| `list_collections` | optional `limit`, `offset` | read |
| `list_documents` | optional `collectionId`, `limit`, `offset` | read |
| `search_documents` | `query`, optional `collectionId`, `limit`, `offset` | read |
| `get_document` | `id` | read |
| `create_document` | `collectionId`, `title`, `text`, optional `parentDocumentId`, `publish` | write |
| `update_document` | `id`, at least one of `title`, `text`, `publish`; optional `editMode`, `lastRevision` | write |
| `delete_document` | `id`, `confirmDelete: true` | write |

Creation uses Markdown and defaults to an unpublished draft. Example:
`{"collectionId":"YOUR_COLLECTION_UUID","title":"Incident review","text":"# Summary\n\nFindings and resolution.","publish":false}`.
Use collection listing to find the destination. Updates preserve omitted fields;
empty `text` clears content. `editMode` supports replace/append/prepend.
`lastRevision` provides optimistic concurrency on supporting Outline versions.
Deletion moves a document to trash; permanent deletion is not exposed.

Pagination defaults to 25 results at offset 0, with a maximum page size of 100.
Provider results contain `data` and `pagination`. Requests honor cancellation and
deadlines, with a maximum 30-second timeout. HTTP errors return `ok: false`;
429 results include `retryAfter`. No mutation retries are automatic. A timeout
may follow a successful remote creation; reconcile before retrying.

Check the key's endpoint scopes, collection access, destination allowlist, and
HTTP status when debugging. No credentials or document bodies are logged by the
plugin. Comments, attachments, OAuth acquisition, and webhook subscriptions are
outside this document plugin's scope.

See the [official Outline API](https://www.getoutline.com/developers) and
[OpenAPI specification](https://github.com/outline/openapi).
Build validation confirms the SDK contract, not connectivity or permissions on a
particular Outline installation.
