# Estratégia e inventário de testes — Onetho

Documento de referência para o time mapear cobertura, escolher ferramentas e priorizar lacunas.
Escopo: aplicativo desktop **Tauri 2** + **React** (fork do Alethe), local-first.

## Objetivos

1. Manter **regressão rápida** na camada TS/Rust sem depender de APIs pagas de agentes ou PTY real em todo PR.
2. Garantir **fluxos críticos** (onboarding, projetos, terminal, sync) com E2E no binário real quando fizer sentido.
3. Separar suite **determinística** (CI) de suite **opt-in** (provedores reais, Ghostty, macOS/Windows exclusivos).

---

## Inventário da stack de testes hoje

| Camada | Ferramenta | Config / entrada | CI (`ci.yml`) |
|--------|------------|------------------|---------------|
| Frontend unidade/integração | **Vitest 4** + **jsdom** + Testing Library | `vitest.config.ts`, `src/test/setup.ts`, `src/**/*.test.{ts,tsx}` | `npm test` |
| Backend unidade | **cargo test** (`src-tauri`, lib) | `npm run test:rust` | `cargo test` (matrix Win/Linux/macOS) |
| E2E desktop | **WebdriverIO 9** + **@wdio/tauri-service** + **tauri-driver** | `e2e/wdio.conf.ts`, specs em `e2e/specs/` | **Não** (local/ nightly manual) |
| Ghostty (opcional) | `cargo test --ignored` | `npm run test:ghostty` | Não |
| Qualidade | ESLint, Prettier, `tsc` | `npm run lint`, `format:check`, `build` | Sim |
| Smoke Playwright (opcional) | **@playwright/test** | `playwright.smoke.config.ts`, `npm run test:playwright:smoke` | Não |

### Resultados medidos (ambiente Linux, nov/2026)

| Comando | Resultado |
|---------|-----------|
| `npm test` | **157** arquivos, **1192** testes — todos passando (~56s) |
| `cargo test --lib` | **642** passando, **4** ignorados (~130s) |
| Cobertura de código (Istanbul/c/llvm-cov) | **Não configurada** no repositório hoje |

### Arquivos E2E existentes

- `e2e/specs/smoke.spec.ts` — boot sem crash, `#root` visível
- `e2e/specs/onboarding.spec.ts` — wizard Quick setup (cliques reais)
- `e2e/specs/git-pipeline.spec.ts` — pipeline Git
- `e2e/specs/conflict-merge-ui.spec.ts`, `git-graph-screenshot.spec.ts`
- `e2e/specs/_record.spec.ts`, `_replay.spec.ts`, `_sandbox.spec.ts`, `_diag.spec.ts` — gravação/replay/diagnóstico

---

## Inventário de funcionalidades (baseado no código)

### Frontend React — áreas principais

| Área | Módulos / stores |
|------|-------------------|
| Shell e layout | `App.tsx`, `TitleBar`, `WorkspaceView`, `HomeView`, painéis redimensionáveis |
| Onboarding / perfil | `OnboardingModal`, steps (`AgentsStep`, `FeaturesStep`, `UsageAccessStep`) |
| Projetos e grupos | `projectsStore` (+ slices), `ProjectSidebar`, modais New/Edit |
| Workspace / abas | `workspaceSlices`, histórico, flat mode, fullscreen |
| Layouts / grid | `ProjectGridModal`, `projectGrids`, layouts Auto/Spotlight/Sidebar/custom |
| Terminais UI | `terminalsStore`, `xterm`, sub-tabs, restart overlay |
| Orquestrador / Agent Canvas | `OrchestrationWindow`, `agentCanvasStore`, `OrchestratorPane/*` |
| Agentes (install/resume) | `lib/agent*`, `AgentInstallModal`, `useAgentInstall` |
| MCP | `mcpStore`, `McpManagerModal`, registry |
| Plugins | `lib/plugins/*`, `PluginsSidebar`, marketplace |
| Git UI | explorer, diff, merge, graph (vários modais) |
| Preferências | `PreferencesModal` (Appearance, Features, Multiagent, Orchestration, …) |
| Todo (plugin) | `plugins/todos` |
| Voz / ditado | `VoiceCommand`, `DictationButton`, `lib/speech/*` |
| Browser panes | `WebPane`, CDP/private browser surfaces |
| Sync / backup | `SyncModal`, cloud sync helpers |
| Spotify / uso AI | widgets Home, `UsageStrip`, usage modals |
| Remoto | `RemoteControlModal`, `remoteChat` |
| i18n | `lib/i18n/messages/{en,pt-BR,zh-CN}` — validado no `build` |

### Backend Rust — módulos e comandos Tauri (amostra)

Centenas de comandos via `tauri::generate_handler!` em `src-tauri/src/lib.rs`. Módulos representativos:

| Domínio | Módulos |
|---------|---------|
| **PTY / terminais** | `pty.rs` (`spawn_pty`, `write_pty`, `resize_pty`, `kill_pty`, scrollback, eventos `pty://data/{id}`) |
| **CLI / agentes** | `cli_resolver.rs`, `cli_launch.rs`, `claude_sessions.rs`, `codex_sessions.rs`, `opencode_sessions.rs`, `cursor_sessions.rs`, `antigravity_sessions.rs` |
| **Uso / custo** | `claude_usage.rs`, `codex_usage.rs`, `agent_cost.rs`, `kimi_usage.rs` |
| **Projetos / FS** | `projects.rs`, `filesystem.rs`, `paths.rs`, `validation.rs` |
| **Perfis locais** | `profiles.rs` |
| **Git** | `git_control.rs`, `worktrees.rs`, `merge_analyzer.rs`, `conflict_resolution.rs` |
| **GitHub** | `github_sync.rs`, `github_pr.rs` |
| **Sync nuvem / Gist** | `cloud_sync.rs`, `handoff.rs` |
| **MCP** | `mcp_store.rs`, `mcp_catalog.rs`, `mcp_health.rs`, `mcp_agents.rs` |
| **Plugins** | `plugins.rs`, `plugin_catalog.rs`, `plugin_package.rs` |
| **Orquestrador** | `orchestrator.rs`, `orchestrator_core.rs`, `orchestrator_shell_host.rs`, `planning.rs` |
| **Browser** | `browser_pane.rs`, `browser_session.rs`, `cdp.rs` |
| **Voz** | `speech.rs`, `speech_capture.rs`, `speech_cloud.rs`, `speech_vad.rs` |
| **Spotify** | `spotify.rs` |
| **Backup** | `backup.rs` |
| **Recursos / memória** | `resources.rs`, `resource_manager.rs`, `stats.rs`, `process_tree.rs` |
| **WSL** | `wsl.rs` |
| **Ghostty** | `ghostty_bridge.rs` (build condicional `ghostty_linked`) |
| **Remoto** | `remote/*` |
| **Graphify** | `graphify.rs` |
| **Router9** | `router9.rs` |
| **AI Memory** | `ai_memory.rs`, `ai_memory_hooks.rs` |
| **Segurança / diagnóstico** | CSP (`securityPolicy.test.ts`), `diagnostics.rs`, `telemetry.rs` (local) |

---

## Comparativo: Playwright vs WebdriverIO vs `cargo test`

Fontes oficiais Tauri v2 (verificado em nov/2026):

- [Mock Tauri APIs](https://v2.tauri.app/develop/tests/mocking/) — **`@tauri-apps/api/mocks`**: `mockIPC`, `mockWindows`, `clearMocks`; pensado para **Vitest/jest**, não Playwright nativo.
- [WebDriver](https://v2.tauri.app/develop/tests/webdriver/) — caminho E2E recomendado: **WebdriverIO** + **`@wdio/tauri-service`**.
- [WDIO browser mode](https://github.com/webdriverio/desktop-mobile/blob/main/packages/tauri-service/docs/browser-mode.md) — frontend no Chrome com `invoke` interceptado (similar ao mockIPC, mas via `browser.tauri.mock()`).

| Critério | **Vitest + mockIPC** | **Playwright** (`@playwright/test`) | **WebdriverIO + tauri-driver** | **`cargo test`** |
|----------|----------------------|--------------------------------------|--------------------------------|------------------|
| **O que executa** | Renderer em jsdom/Node | Chromium real (URL Vite) | **Binário Tauri** + WebDriver | Rust (lib, sem webview obrigatório) |
| **IPC Tauri** | `mockIPC` oficial | Stub manual `addInitScript` ou bundle dos mocks | `browser.tauri.execute()` / `browser.tauri.mock()` | N/A (testa Rust direto ou via funções públicas) |
| **PTY real** | Não | Não | **Sim** (se fluxo abrir terminal) | **Sim** (`portable-pty` em testes de integração) |
| **Plugins / janelas OS** | Não | Não | Parcial (dialog, FS nativo) | Parcial |
| **macOS E2E** | Sim (jsdom) | Sim (browser) | Sim com **embedded** WDIO (sem driver externo) — ver docs Tauri | Sim |
| **Linux E2E no CI** | Sim (rápido) | Sim (precisa Vite + stub) | Sim com deps GTK/WebKit + binário debug | Sim |
| **Velocidade no CI** | Alta | Média (sobe Vite) | Baixa (build + driver) | Média/alta |
| **Documentação Tauri** | **Recomendado** para unit frontend | Não é stack documentada; viável com stub | **Recomendado** para E2E desktop | **Recomendado** para regras de negócio Rust |
| **Limitações** | Não valida WebView, CSS real, plugins | Stub incompleto quebra fácil (`getCurrentWindow` em import estático, etc.) | `tauri-driver` **oficial** focado Linux/Windows; macOS usa embedded; build MSVC no Windows | Não cobre UI; testes Ghostty `#\[ignore\]` |

### Abordagem em camadas (recomendada)

```text
┌─────────────────────────────────────────────────────────────┐
│  Camada 4 — Opt-in: provedores IA reais, Ghostty, replay  │
├─────────────────────────────────────────────────────────────┤
│  Camada 3 — E2E WDIO: binário Tauri (smoke, onboarding, git)│
├─────────────────────────────────────────────────────────────┤
│  Camada 2 — Vitest + mockIPC: stores, modais, fluxos UI     │
├─────────────────────────────────────────────────────────────┤
│  Camada 1 — cargo test: PTY, git, sync, parsers, IPC rules   │
└─────────────────────────────────────────────────────────────┘
```

**Playwright:** útil como **smoke opcional** do bundle Vite (`npm run test:playwright:smoke`) e para equipes que já padronizaram Playwright — mas, para Onetho, **não substitui** WDIO no desktop nem Vitest+mockIPC para a maior parte dos testes. Preferir **WDIO browser mode** se a necessidade for E2E só no renderer com API idêntica ao `browser.tauri.mock()`.

---

## Como rodar testes

### Local (Linux)

```bash
npm install
npm test                    # Vitest
npm run test:rust           # cargo test --lib
npm run build               # tsc + i18n + vite (typecheck)

# E2E (requer binário debug — ver e2e/support/launch.ts)
npm run test:e2e:build      # uma vez
npm run test:e2e            # WDIO + tauri-driver

# Opcional
npm run test:playwright:smoke
npm run test:ghostty        # testes ignorados do backend Ghostty

# Rust com deps Linux (webkit/alsa já no CONTRIBUTING)
export PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig
export LIBRARY_PATH=/usr/lib/gcc/x86_64-linux-gnu/13:/usr/lib/x86_64-linux-gnu
cd src-tauri && cargo test --lib
```

### CI (`.github/workflows/ci.yml`)

- **Job `frontend`:** `npm ci` → lint → format → **`npm test`** → **`npm run build`**
- **Job `rust`:** matrix Windows / Ubuntu 22.04 / macOS → `cargo check` → `cargo clippy` (não bloqueante) → **`cargo test`**
- **E2E WDIO e Playwright:** não estão no CI hoje — candidatos a job nightly.

### Variáveis de ambiente (testes)

| Variável | Uso |
|----------|-----|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Só integração Spotify real (opt-in) |
| Tokens OAuth (Claude, etc.) | Suite manual `tests/ai-live/` (proposta) — **nunca** no CI padrão |
| `CARGO_TARGET_DIR=target-e2e` | Build isolado para E2E (`test:e2e:build`) |

---

## Terminais (PTY) e agentes de IA — como testar

### Como o código funciona (resumo)

1. **Spawn:** frontend `lib/tauri/pty.ts` → `invoke('spawn_pty', …)` → `pty::spawn_pty` usa **`portable_pty`** + `cli_resolver::command_builder_for_terminal` (shell vs Claude/Codex/OpenCode).
2. **I/O:** backend emite `pty://data/{id}` / `pty://exit/{id}`; frontend `terminalsStore` alimenta **xterm.js**.
3. **Scrollback:** buffer em memória + flush em `scrollback_path` (`SCROLLBACK_CAP_BYTES`, 4 MiB).
4. **Agentes:** resolução de CLI em `cli_resolver.rs` (PATH, npm, nvm, etc. no Windows); sessões por provedor em `*_sessions.rs`; uso em `*_usage.rs`.

### Estratégia de testes PTY

| Nível | O quê | Como | Status |
|-------|-------|------|--------|
| **Rust unit** | Regras de scrollback, UTF-8, visibilidade, kill/grupo, invariantes de lock | `src-tauri/src/pty.rs` módulo `tests` | **Coberto** (dezenas de testes) |
| **Rust integração** | Spawn `sh`, leitura de bytes reais | `integration_spawn_sh_emits_expected_bytes` | **Iniciado** (1 smoke) |
| **Rust integração (futuro)** | write/echo, resize, kill, persistência scrollback em tmpdir | Usar `tempfile` + paths isolados, sem `AppHandle` | **Falta** |
| **Rust integração WSL** | Sessões com `wsl_target` | Mark `#[cfg(target_os = "windows")]` ou ignore em Linux | **Falta** |
| **Frontend** | Handlers de evento PTY, fila de spawn, restart | `terminalsStore.test.ts`, `lib/tauri/pty.test.ts` (mock `invoke`) | **Parcial** |
| **Frontend xterm** | Bytes ANSI → tela | Injetar `Uint8Array` no emulador sem IPC; testar addons fit/search | **Falta** |
| **E2E WDIO** | Terminal visível e aceita input | Spec dedicado com mock de projeto + spawn shell | **Falta** |

**Referência de prova:** `cargo test --lib integration_spawn_sh` (smoke `portable-pty`).

### Estratégia de testes de agentes IA

| Abordagem | Descrição | Custo | Determinismo |
|-----------|-----------|-------|--------------|
| **Stub de CLI** | Script `#!/bin/sh` no PATH que imprime saída fixa (streaming com `sleep`, códigos de saída, stderr) | Grátis | Alto |
| **Mock IPC** | `mockIPC` retorna metadados de sessão / usage falsos | Grátis | Alto |
| **Rust unit** | Parsers de JSON de sessão, paths de config, validação de args antes do spawn | Grátis | Alto |
| **`cli_resolver` tests** | Já cobre resolução Windows/Linux com fixtures | Grátis | Alto |
| **`browser.tauri.mock()`** | E2E WDIO browser mode para modal de install agent | Grátis | Médio |
| **Suite opt-in `ai-live`** | `ONETHO_LIVE_CLAUDE=1 npm run test:ai-live` contra API real | Pago | Baixo — só manual/ nightly |

**Cenários prioritários para stubs:** spawn com flag “dangerous permissions”, reinício de sessão, erro de CLI não encontrado, timeout de usage, eventos `agent_events` na porta local (9123).

**Não fazer no CI padrão:** chamadas a Anthropic/OpenAI/Spotify OAuth reais.

---

## Matriz feature × testes

Legenda **Status:** ✅ coberto · ⚠️ parcial · ❌ ausente · 🔧 só manual/E2E local

Prioridade: **P0** crítico (dados/perda de sessão) · **P1** núcleo produto · **P2** integração · **P3** polish

| Feature | Área | Cenários-chave | Tipo sugerido | Status | Prio |
|---------|------|----------------|---------------|--------|------|
| Quick setup / onboarding | UI | bloqueio sem nome, idioma, persistência `projects.json` | Vitest, WDIO | ⚠️ WDIO spec; poucos Vitest | P1 |
| Perfis locais | Rust/UI | criar/trocar/renomear/excluir namespace | cargo + Vitest | ⚠️ | P1 |
| Projetos / grupos | Store | CRUD, migrações schema, drag-drop regras | Vitest (`migrations.test`) | ✅ parcial | P0 |
| Workspace / abas | Store | histórico, flat, fullscreen | Vitest | ⚠️ | P1 |
| Layouts / grid custom | UI | spans, proporções, persistência | Vitest (`projectGrids`) | ⚠️ | P2 |
| **PTY spawn/write/kill** | Rust | sh echo, resize, scrollback round-trip | cargo integração | ⚠️ smoke | **P0** |
| **PTY eventos → xterm** | FE | stream bytes, exit, restart overlay | Vitest + mock events | ❌ | **P0** |
| Sub-tabs terminal | Store | multi-PTY por pane | Vitest | ⚠️ | P1 |
| CLI resolution | Rust | PATH, npm, overrides | cargo | ✅ | P1 |
| Claude / Codex / OpenCode | Rust/FE | resume, sessões, unrestricted flags | stub CLI + cargo | ❌ E2E | **P0** |
| Agent install modal | UI | detect versão, timeout | Vitest | ⚠️ | P2 |
| Orquestrador | Rust/FE | shells, restart via orchestrator IPC | Vitest/cargo | ⚠️ | P1 |
| Agent Canvas | FE | permissões Ask/Bypass | Vitest (`agentCanvas*`) | ⚠️ | P2 |
| Home / recentes | UI | greet, quick actions | WDIO / Vitest | ❌ | P2 |
| Jump / atalhos | UI | Ctrl+P, Ctrl+T | WDIO | ❌ | P2 |
| Todo plugin | Plugin | CRUD tarefas | Vitest (`plugins/todos`) | ✅ | P3 |
| MCP manager | Rust/UI | add server, health, store | cargo + Vitest limitado | ❌ | P1 |
| Plugins bundled | Rust | manifest, capabilities | Vitest `lib/plugins/*` | ✅ | P2 |
| Git diff / merge UI | UI | conflitos, graph | WDIO `conflict-merge`, `git-pipeline` | ⚠️ | P1 |
| Git backend | Rust | status, commit, worktrees | cargo (`worktrees`, `git_control`) | ⚠️ | P1 |
| GitHub sync / PR | Rust | gist, PR create | cargo + opt-in | ❌ | P2 |
| Cloud sync / handoff | Rust/FE | device flow, payload | Vitest parcial | ⚠️ | P2 |
| Backup import/export | Rust | zip-slip, atomic write | cargo | ⚠️ | P1 |
| Spotify OAuth | Rust | refresh token (mock HTTP) | cargo opt-in | ❌ | P3 |
| Preferências / temas | UI | tokens CSS, i18n keys | Vitest | ✅ | P2 |
| Voz / ditado | Rust | VAD, cloud transcriber | cargo + mock áudio | ❌ | P2 |
| Browser pane / CDP | Rust/UI | spawn webview, política | cargo parcial | ❌ | P2 |
| Remote control | Rust | consent, websocket | Vitest + cargo | ⚠️ | P2 |
| AI Memory | Rust | hooks, persistência | cargo | ⚠️ | P2 |
| Graphify | Rust | MCP config write | cargo | ⚠️ | P3 |
| WSL terminals | Rust | probe paths, gate | cargo (`wsl::tests`) | ✅ Linux | P2 |
| Ghostty backend | Rust | FFI | `test:ghostty` ignored | 🔧 | P3 |
| Updater | FE/Rust | minisign, channel | Vitest `updater` | ⚠️ | P2 |
| CSP / segurança | FE | política literal | `securityPolicy.test.ts` | ✅ | P0 |
| RAM / suspend | FE/Rust | disable terminal/project/group | Vitest limitado | ❌ | P2 |
| i18n | build | chaves em 3 locales | `npm run build` | ✅ | P1 |
| mockIPC / shell | FE | bootstrap sem Tauri | `src/test/*smoke*` | ✅ novo | P1 |
| Playwright smoke | FE | `#root` hidrata com stub | `playwright/shell-mockipc.spec.ts` | ✅ novo (opcional) | P3 |

---

## Lacunas prioritárias (top 10)

1. **P0 — PTY integração completa** (write, resize, kill, scrollback em disco).
2. **P0 — Ponte evento PTY → xterm** com mocks de `listen('pty://data/…')`.
3. **P0 — Agentes com CLI stub** (stdout scriptável, erro de spawn).
4. **P1 — E2E WDIO no CI** (pelo menos `smoke` + `onboarding` em Ubuntu).
5. **P1 — MCP store/catalog** testes Rust + modal Vitest.
6. **P1 — Backup/restore** zip-slip e round-trip.
7. **P2 — Cobertura Istanbul/llvm-cov** com metas por diretório.
8. **P2 — WDIO browser mode** para modais pesados sem build Tauri.
9. **P3 — Playwright** alinhado aos mocks oficiais (ou abandonar em favor de Vitest).
10. **P3 — Suite `ai-live` documentada** com env vars, nunca no CI padrão.

---

## Smokes de viabilidade (adicionados neste doc)

| Teste | Comando |
|-------|---------|
| mockIPC oficial | `npm test -- src/test/mockipc.smoke.test.ts` |
| Shell onboarding | `npm test -- src/test/shell.mockipc.smoke.test.tsx` |
| PTY real (`sh`) | `cd src-tauri && cargo test --lib integration_spawn_sh` |
| Playwright + stub | `npm run test:playwright:smoke` (com Vite livre na 1422) |

---

## Referências

- [Tauri v2 — Mocking](https://v2.tauri.app/develop/tests/mocking/)
- [Tauri v2 — WebDriver](https://v2.tauri.app/develop/tests/webdriver/)
- [WebdriverIO — Tauri quick start](https://webdriver.io/docs/desktop-testing/tauri/quick-start)
- [CONTRIBUTING.md](../CONTRIBUTING.md) — setup e `npm test`
- [FEATURES.md](./FEATURES.md) — capacidades do produto