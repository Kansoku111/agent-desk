# Third-Party Notices

This project includes third-party software. The table inventories every non-development package record in `package-lock.json` (including optional platform-specific alternatives) and the transitive packages used by the Vite-bundled UI roots: React, React DOM, React Markdown, remark-gfm, Lucide React, xterm addons/core, and diff. Build-only tools and type packages are not shipped in `web/dist` and are omitted unless also part of the runtime graph.

Platform-specific optional packages are installed only for matching operating systems/architectures. Repository URLs come from each installed package manifest; for uninstalled platform alternatives, the related package repository is reused. If a package publishes no repository URL, its npm registry page is shown.

**Inventory source:** `package-lock.json` (lockfile version 3); lock rows are grouped by package name, version, and SPDX license expression. `Runtime` means reachable from production dependencies; `Bundled UI` means reachable from the selected browser bundle roots.

| Package | Version | License | Repository | Included as |
|---|---:|---|---|---|
| `@agentclientprotocol/sdk` | 1.4.0 | `Apache-2.0` | <https://github.com/agentclientprotocol/typescript-sdk> | Runtime |
| `@anthropic-ai/sdk` | 0.124.0 | `MIT` | <https://github.com/anthropics/anthropic-sdk-typescript> | Runtime |
| `@anthropic-ai/sdk` | 0.129.0 | `MIT` | <https://github.com/anthropics/anthropic-sdk-typescript> | Runtime |
| `@aws-sdk/client-bedrock-runtime` | 3.1127.0 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/core` | 3.978.1 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-env` | 3.972.72 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-http` | 3.972.74 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-ini` | 3.973.17 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-login` | 3.972.79 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-node` | 3.972.84 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-process` | 3.972.72 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-sso` | 3.973.16 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/credential-provider-web-identity` | 3.972.78 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/eventstream-handler-node` | 3.972.35 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/middleware-eventstream` | 3.972.30 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/middleware-websocket` | 3.972.54 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/nested-clients` | 3.997.46 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/signature-v4-multi-region` | 3.996.47 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/token-providers` | 3.1127.0 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/token-providers` | 3.1138.0 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/types` | 3.974.6 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws-sdk/xml-builder` | 3.972.41 | `Apache-2.0` | <https://github.com/aws/aws-sdk-js-v3> | Runtime |
| `@aws/lambda-invoke-store` | 0.3.0 | `Apache-2.0` | <https://github.com/awslabs/aws-lambda-invoke-store> | Runtime |
| `@babel/code-frame` | 7.29.7 | `MIT` | <https://github.com/babel/babel> | Runtime |
| `@babel/helper-validator-identifier` | 7.29.7 | `MIT` | <https://github.com/babel/babel> | Runtime |
| `@babel/runtime` | 7.29.10 | `MIT` | <https://github.com/babel/babel> | Runtime |
| `@deepseek-ai/cordis` | 4.0.5 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/cordis-plugin-group` | 1.0.5 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/cordis-plugin-include` | 1.0.10 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.6 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.7 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/cosmokit` | 1.8.6 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-acp` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-acp-app` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-default-model` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-instructions` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-loop` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-preset` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-preset-registry` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-agent-tool-presentation` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-anonymous-user-id` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-account-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-gateway` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-job-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-remote-access` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-remotes` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-session-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-settings-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-terminal-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-workspace-controller` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-api-workspace-files` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-app-boot` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-atomic-write` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-attachment` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-attachment-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-authorization` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-base` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-bash-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-bash-sandbox` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-brand` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-chunked-list` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-connection` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-file-upload` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-hmr` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-locale` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-modules` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-product-analytics` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-resources` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-shortcuts` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-agent-preset` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-approval` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-attachment` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-brand-official` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-chat` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-commands` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-conversation` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-cordis` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-deliverables` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-directory-picker-browse` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-directory-picker-native` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-goal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-input-trigger` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-jobs` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-layout` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-message-feedback` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-model-selection` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-open-in-app` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-permission-presets` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-plan` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-plugin-market` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-reference` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-renderer` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-schedule` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-secret-mask` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-session` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-account` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-agent-loop` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-general` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-models` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-session-log` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-shell` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-subagent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-settings-web-search` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-shortcuts` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-skill` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-subagent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-theme` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-tool` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-trajectory` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-user-questions` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-workflow-run` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-client-ui-workspace` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-cmdline` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-command-compact` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-command-feedback` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-command-goal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-commands` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-compaction` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-compaction-image-offload` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-config-editor` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-cordis-client-runner` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-cordis-host-runner` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-credentials` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-credentials-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-deepseek-account` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-deepseek-account-platform` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-deque` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-agent-team` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-api-speech-to-text` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-auto-review` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-client-ui-cot-translation` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-cot-translation-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-inspector` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-inspector-profile` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-ralph-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-session-inspector` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-session-search` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-session-titles-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-speech-to-text` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-tool-worktree` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-translator` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-experimental-worktree` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-file-reference` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-file-reference-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-fs` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-fs-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-fs-observation-policy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-fs-sandbox` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-goal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-goal-round-driver` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-harness-dev-context` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-headless` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-hmr` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-home-paths` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-directory-picker` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-directory-picker-auto` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-directory-picker-browse` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-directory-picker-native` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-frontend-static` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-open-in-app` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-plugin-inventory` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-product-telemetry-otel` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-host-webserver` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-http-proxy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-jobs` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-jobs-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-launch-environment` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-lazy-require` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm-deepseek` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm-deepseek-account` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm-deepseek-api-key` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-llm-retry` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-mcp-client` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-mcp-resources` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-message-feedback` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-native-command` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-office-to-pdf` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-otel` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-output-retention` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-package-manifest` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-permission-presets` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-persona` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-plan-mode` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-plugin-manager` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-plugin-market` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-plugin-market-index` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-ptc-runtime` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-ptc-runtime-node` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-pwsh-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-pwsh-sandbox` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-repeat-tool-reminder` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sandbox` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sandbox-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sandbox-policy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sandbox-windows-acl` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-schedule` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-scope` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sdk-app` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sdk-minimal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-sdk-protocol` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format-catalog` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format-v0-to-v1` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format-v1-to-v2` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format-v2-to-v3` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-log-deepseek` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-log-export` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-persistence` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-projection` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-projection-cache` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-query` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-query-sqlite` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-reference` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-stats` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-telemetry` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-telemetry-otel` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-title` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-title-all-prompts-llm` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-title-llm` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-session-turn-outline` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-settings` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-shell` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-shell-env` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-skill` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-skill-badge` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-skill-filesystem` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-skill-office` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-spill` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-spill-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-spill-policy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-storage` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-storage-domain` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-storage-json` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-subagent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-subprocess` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-subprocess-local` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-system-prompt` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-terminal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-terminal-bash` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-time-context` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-timeout` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tmux-context` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-token-meter` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-ask-user` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-bash` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-bash-persistent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-cordis` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-fs` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-fs-search` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-goal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-jobs` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-present` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-pwsh` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-ralph` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-schedule` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-session-query` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-skill` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-str-replace-editor` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-subagent` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-terminal` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-todo` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-web` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-workflow` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-working-directory` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-typert-loader` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-typert-protocol` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-typert-registry` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-user-approval` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-user-questions` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-util-code-language` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-util-crypto` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-util-time` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-util-values` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-util-workspace-path` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web-app` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web-deepseek-api` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web-fetch-http` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web-frontend` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-web-search-deepseek` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-win32-process` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-workflow` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-workflow-ptc` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-working-directory` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-workspace` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/dsh-workspace-changes` | 0.2.1-rc.2 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@deepseek-ai/libreoffice-kit` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/libreoffice-kit-darwin-x64` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/libreoffice-kit-wasm` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/libreoffice-kit-win32-arm64` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/libreoffice-kit-win32-x64` | 0.1.5 | `MPL-2.0` | <https://github.com/deepseek-ai/dsh-libreoffice-kit> | Runtime |
| `@deepseek-ai/node-addon-system` | 0.1.2 | `BSD-3-Clause` | <https://github.com/deepseek-harness/deepseek-harness> | Runtime |
| `@deepseek-ai/node-addon-system-darwin-arm64` | 0.1.2 | `BSD-3-Clause` | <https://github.com/deepseek-harness/deepseek-harness> | Runtime |
| `@deepseek-ai/node-addon-system-darwin-x64` | 0.1.2 | `BSD-3-Clause` | <https://github.com/deepseek-harness/deepseek-harness> | Runtime |
| `@deepseek-ai/node-addon-system-linux-arm64` | 0.1.2 | `BSD-3-Clause` | <https://github.com/deepseek-harness/deepseek-harness> | Runtime |
| `@deepseek-ai/node-addon-system-linux-x64` | 0.1.2 | `BSD-3-Clause` | <https://github.com/deepseek-harness/deepseek-harness> | Runtime |
| `@deepseek-ai/schemastery` | 3.18.5 | `MIT` | <https://github.com/deepseek-ai/deepseek-harness> | Runtime |
| `@earendil-works/pi-ai` | 0.87.1 | `MIT` | <https://github.com/earendil-works/pi> | Runtime |
| `@earendil-works/pi-ai` | 1.3.0 | `MIT` | <https://github.com/earendil-works/pi> | Runtime |
| `@earendil-works/pi-telemetry` | 0.87.1 | `MIT` | <https://github.com/earendil-works/pi> | Runtime |
| `@earendil-works/pi-telemetry` | 1.3.0 | `MIT` | <https://github.com/earendil-works/pi> | Runtime |
| `@emnapi/runtime` | 1.11.3 | `MIT` | <https://github.com/toyobayashi/emnapi> | Runtime |
| `@eslint-community/regexpp` | 4.12.2 | `MIT` | <https://github.com/eslint-community/regexpp> | Runtime |
| `@google/genai` | 2.21.0 | `Apache-2.0` | <https://github.com/googleapis/js-genai> | Runtime |
| `@img/colour` | 1.1.0 | `MIT` | <https://github.com/lovell/colour> | Runtime |
| `@img/sharp-darwin-arm64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-darwin-x64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-freebsd-wasm32` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | `LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-arm` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-arm64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-ppc64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-riscv64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-s390x` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linux-x64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linuxmusl-arm64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-linuxmusl-x64` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-wasm32` | 0.35.5 | `Apache-2.0 AND LGPL-3.0-or-later AND MIT` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-webcontainers-wasm32` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-win32-arm64` | 0.35.5 | `Apache-2.0 AND LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-win32-ia32` | 0.35.5 | `Apache-2.0 AND LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@img/sharp-win32-x64` | 0.35.5 | `Apache-2.0 AND LGPL-3.0-or-later` | <https://github.com/lovell/sharp> | Runtime |
| `@joplin/turndown-plugin-gfm` | 1.0.68 | `MIT` | <https://github.com/laurent22/joplin-turndown-plugin-gfm> | Runtime |
| `@js-temporal/polyfill` | 0.5.1 | `ISC` | <https://github.com/js-temporal/temporal-polyfill> | Runtime |
| `@keyv/serialize` | 1.1.1 | `MIT` | <https://github.com/jaredwray/keyv> | Runtime |
| `@koromix/koffi-darwin-arm64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-darwin-x64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-freebsd-arm64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-freebsd-ia32` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-freebsd-x64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-linux-arm64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-linux-ia32` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-linux-loong64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-linux-riscv64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-linux-x64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-openbsd-ia32` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-openbsd-x64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-win32-arm64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-win32-ia32` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@koromix/koffi-win32-x64` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `@mixmark-io/domino` | 2.2.0 | `BSD-2-Clause` | <https://github.com/mixmark-io/domino> | Runtime |
| `@modelcontextprotocol/client` | 2.2.0 | `MIT` | <https://github.com/modelcontextprotocol/typescript-sdk> | Runtime |
| `@modelcontextprotocol/core` | 2.2.0 | `MIT` | <https://github.com/modelcontextprotocol/typescript-sdk> | Runtime |
| `@openai/codex` | 0.163.0 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-darwin-arm64` | 0.163.0-darwin-arm64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-darwin-x64` | 0.163.0-darwin-x64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-linux-arm64` | 0.163.0-linux-arm64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-linux-x64` | 0.163.0-linux-x64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-win32-arm64` | 0.163.0-win32-arm64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@openai/codex-win32-x64` | 0.163.0-win32-x64 | `Apache-2.0` | <https://github.com/openai/codex> | Runtime |
| `@opentelemetry/api` | 1.9.1 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/api-logs` | 0.222.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/core` | 2.11.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/otlp-exporter-base` | 0.222.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/otlp-transformer` | 0.222.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/resources` | 2.11.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/sdk-logs` | 0.222.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/sdk-metrics` | 2.11.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/sdk-trace` | 2.11.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@opentelemetry/semantic-conventions` | 1.43.0 | `Apache-2.0` | <https://github.com/open-telemetry/opentelemetry-js> | Runtime |
| `@protobufjs/aspromise` | 1.1.2 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/base64` | 1.1.2 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/codegen` | 2.0.5 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/eventemitter` | 1.1.1 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/fetch` | 1.1.1 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/float` | 1.0.2 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/path` | 1.1.2 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/pool` | 1.1.0 | `BSD-3-Clause` | <https://github.com/dcodeIO/protobuf.js> | Runtime |
| `@protobufjs/utf8` | 1.1.2 | `BSD-3-Clause` | <https://github.com/protobufjs/protobuf.js> | Runtime |
| `@sec-ant/readable-stream` | 0.4.1 | `MIT` | <https://github.com/Sec-ant/readable-stream> | Runtime |
| `@sindresorhus/is` | 7.2.0 | `MIT` | <https://github.com/sindresorhus/is> | Runtime |
| `@sindresorhus/merge-streams` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/merge-streams> | Runtime |
| `@smithy/core` | 3.35.1 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@smithy/credential-provider-imds` | 4.5.2 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@smithy/fetch-http-handler` | 5.8.0 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@smithy/node-http-handler` | 4.12.1 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@smithy/signature-v4` | 5.7.4 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@smithy/types` | 4.19.0 | `Apache-2.0` | <https://github.com/smithy-lang/smithy-typescript> | Runtime |
| `@stablelib/base64` | 1.0.1 | `MIT` | <https://github.com/StableLib/stablelib> | Runtime |
| `@standard-schema/spec` | 1.1.0 | `MIT` | <https://github.com/standard-schema/standard-schema> | Runtime |
| `@swc/helpers` | 0.5.23 | `Apache-2.0` | <https://github.com/swc-project/swc> | Runtime |
| `@types/debug` | 4.1.13 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/estree` | 1.0.9 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/estree-jsx` | 1.0.5 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/hast` | 3.0.5 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/http-cache-semantics` | 4.2.0 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Runtime |
| `@types/mdast` | 4.0.4 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/ms` | 2.1.0 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/node` | 26.6.4 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Runtime |
| `@types/react` | 19.3.0 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/retry` | 0.12.0 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Runtime |
| `@types/unist` | 2.0.11 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@types/unist` | 3.0.3 | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped> | Bundled UI |
| `@ungap/structured-clone` | 1.4.0 | `ISC` | <https://github.com/ungap/structured-clone> | Bundled UI |
| `@vscode/ripgrep` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-darwin-arm64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-darwin-x64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-arm` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-arm64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-ia32` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-ppc64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-riscv64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-s390x` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-linux-x64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-win32-arm64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-win32-ia32` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@vscode/ripgrep-win32-x64` | 1.18.0 | `MIT` | <https://github.com/microsoft/vscode-ripgrep> | Runtime |
| `@xterm/addon-fit` | 0.11.0 | `MIT` | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit> | Bundled UI |
| `@xterm/addon-serialize` | 0.14.0 | `MIT` | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize> | Runtime |
| `@xterm/addon-unicode11` | 0.9.0 | `MIT` | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11> | Runtime |
| `@xterm/addon-web-links` | 0.12.0 | `MIT` | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links> | Bundled UI |
| `@xterm/headless` | 6.0.0 | `MIT` | <https://github.com/xtermjs/xterm.js> | Runtime |
| `@xterm/xterm` | 6.0.0 | `MIT` | <https://github.com/xtermjs/xterm.js> | Bundled UI |
| `agent-base` | 7.1.4 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `agent-base` | 9.0.0 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `ajv` | 8.20.0 | `MIT` | <https://github.com/ajv-validator/ajv> | Runtime |
| `ansi-regex` | 5.0.1 | `MIT` | <https://github.com/chalk/ansi-regex> | Runtime |
| `ansi-styles` | 4.3.0 | `MIT` | <https://github.com/chalk/ansi-styles> | Runtime |
| `argparse` | 2.0.1 | `Python-2.0` | <https://github.com/nodeca/argparse> | Runtime |
| `bail` | 2.0.2 | `MIT` | <https://github.com/wooorm/bail> | Bundled UI |
| `base64-js` | 1.5.1 | `MIT` | <https://github.com/beatgammit/base64-js> | Runtime |
| `bignumber.js` | 9.3.1 | `MIT` | <https://github.com/MikeMcl/bignumber.js> | Runtime |
| `bowser` | 2.14.1 | `MIT` | <https://github.com/bowser-js/bowser> | Runtime |
| `brotli` | 1.3.3 | `MIT` | <https://github.com/devongovett/brotli.js> | Runtime |
| `buffer-equal-constant-time` | 1.0.1 | `BSD-3-Clause` | <https://github.com/goinstant/buffer-equal-constant-time> | Runtime |
| `bundle-name` | 4.1.1 | `MIT` | <https://github.com/sindresorhus/bundle-name> | Runtime |
| `byte-counter` | 0.1.0 | `MIT` | <https://github.com/sindresorhus/byte-counter> | Runtime |
| `bytes` | 3.1.2 | `MIT` | <https://github.com/visionmedia/bytes.js> | Runtime |
| `cacheable-lookup` | 7.0.0 | `MIT` | <https://github.com/szmarczak/cacheable-lookup> | Runtime |
| `cacheable-request` | 13.0.19 | `MIT` | <https://github.com/jaredwray/cacheable> | Runtime |
| `camelcase` | 5.3.1 | `MIT` | <https://github.com/sindresorhus/camelcase> | Runtime |
| `ccount` | 2.0.1 | `MIT` | <https://github.com/wooorm/ccount> | Bundled UI |
| `character-entities` | 2.0.2 | `MIT` | <https://github.com/wooorm/character-entities> | Bundled UI |
| `character-entities-html4` | 2.1.0 | `MIT` | <https://github.com/wooorm/character-entities-html4> | Bundled UI |
| `character-entities-legacy` | 3.0.0 | `MIT` | <https://github.com/wooorm/character-entities-legacy> | Bundled UI |
| `character-reference-invalid` | 2.0.1 | `MIT` | <https://github.com/wooorm/character-reference-invalid> | Bundled UI |
| `chokidar` | 5.0.0 | `MIT` | <https://github.com/paulmillr/chokidar> | Runtime |
| `chrome-devtools-mcp` | 1.10.1 | `Apache-2.0` | <https://github.com/ChromeDevTools/chrome-devtools-mcp> | Runtime |
| `cliui` | 6.0.0 | `ISC` | <http://github.com/yargs/cliui> | Runtime |
| `clone` | 2.1.2 | `MIT` | <https://github.com/pvorb/node-clone> | Runtime |
| `color-convert` | 2.0.1 | `MIT` | <https://github.com/Qix-/color-convert> | Runtime |
| `color-name` | 1.1.4 | `MIT` | <https://github.com/colorjs/color-name> | Runtime |
| `comma-separated-tokens` | 2.0.3 | `MIT` | <https://github.com/wooorm/comma-separated-tokens> | Bundled UI |
| `commander` | 15.0.0 | `MIT` | <https://github.com/tj/commander.js> | Runtime |
| `compressible` | 2.0.18 | `MIT` | <https://github.com/jshttp/compressible> | Runtime |
| `compression` | 1.8.2 | `MIT` | <https://github.com/expressjs/compression> | Runtime |
| `content-type` | 2.1.0 | `MIT` | <https://github.com/jshttp/content-type> | Runtime |
| `cross-spawn` | 7.0.6 | `MIT` | <https://github.com/moxystudio/node-cross-spawn> | Runtime |
| `csstype` | 3.2.3 | `MIT` | <https://github.com/frenic/csstype> | Bundled UI |
| `data-uri-to-buffer` | 4.0.1 | `MIT` | <https://github.com/TooTallNate/node-data-uri-to-buffer> | Runtime |
| `debug` | 2.6.9 | `MIT` | <https://github.com/visionmedia/debug> | Runtime |
| `debug` | 4.4.3 | `MIT` | <https://github.com/debug-js/debug> | Runtime; bundled UI |
| `decamelize` | 1.2.0 | `MIT` | <https://github.com/sindresorhus/decamelize> | Runtime |
| `decode-named-character-reference` | 1.3.0 | `MIT` | <https://github.com/wooorm/decode-named-character-reference> | Bundled UI |
| `decompress-response` | 10.0.0 | `MIT` | <https://github.com/sindresorhus/decompress-response> | Runtime |
| `default-browser` | 5.5.1 | `MIT` | <https://github.com/sindresorhus/default-browser> | Runtime |
| `default-browser-id` | 5.0.1 | `MIT` | <https://github.com/sindresorhus/default-browser-id> | Runtime |
| `define-lazy-prop` | 3.0.0 | `MIT` | <https://github.com/sindresorhus/define-lazy-prop> | Runtime |
| `depd` | 2.0.0 | `MIT` | <https://github.com/dougwilson/nodejs-depd> | Runtime |
| `dequal` | 2.0.3 | `MIT` | <https://github.com/lukeed/dequal> | Bundled UI |
| `destroy` | 1.2.0 | `MIT` | <https://github.com/stream-utils/destroy> | Runtime |
| `detect-libc` | 2.1.2 | `Apache-2.0` | <https://github.com/lovell/detect-libc> | Runtime |
| `devlop` | 1.1.0 | `MIT` | <https://github.com/wooorm/devlop> | Bundled UI |
| `dfa` | 1.2.0 | `MIT` | <https://github.com/devongovett/dfa> | Runtime |
| `diff` | 8.0.4 | `BSD-3-Clause` | <https://github.com/kpdecker/jsdiff> | Bundled UI |
| `diff` | 9.0.0 | `BSD-3-Clause` | <https://github.com/kpdecker/jsdiff> | Runtime |
| `dijkstrajs` | 1.0.3 | `MIT` | <https://github.com/tcort/dijkstrajs> | Runtime |
| `ecdsa-sig-formatter` | 1.0.11 | `Apache-2.0` | <https://github.com/Brightspace/node-ecdsa-sig-formatter> | Runtime |
| `ee-first` | 1.1.1 | `MIT` | <https://github.com/jonathanong/ee-first> | Runtime |
| `emoji-regex` | 8.0.0 | `MIT` | <https://github.com/mathiasbynens/emoji-regex> | Runtime |
| `encodeurl` | 2.0.0 | `MIT` | <https://github.com/pillarjs/encodeurl> | Runtime |
| `escape-html` | 1.0.3 | `MIT` | <https://github.com/component/escape-html> | Runtime |
| `escape-string-regexp` | 5.0.0 | `MIT` | <https://github.com/sindresorhus/escape-string-regexp> | Bundled UI |
| `estree-util-is-identifier-name` | 3.0.0 | `MIT` | <https://github.com/syntax-tree/estree-util-is-identifier-name> | Bundled UI |
| `etag` | 1.8.1 | `MIT` | <https://github.com/jshttp/etag> | Runtime |
| `eventsource` | 3.0.7 | `MIT` | <https://github.com/EventSource/eventsource> | Runtime |
| `eventsource-parser` | 3.1.1 | `MIT` | <https://github.com/rexxars/eventsource-parser> | Runtime |
| `execa` | 10.1.1 | `MIT` | <https://github.com/sindresorhus/execa> | Runtime |
| `extend` | 3.0.2 | `MIT` | <https://github.com/justmoon/node-extend> | Runtime; bundled UI |
| `fast-deep-equal` | 3.1.3 | `MIT` | <https://github.com/epoberezkin/fast-deep-equal> | Runtime |
| `fast-sha256` | 1.3.0 | `Unlicense` | <https://github.com/dchest/fast-sha256-js> | Runtime |
| `fast-uri` | 3.1.8 | `BSD-3-Clause` | <https://github.com/fastify/fast-uri> | Runtime |
| `fetch-blob` | 3.2.0 | `MIT` | <https://github.com/node-fetch/fetch-blob> | Runtime |
| `fflate` | 0.8.2 | `MIT` | <https://github.com/101arrowz/fflate> | Runtime |
| `fflate` | 0.8.3 | `MIT` | <https://github.com/101arrowz/fflate> | Runtime |
| `figures` | 6.1.0 | `MIT` | <https://github.com/sindresorhus/figures> | Runtime |
| `find-up` | 4.1.0 | `MIT` | <https://github.com/sindresorhus/find-up> | Runtime |
| `fontkit` | 2.0.4 | `MIT` | <https://github.com/foliojs/fontkit> | Runtime |
| `form-data-encoder` | 4.1.0 | `MIT` | <https://github.com/octet-stream/form-data-encoder> | Runtime |
| `formdata-polyfill` | 4.0.10 | `MIT` | <https://jimmywarting@github.com/jimmywarting/FormData> | Runtime |
| `fresh` | 2.0.0 | `MIT` | <https://github.com/jshttp/fresh> | Runtime |
| `gaxios` | 7.3.1 | `Apache-2.0` | <https://github.com/googleapis/google-cloud-node> | Runtime |
| `gcp-metadata` | 8.1.2 | `Apache-2.0` | <https://github.com/googleapis/google-cloud-node-core> | Runtime |
| `get-caller-file` | 2.0.5 | `ISC` | <https://github.com/stefanpenner/get-caller-file> | Runtime |
| `get-stream` | 9.0.1 | `MIT` | <https://github.com/sindresorhus/get-stream> | Runtime |
| `google-auth-library` | 10.9.1 | `Apache-2.0` | <https://github.com/googleapis/google-cloud-node> | Runtime |
| `google-logging-utils` | 1.1.3 | `Apache-2.0` | <https://github.com/googleapis/google-cloud-node-core> | Runtime |
| `got` | 14.6.6 | `MIT` | <https://github.com/sindresorhus/got> | Runtime |
| `hast-util-to-jsx-runtime` | 2.3.6 | `MIT` | <https://github.com/syntax-tree/hast-util-to-jsx-runtime> | Bundled UI |
| `hast-util-whitespace` | 3.0.0 | `MIT` | <https://github.com/syntax-tree/hast-util-whitespace> | Bundled UI |
| `html-url-attributes` | 3.0.1 | `MIT` | <https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes> | Bundled UI |
| `http-cache-semantics` | 4.3.0 | `BSD-2-Clause` | <https://github.com/kornelski/http-cache-semantics> | Runtime |
| `http-errors` | 2.0.1 | `MIT` | <https://github.com/jshttp/http-errors> | Runtime |
| `http-proxy-agent` | 9.1.0 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `http2-wrapper` | 2.2.1 | `MIT` | <https://github.com/szmarczak/http2-wrapper> | Runtime |
| `https-proxy-agent` | 7.0.6 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `https-proxy-agent` | 9.1.0 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `human-signals` | 8.0.1 | `Apache-2.0` | <https://github.com/ehmicky/human-signals> | Runtime |
| `inherits` | 2.0.4 | `ISC` | <https://github.com/isaacs/inherits> | Runtime |
| `inline-style-parser` | 0.2.7 | `MIT` | <https://github.com/remarkablemark/inline-style-parser> | Bundled UI |
| `ipaddr.js` | 2.5.0 | `MIT` | <https://github.com/whitequark/ipaddr.js> | Runtime |
| `is-alphabetical` | 2.0.1 | `MIT` | <https://github.com/wooorm/is-alphabetical> | Bundled UI |
| `is-alphanumerical` | 2.0.1 | `MIT` | <https://github.com/wooorm/is-alphanumerical> | Bundled UI |
| `is-decimal` | 2.0.1 | `MIT` | <https://github.com/wooorm/is-decimal> | Bundled UI |
| `is-docker` | 3.0.0 | `MIT` | <https://github.com/sindresorhus/is-docker> | Runtime |
| `is-fullwidth-code-point` | 3.0.0 | `MIT` | <https://github.com/sindresorhus/is-fullwidth-code-point> | Runtime |
| `is-hexadecimal` | 2.0.1 | `MIT` | <https://github.com/wooorm/is-hexadecimal> | Bundled UI |
| `is-in-ssh` | 1.0.0 | `MIT` | <https://github.com/sindresorhus/is-in-ssh> | Runtime |
| `is-inside-container` | 1.0.0 | `MIT` | <https://github.com/sindresorhus/is-inside-container> | Runtime |
| `is-plain-obj` | 4.1.0 | `MIT` | <https://github.com/sindresorhus/is-plain-obj> | Runtime; bundled UI |
| `is-stream` | 4.0.1 | `MIT` | <https://github.com/sindresorhus/is-stream> | Runtime |
| `is-unicode-supported` | 2.1.0 | `MIT` | <https://github.com/sindresorhus/is-unicode-supported> | Runtime |
| `is-wsl` | 3.1.1 | `MIT` | <https://github.com/sindresorhus/is-wsl> | Runtime |
| `isexe` | 2.0.0 | `ISC` | <https://github.com/isaacs/isexe> | Runtime |
| `jose` | 6.2.12 | `MIT` | <https://github.com/panva/jose> | Runtime |
| `js-tokens` | 4.0.0 | `MIT` | <https://github.com/lydell/js-tokens> | Runtime |
| `js-yaml` | 4.3.2 | `MIT` | <https://github.com/nodeca/js-yaml> | Runtime |
| `jsbi` | 4.3.2 | `Apache-2.0` | <https://github.com/GoogleChromeLabs/jsbi> | Runtime |
| `json-bigint` | 1.0.0 | `MIT` | <https://github.com/sidorares/json-bigint> | Runtime |
| `json-schema-to-ts` | 3.1.1 | `MIT` | <https://github.com/ThomasAribart/json-schema-to-ts> | Runtime |
| `json-schema-traverse` | 1.0.0 | `MIT` | <https://github.com/epoberezkin/json-schema-traverse> | Runtime |
| `jwa` | 2.0.1 | `MIT` | <https://github.com/brianloveswords/node-jwa> | Runtime |
| `jws` | 4.0.1 | `MIT` | <https://github.com/brianloveswords/node-jws> | Runtime |
| `keyv` | 5.6.0 | `MIT` | <https://github.com/jaredwray/keyv> | Runtime |
| `koffi` | 3.1.1 | `MIT` | <https://github.com/Koromix/koffi> | Runtime |
| `locate-path` | 5.0.0 | `MIT` | <https://github.com/sindresorhus/locate-path> | Runtime |
| `long` | 5.3.2 | `Apache-2.0` | <https://github.com/dcodeIO/long.js> | Runtime |
| `longest-streak` | 3.1.0 | `MIT` | <https://github.com/wooorm/longest-streak> | Bundled UI |
| `lowercase-keys` | 3.0.0 | `MIT` | <https://github.com/sindresorhus/lowercase-keys> | Runtime |
| `lucide-react` | 1.52.0 | `ISC` | <https://github.com/lucide-icons/lucide> | Bundled UI |
| `markdown-table` | 3.0.4 | `MIT` | <https://github.com/wooorm/markdown-table> | Bundled UI |
| `mdast-util-find-and-replace` | 3.0.3 | `MIT` | <https://github.com/syntax-tree/mdast-util-find-and-replace> | Bundled UI |
| `mdast-util-from-markdown` | 2.1.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-from-markdown> | Bundled UI |
| `mdast-util-gfm` | 3.1.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm> | Bundled UI |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm-autolink-literal> | Bundled UI |
| `mdast-util-gfm-footnote` | 2.1.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm-footnote> | Bundled UI |
| `mdast-util-gfm-strikethrough` | 2.0.1 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm-strikethrough> | Bundled UI |
| `mdast-util-gfm-table` | 2.0.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm-table> | Bundled UI |
| `mdast-util-gfm-task-list-item` | 2.0.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-gfm-task-list-item> | Bundled UI |
| `mdast-util-mdx-expression` | 2.0.1 | `MIT` | <https://github.com/syntax-tree/mdast-util-mdx-expression> | Bundled UI |
| `mdast-util-mdx-jsx` | 3.2.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-mdx-jsx> | Bundled UI |
| `mdast-util-mdxjs-esm` | 2.0.1 | `MIT` | <https://github.com/syntax-tree/mdast-util-mdxjs-esm> | Bundled UI |
| `mdast-util-phrasing` | 4.1.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-phrasing> | Bundled UI |
| `mdast-util-to-hast` | 13.2.1 | `MIT` | <https://github.com/syntax-tree/mdast-util-to-hast> | Bundled UI |
| `mdast-util-to-markdown` | 2.2.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-to-markdown> | Bundled UI |
| `mdast-util-to-string` | 4.0.0 | `MIT` | <https://github.com/syntax-tree/mdast-util-to-string> | Bundled UI |
| `micromark` | 4.0.3 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark> | Bundled UI |
| `micromark-core-commonmark` | 2.0.4 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark> | Bundled UI |
| `micromark-extension-gfm` | 3.0.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm> | Bundled UI |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-autolink-literal> | Bundled UI |
| `micromark-extension-gfm-footnote` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-footnote> | Bundled UI |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-strikethrough> | Bundled UI |
| `micromark-extension-gfm-table` | 2.1.2 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-table> | Bundled UI |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-tagfilter> | Bundled UI |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark-extension-gfm-task-list-item> | Bundled UI |
| `micromark-factory-destination` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination> | Bundled UI |
| `micromark-factory-label` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label> | Bundled UI |
| `micromark-factory-space` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space> | Bundled UI |
| `micromark-factory-title` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title> | Bundled UI |
| `micromark-factory-whitespace` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace> | Bundled UI |
| `micromark-util-character` | 2.1.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-character> | Bundled UI |
| `micromark-util-chunked` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked> | Bundled UI |
| `micromark-util-classify-character` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character> | Bundled UI |
| `micromark-util-combine-extensions` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions> | Bundled UI |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference> | Bundled UI |
| `micromark-util-decode-string` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string> | Bundled UI |
| `micromark-util-edit-map` | 1.0.0 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-edit-map> | Bundled UI |
| `micromark-util-encode` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode> | Bundled UI |
| `micromark-util-html-tag-name` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name> | Bundled UI |
| `micromark-util-normalize-identifier` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier> | Bundled UI |
| `micromark-util-resolve-all` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all> | Bundled UI |
| `micromark-util-sanitize-uri` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri> | Bundled UI |
| `micromark-util-subtokenize` | 2.1.0 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize> | Bundled UI |
| `micromark-util-symbol` | 2.0.1 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol> | Bundled UI |
| `micromark-util-types` | 2.0.3 | `MIT` | <https://github.com/micromark/micromark/tree/main/packages/micromark-util-types> | Bundled UI |
| `mime-db` | 1.54.0 | `MIT` | <https://github.com/jshttp/mime-db> | Runtime |
| `mime-types` | 3.0.2 | `MIT` | <https://github.com/jshttp/mime-types> | Runtime |
| `mimic-response` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/mimic-response> | Runtime |
| `minisearch` | 7.2.0 | `MIT` | <https://github.com/lucaong/minisearch> | Runtime |
| `ms` | 2.0.0 | `MIT` | <https://github.com/zeit/ms> | Runtime |
| `ms` | 2.1.3 | `MIT` | <https://github.com/vercel/ms> | Runtime; bundled UI |
| `negotiator` | 0.6.4 | `MIT` | <https://github.com/jshttp/negotiator> | Runtime |
| `negotiator` | 1.1.0 | `MIT` | <https://github.com/jshttp/negotiator> | Runtime |
| `node-addon-api` | 7.1.1 | `MIT` | <https://github.com/nodejs/node-addon-api> | Runtime |
| `node-addon-native-custom-loader` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-darwin-arm64` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-darwin-x64` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-linux-arm64-gnu` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-linux-arm64-musl` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-linux-x64-gnu` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-linux-x64-musl` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-win32-arm64-msvc` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-win32-ia32-msvc` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-addon-require-builtin-win32-x64-msvc` | 0.1.9 | `MIT` | <https://github.com/deepseek-ai/dsh-node-addon-require-builtin> | Runtime |
| `node-domexception` | 1.0.0 | `MIT` | <https://github.com/jimmywarting/node-domexception> | Runtime |
| `node-fetch` | 3.3.2 | `MIT` | <https://github.com/node-fetch/node-fetch> | Runtime |
| `node-pty` | 1.2.0-beta.15 | `MIT` | <https://github.com/microsoft/node-pty> | Runtime |
| `normalize-url` | 8.1.1 | `MIT` | <https://github.com/sindresorhus/normalize-url> | Runtime |
| `npm-run-path` | 6.0.0 | `MIT` | <https://github.com/sindresorhus/npm-run-path> | Runtime |
| `on-finished` | 2.4.1 | `MIT` | <https://github.com/jshttp/on-finished> | Runtime |
| `on-headers` | 1.1.0 | `MIT` | <https://github.com/jshttp/on-headers> | Runtime |
| `open` | 11.0.4 | `MIT` | <https://github.com/sindresorhus/open> | Runtime |
| `openai` | 6.40.0 | `Apache-2.0` | <https://github.com/openai/openai-node> | Runtime |
| `openai` | 7.19.0 | `Apache-2.0` | <https://github.com/openai/openai-node> | Runtime |
| `p-cancelable` | 4.0.1 | `MIT` | <https://github.com/sindresorhus/p-cancelable> | Runtime |
| `p-limit` | 2.3.0 | `MIT` | <https://github.com/sindresorhus/p-limit> | Runtime |
| `p-limit` | 7.3.3 | `MIT` | <https://github.com/sindresorhus/p-limit> | Runtime |
| `p-locate` | 4.1.0 | `MIT` | <https://github.com/sindresorhus/p-locate> | Runtime |
| `p-retry` | 4.6.2 | `MIT` | <https://github.com/sindresorhus/p-retry> | Runtime |
| `p-try` | 2.2.0 | `MIT` | <https://github.com/sindresorhus/p-try> | Runtime |
| `pako` | 0.2.9 | `MIT` | <https://github.com/nodeca/pako> | Runtime |
| `parse-entities` | 4.0.2 | `MIT` | <https://github.com/wooorm/parse-entities> | Bundled UI |
| `parse-ms` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/parse-ms> | Runtime |
| `parseurl` | 1.3.3 | `MIT` | <https://github.com/pillarjs/parseurl> | Runtime |
| `partial-json` | 0.1.7 | `MIT` | <https://github.com/promplate/partial-json-parser-js> | Runtime |
| `path-exists` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/path-exists> | Runtime |
| `path-key` | 3.1.1 | `MIT` | <https://github.com/sindresorhus/path-key> | Runtime |
| `path-key` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/path-key> | Runtime |
| `picocolors` | 1.1.1 | `ISC` | <https://github.com/alexeyraspopov/picocolors> | Runtime |
| `picomatch` | 4.0.7 | `MIT` | <https://github.com/micromatch/picomatch> | Runtime |
| `pkce-challenge` | 5.0.1 | `MIT` | <https://github.com/crouchcd/pkce-challenge> | Runtime |
| `pngjs` | 5.0.0 | `MIT` | <https://github.com/lukeapage/pngjs> | Runtime |
| `powershell-utils` | 0.2.1 | `MIT` | <https://github.com/sindresorhus/powershell-utils> | Runtime |
| `pretty-ms` | 9.3.1 | `MIT` | <https://github.com/sindresorhus/pretty-ms> | Runtime |
| `property-information` | 7.2.0 | `MIT` | <https://github.com/wooorm/property-information> | Bundled UI |
| `protobufjs` | 7.6.6 | `BSD-3-Clause` | <https://github.com/protobufjs/protobuf.js> | Runtime |
| `proxy-agent-negotiate` | 1.1.0 | `MIT` | <https://github.com/TooTallNate/proxy-agents> | Runtime |
| `qrcode` | 1.5.4 | `MIT` | <https://github.com/soldair/node-qrcode> | Runtime |
| `quick-lru` | 5.1.1 | `MIT` | <https://github.com/sindresorhus/quick-lru> | Runtime |
| `range-parser` | 1.3.0 | `MIT` | <https://github.com/jshttp/range-parser> | Runtime |
| `react` | 19.3.0 | `MIT` | <https://github.com/react/react> | Bundled UI |
| `react-dom` | 19.3.0 | `MIT` | <https://github.com/react/react> | Bundled UI |
| `react-markdown` | 10.1.0 | `MIT` | <https://github.com/remarkjs/react-markdown> | Bundled UI |
| `readdirp` | 5.1.1 | `MIT` | <https://github.com/paulmillr/readdirp> | Runtime |
| `remark-gfm` | 4.0.1 | `MIT` | <https://github.com/remarkjs/remark-gfm> | Bundled UI |
| `remark-parse` | 11.0.0 | `MIT` | <https://github.com/remarkjs/remark/tree/main/packages/remark-parse> | Bundled UI |
| `remark-rehype` | 11.1.2 | `MIT` | <https://github.com/remarkjs/remark-rehype> | Bundled UI |
| `remark-stringify` | 11.0.0 | `MIT` | <https://github.com/remarkjs/remark/tree/main/packages/remark-stringify> | Bundled UI |
| `require-directory` | 2.1.1 | `MIT` | <https://github.com/troygoode/node-require-directory> | Runtime |
| `require-from-string` | 2.0.2 | `MIT` | <https://github.com/floatdrop/require-from-string> | Runtime |
| `require-main-filename` | 2.0.0 | `ISC` | <https://github.com/yargs/require-main-filename> | Runtime |
| `resolve-alpn` | 1.2.1 | `MIT` | <https://github.com/szmarczak/resolve-alpn> | Runtime |
| `resolve.exports` | 2.0.4 | `MIT` | <https://github.com/lukeed/resolve.exports> | Runtime |
| `responselike` | 4.0.2 | `MIT` | <https://github.com/sindresorhus/responselike> | Runtime |
| `restructure` | 3.0.2 | `MIT` | <https://github.com/devongovett/restructure> | Runtime |
| `retry` | 0.13.1 | `MIT` | <https://github.com/tim-kos/node-retry> | Runtime |
| `run-applescript` | 7.1.0 | `MIT` | <https://github.com/sindresorhus/run-applescript> | Runtime |
| `safe-buffer` | 5.2.1 | `MIT` | <https://github.com/feross/safe-buffer> | Runtime |
| `saxes` | 6.0.0 | `ISC` | <https://github.com/lddubeau/saxes> | Runtime |
| `scheduler` | 0.28.0 | `MIT` | <https://github.com/react/react> | Bundled UI |
| `semver` | 7.8.5 | `ISC` | <https://github.com/npm/node-semver> | Runtime |
| `send` | 1.2.1 | `MIT` | <https://github.com/pillarjs/send> | Runtime |
| `serve-static` | 2.2.1 | `MIT` | <https://github.com/expressjs/serve-static> | Runtime |
| `set-blocking` | 2.0.0 | `ISC` | <https://github.com/yargs/set-blocking> | Runtime |
| `setprototypeof` | 1.2.0 | `ISC` | <https://github.com/wesleytodd/setprototypeof> | Runtime |
| `sharp` | 0.35.5 | `Apache-2.0` | <https://github.com/lovell/sharp> | Runtime |
| `shebang-command` | 2.0.0 | `MIT` | <https://github.com/kevva/shebang-command> | Runtime |
| `shebang-regex` | 3.0.0 | `MIT` | <https://github.com/sindresorhus/shebang-regex> | Runtime |
| `sherpa-onnx-darwin-arm64` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-darwin-x64` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-linux-arm64` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-linux-x64` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-node` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-win-ia32` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `sherpa-onnx-win-x64` | 1.13.8 | `Apache-2.0` | <https://github.com/csukuangfj/sherpa-onnx> | Runtime |
| `signal-exit` | 4.1.0 | `ISC` | <https://github.com/tapjs/signal-exit> | Runtime |
| `space-separated-tokens` | 2.0.2 | `MIT` | <https://github.com/wooorm/space-separated-tokens> | Bundled UI |
| `standardwebhooks` | 1.1.1 | `MIT` | <https://github.com/standard-webhooks/standard-webhooks> | Runtime |
| `statuses` | 2.0.2 | `MIT` | <https://github.com/jshttp/statuses> | Runtime |
| `string-width` | 4.2.3 | `MIT` | <https://github.com/sindresorhus/string-width> | Runtime |
| `stringify-entities` | 4.0.4 | `MIT` | <https://github.com/wooorm/stringify-entities> | Bundled UI |
| `strip-ansi` | 6.0.1 | `MIT` | <https://github.com/chalk/strip-ansi> | Runtime |
| `strip-final-newline` | 4.0.0 | `MIT` | <https://github.com/sindresorhus/strip-final-newline> | Runtime |
| `style-to-js` | 1.1.21 | `MIT` | <https://github.com/remarkablemark/style-to-js> | Bundled UI |
| `style-to-object` | 1.0.14 | `MIT` | <https://github.com/remarkablemark/style-to-object> | Bundled UI |
| `tiny-inflate` | 1.0.3 | `MIT` | <https://github.com/devongovett/tiny-inflate> | Runtime |
| `toidentifier` | 1.0.1 | `MIT` | <https://github.com/component/toidentifier> | Runtime |
| `trim-lines` | 3.0.1 | `MIT` | <https://github.com/wooorm/trim-lines> | Bundled UI |
| `trough` | 2.2.0 | `MIT` | <https://github.com/wooorm/trough> | Bundled UI |
| `ts-algebra` | 2.0.0 | `MIT` | <https://github.com/ThomasAribart/ts-algebra> | Runtime |
| `tslib` | 2.8.1 | `0BSD` | <https://github.com/Microsoft/tslib> | Runtime |
| `turndown` | 7.2.4 | `MIT` | <https://github.com/mixmark-io/turndown> | Runtime |
| `type-fest` | 4.41.0 | `(MIT OR CC0-1.0)` | <https://github.com/sindresorhus/type-fest> | Runtime |
| `typebox` | 1.3.27 | `MIT` | <https://github.com/sinclairzx81/typebox> | Runtime |
| `undici` | 8.11.2 | `MIT` | <https://github.com/nodejs/undici> | Runtime |
| `undici-types` | 8.9.0 | `MIT` | <https://github.com/nodejs/undici> | Runtime |
| `unicode-properties` | 1.4.1 | `MIT` | <https://github.com/devongovett/unicode-properties> | Runtime |
| `unicode-trie` | 2.0.0 | `MIT` | <https://github.com/devongovett/unicode-trie> | Runtime |
| `unicorn-magic` | 0.3.0 | `MIT` | <https://github.com/sindresorhus/unicorn-magic> | Runtime |
| `unified` | 11.0.5 | `MIT` | <https://github.com/unifiedjs/unified> | Bundled UI |
| `unist-util-is` | 6.0.1 | `MIT` | <https://github.com/syntax-tree/unist-util-is> | Bundled UI |
| `unist-util-position` | 5.0.0 | `MIT` | <https://github.com/syntax-tree/unist-util-position> | Bundled UI |
| `unist-util-stringify-position` | 4.0.0 | `MIT` | <https://github.com/syntax-tree/unist-util-stringify-position> | Bundled UI |
| `unist-util-visit` | 5.1.0 | `MIT` | <https://github.com/syntax-tree/unist-util-visit> | Bundled UI |
| `unist-util-visit-parents` | 6.0.2 | `MIT` | <https://github.com/syntax-tree/unist-util-visit-parents> | Bundled UI |
| `vary` | 1.1.2 | `MIT` | <https://github.com/jshttp/vary> | Runtime |
| `vfile` | 6.0.3 | `MIT` | <https://github.com/vfile/vfile> | Bundled UI |
| `vfile-message` | 4.0.3 | `MIT` | <https://github.com/vfile/vfile-message> | Bundled UI |
| `web-streams-polyfill` | 3.3.3 | `MIT` | <https://github.com/MattiasBuelens/web-streams-polyfill> | Runtime |
| `which` | 2.0.2 | `ISC` | <https://github.com/isaacs/node-which> | Runtime |
| `which-command` | 0.1.0 | `MIT` | <https://github.com/sindresorhus/which-command> | Runtime |
| `which-module` | 2.0.1 | `ISC` | <https://github.com/nexdrew/which-module> | Runtime |
| `wrap-ansi` | 6.2.0 | `MIT` | <https://github.com/chalk/wrap-ansi> | Runtime |
| `ws` | 8.22.0 | `MIT` | <https://github.com/websockets/ws> | Runtime |
| `wsl-utils` | 1.0.1 | `MIT` | <https://github.com/sindresorhus/wsl-utils> | Runtime |
| `xmlchars` | 2.2.0 | `MIT` | <https://github.com/lddubeau/xmlchars> | Runtime |
| `y18n` | 4.0.3 | `ISC` | <https://github.com/yargs/y18n> | Runtime |
| `yaml` | 2.9.1 | `ISC` | <https://github.com/eemeli/yaml> | Runtime |
| `yargs` | 15.4.1 | `MIT` | <https://github.com/yargs/yargs> | Runtime |
| `yargs-parser` | 18.1.3 | `ISC` | <https://github.com/yargs/yargs-parser> | Runtime |
| `yocto-queue` | 1.2.2 | `MIT` | <https://github.com/sindresorhus/yocto-queue> | Runtime |
| `yoctocolors` | 2.2.0 | `MIT` | <https://github.com/sindresorhus/yoctocolors> | Runtime |
| `zod` | 4.4.3 | `MIT` | <https://github.com/colinhacks/zod> | Runtime |
| `zod` | 4.6.5 | `MIT` | <https://github.com/colinhacks/zod> | Runtime |
| `zwitch` | 2.0.4 | `MIT` | <https://github.com/wooorm/zwitch> | Bundled UI |

## Copied model-catalog data

`server/catalog-extras.json` identifies `@earendil-works/pi-ai@1.1.0` as the source of copied model definitions. The package is MIT-licensed; the published npm tarball omits its LICENSE file, while the upstream repository license is available at <https://github.com/earendil-works/pi/blob/main/LICENSE>. This data-only source is listed separately because that exact version is not the project direct dependency.

| Source | Version | License | Repository | Scope |
|---|---:|---|---|---|
| ``@earendil-works/pi-ai`` | ``1.1.0`` | ``MIT`` | <https://github.com/earendil-works/pi> | Model catalog data copied into ``server/catalog-extras.json`` |

## License texts

The copyright notices below are aggregated from the dependency license files available in the installed package tree. Package-level license expressions remain authoritative; expressions containing `AND` require the listed components, while `OR` denotes an alternative. Preserve dependency-provided notices as described in the LibreOffice note below.

### MIT

Copyright notices associated with this license:
- Copyright (C) 2008
- Copyright (c) 2010 Sencha Inc.
- Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
- Copyright (c) 2011 Heather Arthur <fayearthur@gmail.com>
- Copyright (c) 2011 LearnBoost
- Copyright (c) 2011 TJ Holowaychuk
- Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>
- Copyright (c) 2011 Troy Goode <troygoode@gmail.com>
- Copyright (C) 2011-2015 by Vitaly Puzrin
- Copyright (c) 2011-2016 Heather Arthur <fayearthur@gmail.com>
- Copyright (c) 2011-2016 Heather Arthur <fayearthur@gmail.com>.
- Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org>
- Copyright (c) 2011:
- Copyright (c) 2012 Heather Arthur
- Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker
- Copyright (c) 2012 Ryan Day
- Copyright (c) 2012 TJ Holowaychuk
- Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>
- Copyright (c) 2012-2013 TJ Holowaychuk
- Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
- Copyright (c) 2012-2014 Federico Romero
- Copyright (c) 2012-2014 Isaac Z. Schlueter
- Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>
- Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)
- Copyright (c) 2012-2019 Thorsten Lorenz, Paul Miller (https://paulmillr.com)
- Copyright (c) 2013 Andrey Sidorov
- Copyright (c) 2013 Arnout Kazemier and contributors
- Copyright (c) 2013 Brian J. Brennan
- Copyright (c) 2013 Jonathan Ong <me@jongleberry.com>
- Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>
- Copyright (c) 2013-present Cole Bemis (Feather-derived icons in lucide-react)
- Copyright (c) 2014 Douglas Christopher Wilson
- Copyright (c) 2014 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2014 Jameson Little
- Copyright (c) 2014 Jeremiah Senkpiel <fishrock123@rocketmail.com>
- Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
- Copyright (c) 2014 Jonathan Ong me@jongleberry.com
- Copyright (c) 2014 Stefan Thomas
- Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2014 TJ Holowaychuk <tj@vision-media.ca>
- Copyright (c) 2014-2015 Douglas Christopher Wilson
- Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (C) 2014-2016 by Vitaly Puzrin
- Copyright (c) 2014-2016 Douglas Christopher Wilson
- Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
- Copyright (c) 2014-2017 Douglas Christopher Wilson
- Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
- Copyright (c) 2014-2018 Douglas Christopher Wilson
- Copyright (c) 2014-2022 Douglas Christopher Wilson
- Copyright (c) 2014-present Sebastian McKenzie and other contributors
- Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell
- Copyright (c) 2015 Andreas Lubbe
- Copyright (c) 2015 Dmitry Ivanov
- Copyright (c) 2015 Douglas Christopher Wilson
- Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2015 Jed Watson <jed.watson@me.com>
- Copyright (c) 2015 Tiancheng "Timothy" Gu
- Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>
- Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2015-2016 Douglas Christopher Wilson <doug@somethingdoug.com
- Copyright (c) 2015-2021 Evgeny Poberezkin
- Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2015-2022 Douglas Christopher Wilson doug@somethingdoug.com
- Copyright (c) 2015-present Devon Govett
- Copyright (c) 2016 - 2020 Node Fetch Team
- Copyright (c) 2016 Diwank Singh Tomer
- Copyright (C) 2016 Dmitry Chestnykh
- Copyright (c) 2016 Douglas Christopher Wilson
- Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com
- Copyright (c) 2016 Jimmy Karl Roland Wärting
- Copyright (c) 2016 Luigi Pinca and contributors
- Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2016 Zeit, Inc.
- Copyright (c) 2016-2017 Douglas Christopher Wilson <doug@somethingdoug.com>
- Copyright (c) 2016-2021 Josh Junon <josh@junon.me>.
- Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com)
- Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)
- Copyright (c) 2017 Dom Christie
- Copyright (c) 2017 Evgeny Poberezkin
- Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>
- Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2017 Victor Felder <victor@draft.li>
- Copyright (c) 2017-2018 Fredrik Nicol
- Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- Copyright (c) 2017-2021 Luke Childs
- Copyright (c) 2017-2026 Haydn Paterson
- Copyright (c) 2017-present, Jon Schlinkert.
- Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- Copyright (c) 2018 - present Microsoft Corporation
- Copyright (c) 2018 Filip Skokan
- Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
- Copyright (c) 2018 Szymon Marczak
- Copyright (c) 2018 Toru Nagashima
- Copyright (c) 2018-2021 Josh Junon
- Copyright (c) 2019
- Copyright (c) 2019 David Frank
- Copyright (c) 2019 Szymon Marczak
- Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
- Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>
- Copyright (c) 2020 Thomas Aribart
- Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2020 Vercel, Inc.
- Copyright (c) 2021 Jimmy Wärting
- Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2021-2022 Jared Wray
- Copyright (c) 2021-present Nick K.
- Copyright (c) 2021-present Shigma
- Copyright (c) 2021-present Toyobayashi
- Copyright (c) 2022 Ze-Zheng Wu
- Copyright (c) 2023 Arjun Barrett
- Copyright (c) 2023 Promplate Dev Team
- Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>
- Copyright (c) 2024 Colin McDonnell
- Copyright (c) 2024 Mattias Buelens
- Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.
- Copyright (c) 2025 Colin McDonnell
- Copyright (c) 2025 Mario Zechner (upstream license for copied pi-ai model data)
- Copyright (C) 2026  Niels Martignène <niels.martignene@protonmail.com>
- Copyright (c) 2026 Arjun Barrett
- Copyright (c) 2026 DeepSeek
- Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>
- Copyright (c) 2026 node-addon-require-builtin contributors
- Copyright (c) Espen Hovlandsdal
- Copyright (c) EventSource GitHub organisation
- Copyright (c) Feross Aboukhadijeh
- Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva)
- Copyright (c) Luke Childs <lukechilds123@gmail.com> (https://lukechilds.co.uk)
- Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)
- Copyright (c) Matteo Collina and Undici contributors
- Copyright (c) Meta Platforms, Inc. and affiliates.
- Copyright (c) Microsoft Corporation
- Copyright (c) Microsoft Corporation.
- Copyright (c) Microsoft Corporation. All rights reserved.
- Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
- Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)
- Copyright (c) Titus Wormer
- Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>
- Copyright (c) Titus Wormer <tituswormer@gmail.com>
- Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop)
- Copyright © 2011-2015 Paul Vorbach <paul@vorba.ch>
- Copyright 2010 James Halliday (mail@substack.net); Modified work Copyright 2014 Contributors (ben@npmjs.com)
- Copyright 2015, Dustin Diaz (the "Original Author")
- Copyright 2018
- Copyright 2022 Luca Ongaro
- Copyright 2023 Anthropic, PBC.
- COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
- copyright license to reproduce, prepare Derivative Works of,
- Copyright Louis-Dominique Dubeau and contributors to xmlchars
- copyright notice that is included in or attached to the work

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

Copyright notices associated with this license:
- Copyright {yyyy} {name of copyright owner}
- Copyright 2015 D2L Corporation
- Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
- Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
- Copyright 2018-2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
- Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
- Copyright 2024 SWC contributors.
- Copyright 2025 ehmicky <ehmicky@gmail.com>
- Copyright 2025 Zed Industries, Inc. and contributors
- Copyright 2026 OpenAI
- copyright license to reproduce, prepare Derivative Works of,
- copyright notice that is included in or attached to the work

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### ISC

Copyright notices associated with this license:
- Copyright (c) 2013-present Cole Bemis
- Copyright (c) 2015-2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors
- Copyright (c) 2015, Contributors
- Copyright (c) 2015, Wes Todd
- Copyright (c) 2016, Contributors
- Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov
- Copyright (c) 2021, Andrea Giammarchi, @WebReflection
- Copyright (c) 2026 Lucide Icons and Contributors
- Copyright (c) Isaac Z. Schlueter
- Copyright (c) Isaac Z. Schlueter and Contributors
- Copyright 2017, 2018, 2019, 2020 ECMA International
- Copyright 2018 Stefan Penner
- Copyright Eemeli Aro <eemeli@gmail.com>
- copyright notice and this permission notice appear in all copies.

```text
Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD 2-Clause

Copyright notices associated with this license:
- Copyright (c) 2011 The Mozilla Foundation.
- Copyright 2016-2018 Kornel Lesiński

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 3-Clause

Copyright notices associated with this license:
- Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
- Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
- Copyright (c) 2013, GoInstant Inc., a salesforce.com company
- Copyright (c) 2016, Daniel Wirtz  All rights reserved.
- Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
- Copyright (c) 2026 DeepSeek

```text
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 0BSD

Copyright notices associated with this license:
- Copyright (c) Microsoft Corporation.

```text
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### The Unlicense

Copyright notices associated with this license:
_No package-level copyright line was present in the available license files._

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

### Python Software Foundation License Version 2.0

Copyright notices associated with this license:
- Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam,

```text
A. HISTORY OF THE SOFTWARE
==========================

Python was created in the early 1990s by Guido van Rossum at Stichting
Mathematisch Centrum (CWI, see http://www.cwi.nl) in the Netherlands
as a successor of a language called ABC.  Guido remains Python's
principal author, although it includes many contributions from others.

In 1995, Guido continued his work on Python at the Corporation for
National Research Initiatives (CNRI, see http://www.cnri.reston.va.us)
in Reston, Virginia where he released several versions of the
software.

In May 2000, Guido and the Python core development team moved to
BeOpen.com to form the BeOpen PythonLabs team.  In October of the same
year, the PythonLabs team moved to Digital Creations, which became
Zope Corporation.  In 2001, the Python Software Foundation (PSF, see
https://www.python.org/psf/) was formed, a non-profit organization
created specifically to own Python-related Intellectual Property.
Zope Corporation was a sponsoring member of the PSF.

All Python releases are Open Source (see http://www.opensource.org for
the Open Source Definition).  Historically, most, but not all, Python
releases have also been GPL-compatible; the table below summarizes
the various releases.

    Release         Derived     Year        Owner       GPL-
                    from                                compatible? (1)

    0.9.0 thru 1.2              1991-1995   CWI         yes
    1.3 thru 1.5.2  1.2         1995-1999   CNRI        yes
    1.6             1.5.2       2000        CNRI        no
    2.0             1.6         2000        BeOpen.com  no
    1.6.1           1.6         2001        CNRI        yes (2)
    2.1             2.0+1.6.1   2001        PSF         no
    2.0.1           2.0+1.6.1   2001        PSF         yes
    2.1.1           2.1+2.0.1   2001        PSF         yes
    2.1.2           2.1.1       2002        PSF         yes
    2.1.3           2.1.2       2002        PSF         yes
    2.2 and above   2.1.1       2001-now    PSF         yes

Footnotes:

(1) GPL-compatible doesn't mean that we're distributing Python under
    the GPL.  All Python licenses, unlike the GPL, let you distribute
    a modified version without making your changes open source.  The
    GPL-compatible licenses make it possible to combine Python with
    other software that is released under the GPL; the others don't.

(2) According to Richard Stallman, 1.6.1 is not GPL-compatible,
    because its license has a choice of law clause.  According to
    CNRI, however, Stallman's lawyer has told CNRI's lawyer that 1.6.1
    is "not incompatible" with the GPL.

Thanks to the many outside volunteers who have worked under Guido's
direction to make these releases possible.


B. TERMS AND CONDITIONS FOR ACCESSING OR OTHERWISE USING PYTHON
===============================================================

PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


BEOPEN.COM LICENSE AGREEMENT FOR PYTHON 2.0
-------------------------------------------

BEOPEN PYTHON OPEN SOURCE LICENSE AGREEMENT VERSION 1

1. This LICENSE AGREEMENT is between BeOpen.com ("BeOpen"), having an
office at 160 Saratoga Avenue, Santa Clara, CA 95051, and the
Individual or Organization ("Licensee") accessing and otherwise using
this software in source or binary form and its associated
documentation ("the Software").

2. Subject to the terms and conditions of this BeOpen Python License
Agreement, BeOpen hereby grants Licensee a non-exclusive,
royalty-free, world-wide license to reproduce, analyze, test, perform
and/or display publicly, prepare derivative works, distribute, and
otherwise use the Software alone or in any derivative version,
provided, however, that the BeOpen Python License is retained in the
Software, alone or in any derivative version prepared by Licensee.

3. BeOpen is making the Software available to Licensee on an "AS IS"
basis.  BEOPEN MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, BEOPEN MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE SOFTWARE WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

4. BEOPEN SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF THE
SOFTWARE FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS
AS A RESULT OF USING, MODIFYING OR DISTRIBUTING THE SOFTWARE, OR ANY
DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

5. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

6. This License Agreement shall be governed by and interpreted in all
respects by the law of the State of California, excluding conflict of
law provisions.  Nothing in this License Agreement shall be deemed to
create any relationship of agency, partnership, or joint venture
between BeOpen and Licensee.  This License Agreement does not grant
permission to use BeOpen trademarks or trade names in a trademark
sense to endorse or promote products or services of Licensee, or any
third party.  As an exception, the "BeOpen Python" logos available at
http://www.pythonlabs.com/logos.html may be used according to the
permissions granted on that web page.

7. By copying, installing or otherwise using the software, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.


CNRI LICENSE AGREEMENT FOR PYTHON 1.6.1
---------------------------------------

1. This LICENSE AGREEMENT is between the Corporation for National
Research Initiatives, having an office at 1895 Preston White Drive,
Reston, VA 20191 ("CNRI"), and the Individual or Organization
("Licensee") accessing and otherwise using Python 1.6.1 software in
source or binary form and its associated documentation.

2. Subject to the terms and conditions of this License Agreement, CNRI
hereby grants Licensee a nonexclusive, royalty-free, world-wide
license to reproduce, analyze, test, perform and/or display publicly,
prepare derivative works, distribute, and otherwise use Python 1.6.1
alone or in any derivative version, provided, however, that CNRI's
License Agreement and CNRI's notice of copyright, i.e., "Copyright (c)
1995-2001 Corporation for National Research Initiatives; All Rights
Reserved" are retained in Python 1.6.1 alone or in any derivative
version prepared by Licensee.  Alternately, in lieu of CNRI's License
Agreement, Licensee may substitute the following text (omitting the
quotes): "Python 1.6.1 is made available subject to the terms and
conditions in CNRI's License Agreement.  This Agreement together with
Python 1.6.1 may be located on the Internet using the following
unique, persistent identifier (known as a handle): 1895.22/1013.  This
Agreement may also be obtained from a proxy server on the Internet
using the following URL: http://hdl.handle.net/1895.22/1013".

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python 1.6.1 or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python 1.6.1.

4. CNRI is making Python 1.6.1 available to Licensee on an "AS IS"
basis.  CNRI MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, CNRI MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON 1.6.1 WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. CNRI SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
1.6.1 FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON 1.6.1,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. This License Agreement shall be governed by the federal
intellectual property law of the United States, including without
limitation the federal copyright law, and, to the extent such
U.S. federal law does not apply, by the law of the Commonwealth of
Virginia, excluding Virginia's conflict of law provisions.
Notwithstanding the foregoing, with regard to derivative works based
on Python 1.6.1 that incorporate non-separable material that was
previously distributed under the GNU General Public License (GPL), the
law of the Commonwealth of Virginia shall govern this License
Agreement only as to issues arising under or with respect to
Paragraphs 4, 5, and 7 of this License Agreement.  Nothing in this
License Agreement shall be deemed to create any relationship of
agency, partnership, or joint venture between CNRI and Licensee.  This
License Agreement does not grant permission to use CNRI trademarks or
trade name in a trademark sense to endorse or promote products or
services of Licensee, or any third party.

8. By clicking on the "ACCEPT" button where indicated, or by copying,
installing or otherwise using Python 1.6.1, Licensee agrees to be
bound by the terms and conditions of this License Agreement.

        ACCEPT


CWI LICENSE AGREEMENT FOR PYTHON 0.9.0 THROUGH 1.2
--------------------------------------------------

Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam,
The Netherlands.  All rights reserved.

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appear in all copies and that
both that copyright notice and this permission notice appear in
supporting documentation, and that the name of Stichting Mathematisch
Centrum or CWI not be used in advertising or publicity pertaining to
distribution of the software without specific, written prior
permission.

STICHTING MATHEMATISCH CENTRUM DISCLAIMS ALL WARRANTIES WITH REGARD TO
THIS SOFTWARE, INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS, IN NO EVENT SHALL STICHTING MATHEMATISCH CENTRUM BE LIABLE
FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### CC0 1.0 Universal

Copyright notices associated with this license:
_No package-level copyright line was present in the available license files._

Canonical source: <https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt>

```text
Creative Commons Legal Code

CC0 1.0 Universal

    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE
    LEGAL SERVICES. DISTRIBUTION OF THIS DOCUMENT DOES NOT CREATE AN
    ATTORNEY-CLIENT RELATIONSHIP. CREATIVE COMMONS PROVIDES THIS
    INFORMATION ON AN "AS-IS" BASIS. CREATIVE COMMONS MAKES NO WARRANTIES
    REGARDING THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS
    PROVIDED HEREUNDER, AND DISCLAIMS LIABILITY FOR DAMAGES RESULTING FROM
    THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED
    HEREUNDER.

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer
exclusive Copyright and Related Rights (defined below) upon the creator and
subsequent owner(s) (each and all, an "owner") of an original work of
authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for the
purpose of contributing to a commons of creative, cultural and scientific
works ("Commons") that the public can reliably and without fear of later claims
of infringement build upon, modify, incorporate in other works, reuse and
redistribute as freely as possible in any form whatsoever and for any purposes,
including without limitation commercial purposes. These owners may contribute
to the Commons to promote the ideal of a free culture and the further production
of creative, cultural and scientific works, or to gain reputation or greater
distribution for their Work in part through the use and efforts of others.

For these and/or other purposes and motivations, and without any expectation of
additional consideration or compensation, the person associating CC0 with a
Work (the "Affirmer"), to the extent that he or she is an owner of Copyright
and Related Rights in the Work, voluntarily elects to apply CC0 to the Work and
publicly distribute the Work under its terms, with knowledge of his or her
Copyright and Related Rights in the Work and the meaning and intended legal
effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be
protected by copyright and related or neighboring rights ("Copyright and
Related Rights"). Copyright and Related Rights include, but are not limited to,
the following:

  i. the right to reproduce, adapt, distribute, perform, display, communicate,
     and translate a Work;
 ii. moral rights retained by the original author(s) and/or performer(s);
iii. publicity and privacy rights pertaining to a person's image or likeness
depicted in a Work;
 iv. rights protecting against unfair competition in regards to a Work, subject
to the limitations in paragraph 4(a), below;
  v. rights protecting the extraction, dissemination, use and reuse of data in a
Work;
 vi. database rights (such as those arising under Directive 96/9/EC of the
European Parliament and of the Council of 11 March 1996 on the legal protection
of databases, and under any national implementation thereof, including any
amended or successor version of such directive); and
vii. other similar, equivalent or corresponding rights throughout the world
based on applicable law or treaty, and any national implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention of,
applicable law, Affirmer hereby overtly, fully, permanently, irrevocably and
unconditionally waives, abandons, and surrenders all of Affirmer's Copyright
and Related Rights and associated claims and causes of action, whether now
known or unknown (including existing as well as future claims and causes of
action), in the Work (i) in all territories worldwide, (ii) for the maximum
duration provided by applicable law or treaty (including future time
extensions), (iii) in any current or future medium and for any number of
copies, and (iv) for any purpose whatsoever, including without limitation
commercial, advertising or promotional purposes (the "Waiver"). Affirmer
makes the Waiver for the benefit of each member of the public at large and to
the detriment of Affirmer's heirs and successors, fully intending that such
Waiver shall not be subject to revocation, rescission, cancellation,
termination, or any other legal or equitable action to disrupt the quiet
enjoyment of the Work by the public as contemplated by Affirmer's express
Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason be
judged legally invalid or ineffective under applicable law, then the Waiver
shall be preserved to the maximum extent permitted taking into account
Affirmer's express Statement of Purpose. In addition, to the extent the Waiver
is so judged Affirmer hereby grants to each affected person a royalty-free,
non transferable, non sublicensable, non exclusive, irrevocable and
unconditional license to exercise Affirmer's Copyright and Related Rights in
the Work (i) in all territories worldwide, (ii) for the maximum duration
provided by applicable law or treaty (including future time extensions), (iii)
in any current or future medium and for any number of copies, and (iv) for any
purpose whatsoever, including without limitation commercial, advertising or
promotional purposes (the "License"). The License shall be deemed effective
as of the date CC0 was applied by Affirmer to the Work. Should any part of the
License for any reason be judged legally invalid or ineffective under
applicable law, such partial invalidity or ineffectiveness shall not invalidate
the remainder of the License, and in such case Affirmer hereby affirms that he
or she will not (i) exercise any of his or her remaining Copyright and Related
Rights in the Work or (ii) assert any associated claims and causes of action
with respect to the Work, in either case contrary to Affirmer's express
Statement of Purpose.

4. Limitations and Disclaimers.

 a. No trademark or patent rights held by Affirmer are waived, abandoned,
    surrendered, licensed or otherwise affected by this document.
 b. Affirmer offers the Work as-is and makes no representations or warranties
    of any kind concerning the Work, express, implied, statutory or otherwise,
    including without limitation warranties of title, merchantability, fitness
    for a particular purpose, non infringement, or the absence of latent or
    other defects, accuracy, or the present or absence of errors, whether or
    not discoverable, all to the greatest extent permissible under applicable
    law.
 c. Affirmer disclaims responsibility for clearing rights of other persons
    that may apply to the Work or any use thereof, including without limitation
    any person's Copyright and Related Rights in the Work. Further, Affirmer
    disclaims responsibility for obtaining any necessary consents, permissions
    or other rights required for any use of the Work.
 d. Affirmer understands and acknowledges that Creative Commons is not a party
    to this document and has no duty or obligation with respect to this CC0 or
    use of the Work.
```

### GNU Lesser General Public License 3.0-or-later

Copyright notices associated with this license:
_No package-level copyright line was present in the available license files._

```text
Version 3, 29 June 2007

Copyright © 2007 Free Software Foundation, Inc. <https://fsf.org/>

Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is
        not allowed.

This version of the GNU Lesser General Public License incorporates the terms and conditions of version 3 of
        the GNU General Public License, supplemented by the additional permissions listed below.

## 0. Additional Definitions.

As used herein, “this License” refers to version 3 of the GNU Lesser General Public License, and the
        “GNU GPL” refers to version 3 of the GNU General Public License.

“The Library” refers to a covered work governed by this License, other than an Application or a Combined
        Work as defined below.

An “Application” is any work that makes use of an interface provided by the Library, but which is not
        otherwise based on the Library. Defining a subclass of a class defined by the Library is deemed a mode of using
        an interface provided by the Library.

A “Combined Work” is a work produced by combining or linking an Application with the Library. The
        particular version of the Library with which the Combined Work was made is also called the “Linked
        Version”.

The “Minimal Corresponding Source” for a Combined Work means the Corresponding Source for the Combined
        Work, excluding any source code for portions of the Combined Work that, considered in isolation, are based on
        the Application, and not on the Linked Version.

The “Corresponding Application Code” for a Combined Work means the object code and/or source code for
        the Application, including any data and utility programs needed for reproducing the Combined Work from the
        Application, but excluding the System Libraries of the Combined Work.

## 1. Exception to Section 3 of the GNU GPL.

You may convey a covered work under sections 3 and 4 of this License without being bound by section 3 of the
        GNU GPL.

## 2. Conveying Modified Versions.

If you modify a copy of the Library, and, in your modifications, a facility refers to a function or data to
        be supplied by an Application that uses the facility (other than as an argument passed when the facility is
        invoked), then you may convey a copy of the modified version:

under this License, provided that you make a good faith effort to ensure that, in the event an
            Application does not supply the function or data, the facility still operates, and performs whatever part
            of its purpose remains meaningful, or

under the GNU GPL, with none of the additional permissions of this License applicable to that
            copy.

## 3. Object Code Incorporating Material from Library Header Files.

The object code form of an Application may incorporate material from a header file that is part of the
        Library. You may convey such object code under terms of your choice, provided that, if the incorporated
        material is not limited to numerical parameters, data structure layouts and accessors, or small macros, inline
        functions and templates (ten or fewer lines in length), you do both of the following:

Give prominent notice with each copy of the object code that the Library is used in it and that the
            Library and its use are covered by this License.

Accompany the object code with a copy of the GNU GPL and this license document.

## 4. Combined Works.

You may convey a Combined Work under terms of your choice that, taken together, effectively do not restrict
        modification of the portions of the Library contained in the Combined Work and reverse engineering for
        debugging such modifications, if you also do each of the following:

Give prominent notice with each copy of the Combined Work that the Library is used in it and that the
            Library and its use are covered by this License.

Accompany the Combined Work with a copy of the GNU GPL and this license document.

For a Combined Work that displays copyright notices during execution, include the copyright notice for
            the Library among these notices, as well as a reference directing the user to the copies of the GNU GPL and
            this license document.

Do one of the following:
                Convey the Minimal Corresponding Source under the terms of this License, and the Corresponding
                    Application Code in a form suitable for, and under terms that permit, the user to recombine or
                    relink the Application with a modified version of the Linked Version to produce a modified Combined
                    Work, in the manner specified by section 6 of the GNU GPL for conveying Corresponding Source.Use a suitable shared library mechanism for linking with the Library. A suitable mechanism is
                    one that (a) uses at run time a copy of the Library already present on the user's computer system,
                    and (b) will operate properly with a modified version of the Library that is interface-compatible
                    with the Linked Version.

Convey the Minimal Corresponding Source under the terms of this License, and the Corresponding
                    Application Code in a form suitable for, and under terms that permit, the user to recombine or
                    relink the Application with a modified version of the Linked Version to produce a modified Combined
                    Work, in the manner specified by section 6 of the GNU GPL for conveying Corresponding Source.

Use a suitable shared library mechanism for linking with the Library. A suitable mechanism is
                    one that (a) uses at run time a copy of the Library already present on the user's computer system,
                    and (b) will operate properly with a modified version of the Library that is interface-compatible
                    with the Linked Version.

Provide Installation Information, but only if you would otherwise be required to provide such
            information under section 6 of the GNU GPL, and only to the extent that such information is necessary to
            install and execute a modified version of the Combined Work produced by recombining or relinking the
            Application with a modified version of the Linked Version. (If you use option 4d0, the Installation
            Information must accompany the Minimal Corresponding Source and Corresponding Application Code. If you use
            option 4d1, you must provide the Installation Information in the manner specified by section 6 of the GNU
            GPL for conveying Corresponding Source.)

## 5. Combined Libraries.

You may place library facilities that are a work based on the Library side by side in a single library
        together with other library facilities that are not Applications and are not covered by this License, and
        convey such a combined library under terms of your choice, if you do both of the following:

Accompany the combined library with a copy of the same work based on the Library, uncombined with any
            other library facilities, conveyed under the terms of this License.

Give prominent notice with the combined library that part of it is a work based on the Library, and
            explaining where to find the accompanying uncombined form of the same work.

## 6. Revised Versions of the GNU Lesser General Public License.

The Free Software Foundation may publish revised and/or new versions of the GNU Lesser General Public
        License from time to time. Such new versions will be similar in spirit to the present version, but may differ
        in detail to address new problems or concerns.

Each version is given a distinguishing version number. If the Library as you received it specifies that a
        certain numbered version of the GNU Lesser General Public License “or any later version” applies to it, you
        have the option of following the terms and conditions either of that published version or of any later version
        published by the Free Software Foundation. If the Library as you received it does not specify a version number
        of the GNU Lesser General Public License, you may choose any version of the GNU Lesser General Public License
        ever published by the Free Software Foundation.

If the Library as you received it specifies that a proxy can decide whether future versions of the GNU
        Lesser General Public License shall apply, that proxy's public statement of acceptance of any version is
        permanent authorization for you to choose that version for the Library.

```

### Mozilla Public License 2.0

Copyright notices associated with this license:
_No package-level copyright line was present in the available license files._

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

## Additional notices included in the LibreOffice engine package

The transitive runtime dependency ``@deepseek-ai/libreoffice-kit`` (MPL-2.0) installs ``@deepseek-ai/libreoffice-kit-win32-x64`` on Windows x64. Its packaged LibreOffice engine has its own additional licensing inventory, including GPL-2.0-or-later / GPL-3.0, LGPL-2.1 / LGPL-3.0, MPL-1.1 / MPL-2.0, Apache and other third-party terms. The engine package carries these original full notices and license texts in ``program/license.txt``, ``licenses/LibreOffice-third-party.html``, and ``program/NOTICE``; the JavaScript adapter also carries ``@deepseek-ai/libreoffice-kit/NOTICE``. Keep those files in any binary distribution; this general dependency table is not a substitute for them.

The LibreOffice third-party inventory says the Plain TeX ``hyphen.tex`` hyphenation tables are freely redistributable only unmodified; modifications are permitted only if the resulting file is not named ``hyphen.tex``. The inventory also contains GPL/LGPL/MPL tri-licensed components. These are facts from the bundled notices, not a legal conclusion about the combined release.

## Packages without a separate license file

Some npm package tarballs omit a root LICENSE file while declaring an SPDX license in ``package.json`` (notably ``@earendil-works/pi-ai`` and the xterm serialize/headless packages). The corresponding license text is provided above from the upstream repository or another package in the same license family. For pi-ai, the upstream MIT notice is ``Copyright (c) 2025 Mario Zechner`` and is linked above.

This notice is informational and does not replace the license files shipped with the third-party packages.


