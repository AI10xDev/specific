# Permissions and Recommendations Workflow

OpenCode automatically handles permission prompts and recommended question answers during normal CLI operation. The automation preserves explicit permission denials and does not provide process or filesystem isolation.

## Enable Automation

Normal CLI startup enables both workflows. Embedded server users can enable them for one process with:

```bash
OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1 \
OPENCODE_QUESTION_AUTO_RECOMMEND=1 \
opencode
```

These variables must be present in the environment of an embedded server process. Setting them only in a client connected to a separate server does not change server-side evaluation.

## Permission Workflow

Tools request permission with an action and one or more resources. Examples include:

- `bash` with a shell command
- `read` with a file path
- `edit` with one or more file paths
- `external_directory` with a path outside the workspace
- `question` before an agent displays a question

Rules have one of three effects:

- `allow`: execute without prompting
- `ask`: wait for user approval
- `deny`: stop before the protected operation

Rules use `*` and `?` wildcards. When multiple rules match, the last matching rule wins. For a request containing multiple resources, `deny` takes precedence over `ask`, and `ask` takes precedence over `allow`.

Requests without a matching rule default to `allow`. Built-in permissions also allow external-directory access and `.env` reads; only explicit `ask` rules produce permission prompts for those operations.

The evaluation order is:

1. Load the selected agent's configured rules.
2. Reject the request if any resource has an explicit `deny` result.
3. Include saved project approvals.
4. Evaluate every requested resource.
5. Execute immediately when the result is `allow`.
6. Treat `ask` as `allow` when `OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1`.
7. Otherwise publish a pending request and wait for `once`, `always`, or `reject`.

Automatic approval does not override `deny`. This is especially important in Plan mode, where edit operations are explicitly denied. Enabling automatic permissions therefore does not make Plan mode writable.

Automatic approval also does not write a saved approval to the project database. The environment variable remains the source of authorization for subsequent requests while that process is running.

### Example Rules

```json
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "bash": {
      "*": "ask",
      "git status*": "allow",
      "rm *": "deny"
    },
    "edit": "deny"
  }
}
```

With automatic permission approval enabled:

- `git status` is allowed by configuration.
- An unmatched command that resolves to `ask` is automatically allowed.
- `rm -rf build` remains denied.
- File edits remain denied.

## Recommendation Workflow

Recommendations are represented by option order and labels rather than a dedicated schema field. Agents should put the preferred option first and end its label with `(Recommended)`.

```json
{
  "question": "How should this be deployed?",
  "header": "Deployment",
  "options": [
    {
      "label": "Staging first (Recommended)",
      "description": "Validate the release before production"
    },
    {
      "label": "Production now",
      "description": "Deploy immediately"
    }
  ]
}
```

When `OPENCODE_QUESTION_AUTO_RECOMMEND=1`, each question is answered as follows:

1. Select the first option whose label ends in `(Recommended)`, ignoring case.
2. If no option is marked, select the first option.
3. If the question has no options, reject the question.

The workflow selects one answer per question, including questions that permit multiple selections. It does not infer additional choices from descriptions or ask a model to rank the options.

The `question` tool is itself permission-controlled. Its complete automated flow is:

1. Evaluate the `question` permission.
2. Stop if `question` is explicitly denied.
3. Automatically allow an `ask` result when permission automation is enabled.
4. Select the recommended or first option when recommendation automation is enabled.
5. Return the selected labels to the model so execution can continue.

If recommendation automation is disabled, OpenCode publishes the question to the App, TUI, CLI, or ACP client and waits for a user response.

## Legacy Compatibility

OpenCode currently contains current Core and legacy runtime paths.

| Variable                                  | Runtime            | Behavior                                                                             |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `OPENCODE_PERMISSION_AUTO_ALLOW_ALWAYS=1` | Current and legacy | Automatically allows requests that would otherwise ask; explicit denials still apply |
| `OPENCODE_QUESTION_AUTO_RECOMMEND=1`      | Current and legacy | Selects a marked recommendation, falling back to the first option                    |

## Events and Persistence

Interactive permission and question requests are process-local pending operations backed by in-memory deferred results.

- Interactive requests publish asked and replied or rejected events.
- Automatically handled requests do not create pending prompts.
- Restarting the server cannot resume a previously blocked in-memory operation.
- Manual `always` permission replies can create project-scoped saved approvals in the current Core runtime.
- Environment-driven automatic permission approval does not create those saved rows.

## Security Boundary

The permission system is a policy and confirmation layer, not a sandbox. In particular, approved shell commands run with the operating-system authority of the OpenCode process.

Only enable automatic permission approval when you trust:

- the active agent and model
- the repository instructions and content
- installed plugins, skills, and MCP servers
- every command and filesystem operation the process may perform

Use a container or virtual machine when actual isolation is required.

## Implementation References

- Current permission evaluation: `packages/core/src/permission.ts`
- Current question automation: `packages/core/src/question.ts`
- Question tool and recommendation convention: `packages/core/src/tool/question.ts`
- Current built-in agent permissions: `packages/core/src/plugin/agent.ts`
- Legacy permission handling: `packages/opencode/src/permission/index.ts`
- Legacy safe question selection: `packages/opencode/src/question/index.ts`
- Permission configuration guide: `packages/web/src/content/docs/permissions.mdx`
- Security model: `SECURITY.md`
