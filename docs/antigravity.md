# Antigravity CLI (agy)

LearnHarness can use an installed **Antigravity CLI** (`agy`) as a model provider. It runs whichever models your Antigravity plan offers (for example Gemini Flash, Claude Sonnet/Opus, and GPT-OSS) through your Google sign-in. No API key is needed. The CLI owns authentication, routing, model access, quota, and billing. LearnHarness does **not** guarantee any particular plan or limit.

## Set up

1. Install `agy` and sign in with Google outside LearnHarness. Do this on **the machine running the LearnHarness server**, under its OS user. Run `agy` once in a terminal to finish the sign-in.
2. Make the executable discoverable. LearnHarness searches the server's `PATH`, then the installer locations: `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows; `~/.local/bin`, `~/.agy/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` elsewhere. On Windows a directly runnable `agy.exe` is required.
3. Enable **Settings → Providers → External CLI → Antigravity CLI (agy)**. This opt-in is **off by default**.
4. The check runs `agy --version` and then `agy models`. The model list is saved next to `settings.json` (`antigravity-models.json`), so saved model selections still resolve after a restart. Use **Check again** after upgrading the CLI or changing plans.
5. Select an Antigravity model for a slot. agy encodes thinking depth in the model id itself (for example `gemini-3.8-flash-low` and `gemini-3.8-flash-high`), so these models offer no separate thinking level.

The minimum version is **1.5.3** ([contract](../src/core/contracts/antigravity.ts)). It is the version this integration was verified against, not an official compatibility promise. Every new lesson process checks the version again.

## How it runs

Each model turn starts `agy acp`, the CLI's [Agent Client Protocol](https://agentclientprotocol.com) server, without a shell. It runs in an empty temporary working directory with:

- `--gemini-dir <empty temp dir>`, so your own `GEMINI.md` rules, skills, and MCP servers do not reach the tutor. Your Google sign-in still works.
- `--include-default-customizations=false` and `--disable-telemetry`.
- LearnHarness's system prompt delivered as `_meta.antigravity.systemPrompt.append`. agy has no way to *replace* its own system prompt, so the tutor's instructions are appended after agy's. If a CLI does not offer append, the turn is refused.
- LearnHarness's tools exposed through the same token-protected loopback MCP bridge used for [Claude Code](claude-code.md). The model sees them as `mcp_learnharness_<tool>`.

agy streams its own call ID for each tool call, but its MCP requests carry no ID. LearnHarness pairs each authenticated MCP request with its streamed intent by tool name and arguments, ignoring agy's display-only `toolSummary`. Only paired calls execute, using the authenticated arguments. Anything left unpaired after two seconds fails the turn.

### agy's built-in tools are refused

agy always brings its own tools (shell, file editing, file reading, browser, web search, and more). None of them can be switched off. LearnHarness therefore **fails closed**:

- Every permission request is rejected.
- If the model starts *any* tool that is not a LearnHarness tool, including read-only ones that need no permission, the turn is cancelled, the process is killed, and the turn reports `agy tried to use its built-in tool "<name>"`.

A read-only built-in tool may already have run by the time it is reported. This is an integration boundary, **not an OS sandbox**.

## Questions, reuse, and replay

agy abandons an MCP tool call after a hard **three-minute** deadline. Progress notifications do not extend it, and agy then retries the call by itself. So a held process is released after **150 seconds** idle: for example, while a learner is still thinking about a question. When the answer arrives, a fresh process replays the active history as labelled text, preceded by a note that tool calls in the transcript have already run. Answers inside the window continue the same process, which keeps agy's prompt cache warm.

The persisted LearnHarness transcript is authoritative. agy's own conversation storage lives in the temporary Gemini directory and is deleted when the process exits.

## Usage and troubleshooting

Token usage comes from ACP's end-of-turn report. agy reports usage once per prompt, so a step that ends in tool calls shows zero, and the following step carries the total. Dollar costs are **unpriced**, and menus say **CLI billing**. See [accounting](compaction-accounting.md).

| Symptom | Check |
| --- | --- |
| No Antigravity models in the picker | Enable the opt-in, then **Check again**. The status line should show a model count. |
| Not found / update required | Install or `agy update` outside LearnHarness, then **Check again**. |
| "agy tried to use its built-in tool" | The model reached for agy's own tools. Retry, or choose another model. Some models do this more often. |
| "MCP call does not match its streamed tool intent" | An agy update changed its tool-call reporting. Report it with the agy version. |
| Answer after a long pause takes longer | Expected: the 150-second hold expired and the history was replayed. |
| Requests fail although the version passes | Check sign-in, plan, and quota by running `agy` in a terminal. |

## Maintainer entry points

[`src/agent/antigravity/`](../src/agent/antigravity/) contains discovery, version and model listing, the ACP connection, event parsing, admission, reuse, and replay. The provider is registered in [`models.ts`](../src/agent/models.ts), and its model list is persisted by [`server/antigravity-config.ts`](../src/server/antigravity-config.ts). `tests/antigravity-stream.test.ts` drives a synthetic ACP agent ([`fake-agy.mjs`](../tests/fixtures/antigravity/fake-agy.mjs)) that calls tools through the real MCP bridge.
