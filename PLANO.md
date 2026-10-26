# RFL Bot — Plano do Backend

Plataforma de **bots de IA persistentes**, no estilo do Grok Bot, OpenBot e OpenMausBot: cada bot tem nome, personalidade, memória, um "computador" próprio e apps conectados. Você conversa com eles pela web, WhatsApp ou Telegram, e eles também conversam entre si.

> **Status:** rascunho para aprovação. As decisões que preciso de você estão na seção 14.
> **Onde roda:** servidor sempre ligado (VPS Hostinger), não no seu computador. **Stack:** Node.js + TypeScript.

---

## 1. O que vamos construir

| Recurso | Como fica no RFL Bot |
|---|---|
| **Bots persistentes** | Cada bot tem nome, avatar, instruções (personalidade), modelo de IA e histórico que não se perde |
| **Vários "cérebros"** | Claude (Anthropic), Codex/GPT (OpenAI), Grok (xAI) e modelos locais (Ollama). Dá para trocar o modelo sem perder a conversa |
| **Memória** | O bot guarda fatos ("o cliente prefere entrega rápida") e consulta quando precisa |
| **Computador do bot** | Uma pasta e um ambiente isolado (container) onde o bot cria arquivos, roda comandos e abre sites |
| **Fila de tarefas** | Você manda várias tarefas; o bot faz uma por vez, na ordem. Dá para pausar e cancelar |
| **Time de bots** | Um bot pergunta ou passa uma tarefa para outro ("Financeiro, me manda o total de outubro") |
| **Rotinas** | Tarefas agendadas ("todo dia às 8h, resuma os pedidos") ou disparadas por webhook |
| **Apps conectados** | Gmail, Google Agenda, Notion, GitHub etc. via MCP. Dá para conectar o seu Hub de Marketplaces também |
| **Aprovações** | Antes de uma ação sensível (enviar e-mail, apagar algo, gastar dinheiro), o bot pede um "ok" com botões |
| **Canais** | Web (chat ao vivo), WhatsApp e Telegram |

### Comparação

| | Grok Bot (xAI) | OpenBot | OpenMausBot | **RFL Bot (nosso)** |
|---|---|---|---|---|
| Onde roda | Nuvem da xAI | Seu computador (app desktop) ou servidor | Seu computador (servidor local + app) ou VPS | **Sua VPS, sempre ligado** |
| Cérebros | Grok | Codex, Claude, Grok, Gemini, OpenCode, Cursor, Cline, Ollama | Claude, Codex, Grok, compatíveis com OpenAI | Claude, Codex, Grok, Ollama |
| Licença | Fechado | **PolyForm Noncommercial** | Apache-2.0 (menos a pasta `enterprise/`) | Seu |
| Canais | App desktop e iOS | Desktop, celular, Slack, Discord, Telegram | Desktop, web, celular | Web, **WhatsApp**, Telegram |

---

## 2. O que estudei no código do OpenBot

Repositório: `github.com/nightly-labs/openbot` (versão 0.51.1).

- **Tamanho:** cerca de 265 mil linhas de TypeScript só no núcleo (`src/`), mais apps de celular, Slack, Discord e Telegram.
- **Stack:** Electron + SolidJS (interface), Bun, SQLite (registro de eventos), Effect, Cloudflare Workers (contas).
- **Como funciona:** é um app **desktop**. O "backend" roda dentro do Electron, no computador do usuário:

```text
Electron (processo principal)
├── Codex App Server   ← conversa por stdio (JSON por linha)
├── Claude Agent SDK   ← conversa por stream JSON
├── Grok, Gemini, OpenCode, Cursor, Cline ← via ACP (Agent Client Protocol)
├── SQLite: registro de eventos + filas por agente + caixa de mensagens entre agentes
└── navegador embutido que os agentes controlam
```

- **Ideias boas que vamos reaproveitar:** um adaptador ("driver") por provedor de IA, registro de eventos que nunca se apaga, fila FIFO por agente, caixa de mensagens entre agentes, memórias e rotinas por agente, skills em pastas com `SKILL.md`.

### ⚠️ Licença: o ponto mais importante deste plano

| Base de código | Licença | Pode usar para ganhar dinheiro? | Tamanho | O que faremos com ela |
|---|---|---|---|---|
| **OpenBot atual** (0.51) | PolyForm Noncommercial 1.0.0 | **Não.** Empresa com fins lucrativos, mesmo uso interno, precisa comprar licença (`licenses@openbot.run`) | ~265 mil linhas | **Só referência de arquitetura.** Ideias não têm direitos autorais; o código tem. Não copiamos código desta versão |
| **OpenBot até a 0.1.11** | Apache-2.0 | **Sim**, mantendo o aviso de licença (NOTICE) | ~17 mil linhas | **Portar código** (lista abaixo) |
| **OpenMausBot** | Apache-2.0 (menos `enterprise/`) | **Sim**, mas com outro nome (a marca é registrada) | Grande | Modelo do servidor: registro de drivers + barramento de eventos + SSE |

**Código que vamos portar do OpenBot 0.1.11** (tag `v0.1.11`, Apache-2.0):

| Arquivo original | Linhas | Vira |
|---|---|---|
| `src/backend/claude-client.ts` | 688 | `packages/drivers/claude` — Claude via Agent SDK |
| `src/backend/app-server-client.ts` | 213 | `packages/drivers/codex` — Codex App Server |
| `src/backend/jsonl.ts` | — | leitor de JSON por linha (usado nos drivers e no runner) |
| `src/backend/agent-client.ts` | — | interface comum dos drivers |
| `src/backend/mailbox-store.ts` | 986 | mensagens entre bots (trocando arquivo JSON por PostgreSQL) |
| `src/backend/agent-service.ts` | 1.888 | lógica da fila por bot e entrega de respostas (reescrita em cima do banco) |

O que o 0.1.11 **não tem** (Grok, memória, rotinas, canais, servidor) vamos escrever nós mesmos, olhando como o OpenBot atual e o OpenMausBot resolvem.

### ⚠️ Termos da Anthropic (Claude)

A Anthropic diz que **produtos e serviços devem usar chave de API**, não o login de assinatura (Pro/Max). Então o RFL Bot usa **chave de API** de cada provedor (a sua, ou a do cliente se virar produto). Isso também vale como cuidado para OpenAI e xAI.

---

## 3. Arquitetura

```text
  CANAIS                    BACKEND (VPS)                              CÉREBROS
┌──────────┐ webhook  ┌───────────────────────────────┐
│ WhatsApp │─────────▶│  API  (Fastify)               │
│ Telegram │─────────▶│  REST · SSE · webhooks        │
│ Web      │◀── SSE ──│  login · bots · conversas     │
└──────────┘          └───────────────┬───────────────┘
                                      │ cria o turno e enfileira
                      ┌───────────────▼───────────────┐
                      │  WORKER  (o "harness")        │── Claude Agent SDK ──▶ Anthropic
                      │  fila FIFO por bot            │── Codex App Server ──▶ OpenAI
                      │  registro de drivers          │── Compatível OpenAI ─▶ xAI (Grok) · OpenRouter · Ollama
                      │  rotinas · memória · aprovação│
                      └───────────────┬───────────────┘
                                      │ Docker API (Fase 3)
                      ┌───────────────▼───────────────┐
                      │ COMPUTADOR DO BOT (container) │
                      │ runner + CLI do provedor      │
                      │ /workspace · bash · Chromium  │
                      └───────────────────────────────┘

   PostgreSQL: dados, registro de eventos, memória      Redis: filas, eventos ao vivo, limites
```

**Peças:**

1. **API** — recebe mensagens (web, WhatsApp, Telegram), confere assinaturas dos webhooks, grava tudo e cria o turno. Manda os eventos ao vivo para a web por **SSE** (um único fluxo de eventos, como o OpenMausBot faz).
2. **Worker (harness)** — pega o próximo turno de cada bot, monta o contexto (instruções + memórias + skills), escolhe o driver e repassa os eventos.
3. **Drivers** — um por provedor. Todos falam a mesma "língua" de eventos para o resto do sistema:

```ts
interface BotDriver {
  id: "claude" | "codex" | "openai-compat" | "acp";
  startTurn(input: TurnInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  resolveApproval(approvalId: string, decision: "allow" | "deny"): Promise<void>;
}

type RuntimeEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.started"; name: string; input: unknown }
  | { type: "tool.finished"; name: string; ok: boolean }
  | { type: "approval.requested"; approvalId: string; summary: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "turn.completed"; finalText: string }
  | { type: "turn.failed"; error: string };
```

4. **Computador do bot (Fase 3)** — um container Docker por bot, com volume próprio. O agente (CLI do Claude ou Codex) roda **dentro** do container, então comandos e arquivos do bot nunca tocam o servidor. O worker conversa com o container por stdio (JSON por linha), do mesmo jeito que o OpenBot conversa com os CLIs.

> **Plano B para o computador do bot:** o **Claude Managed Agents** (beta da Anthropic) já roda o agente e hospeda um ambiente isolado por sessão, com agendamento, memória e cofre de chaves. Economiza a Fase 3, mas só funciona com Claude e prende a gente na Anthropic. Fica como opção de driver no futuro.

---

## 4. Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | **TypeScript, Node.js 24** | Mesma linguagem do OpenBot e do OpenMausBot: dá para portar código direto |
| Monorepo | **pnpm workspaces + Turborepo** | API, worker, runner e pacotes no mesmo repositório |
| API HTTP | **Fastify 5 + Zod** | Rápido, SSE simples, validação de entrada |
| Tempo real | **SSE** | Um fluxo de eventos por usuário; mais simples que WebSocket |
| Banco | **PostgreSQL 16 + Prisma** | Mesmo padrão do Hub de Marketplaces |
| Busca na memória | **Busca de texto do Postgres (português)**, depois **pgvector** | Sem custo extra no começo |
| Filas e agendamento | **Redis 7 + BullMQ** | Rotinas (cron), novas tentativas, jobs de fundo. O estado oficial da fila fica no Postgres para não perder nada se o servidor reiniciar |
| Eventos ao vivo | **Redis pub/sub** | Worker → API → SSE |
| Cérebro Claude | **`@anthropic-ai/claude-agent-sdk`** | O mesmo que o OpenBot usa; já vem com ferramentas de arquivo, bash e web |
| Cérebro OpenAI | **Codex App Server** | Driver portado do OpenBot 0.1.11 |
| Grok e outros | **Driver compatível com OpenAI** | Um driver cobre xAI (Grok), OpenRouter, DeepSeek e Ollama |
| Ferramentas do bot | **Servidor MCP interno** (`@modelcontextprotocol/sdk`) | Memória, delegar, rotinas, aprovação, envio de arquivos |
| Apps conectados | **MCP remoto** + **Composio** (opcional) | Gmail, Agenda, Notion, GitHub, Slack… |
| Computador do bot | **Docker por bot** (`dockerode`) + **docker-socket-proxy** | Isola arquivos e comandos; o worker não ganha acesso total ao Docker |
| Navegador do bot | **Playwright + Chromium** dentro do container | Ler e preencher sites |
| WhatsApp | **WhatsApp Cloud API (oficial da Meta)** | Sem risco de banimento; botões para aprovações |
| Telegram | **grammY** | Simples; ótimo para testar desde o começo |
| Login | **Better Auth** (e-mail + código, Google) | Pronto para TypeScript |
| Segredos | **AES-256-GCM** com chave mestra no `.env` | Chaves de API e tokens criptografados no banco |
| Logs e erros | **Pino + Sentry** | |
| Testes | **Vitest** | |
| Deploy | **Docker Compose + Caddy** na VPS Hostinger | Mesmo padrão do outro projeto |

**Modelos Claude (preço por milhão de tokens, entrada / saída):**

| Modelo | ID | Preço | Uso sugerido |
|---|---|---|---|
| Claude Opus 5.5 | `claude-opus-5-5` | US$ 4 / US$ 20 | Padrão dos bots |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | US$ 2 / US$ 10 | Opção mais barata por bot |
| Claude Haiku 5.5 | `claude-haiku-5-5` | US$ 0,10 / US$ 0,50 | Tarefas pequenas (ex.: extrair memória), se você aprovar |

O modelo é escolhido **por bot** na tela de configuração.

---

## 5. Banco de dados (resumo do schema Prisma)

```prisma
model Workspace {          // "empresa" ou conta. Prepara para multiusuário
  id        String @id @default(cuid())
  name      String
  members   Member[]
  bots      Bot[]
  secrets   Secret[]
}

model Bot {
  id           String @id @default(cuid())
  workspaceId  String
  name         String
  avatarUrl    String?
  instructions String            // personalidade e regras
  provider     String            // claude | codex | openai-compat | acp
  model        String            // ex.: claude-opus-5-5
  effort       String?           // low | medium | high…
  settings     Json              // ferramentas liberadas, limites de gasto etc.
  sandboxId    String?           // container (Fase 3)
  status       String            // idle | working | paused
}

model Conversation {
  id             String @id @default(cuid())
  botId          String
  channel        String          // web | whatsapp | telegram | bot
  externalChatId String?         // número do WhatsApp, chat do Telegram
  title          String?
}

model Message {
  id             String @id @default(cuid())
  conversationId String
  role           String          // user | bot | system | tool
  content        Json            // texto + anexos
  authorId       String?         // usuário ou outro bot
  createdAt      DateTime @default(now())
}

model Turn {                     // uma "rodada" de trabalho do bot = item da fila
  id             String @id @default(cuid())
  botId          String
  conversationId String
  status         String          // queued | running | waiting_approval | done | failed | canceled
  provider       String
  model          String
  inputTokens    Int @default(0)
  outputTokens   Int @default(0)
  costUsd        Decimal @default(0)
  queuedAt       DateTime @default(now())
  startedAt      DateTime?
  endedAt        DateTime?
}

model Event {                    // registro que nunca se apaga (ideia do OpenBot)
  id      BigInt @id @default(autoincrement())
  turnId  String
  seq     Int
  type    String                 // text.delta, tool.started…
  payload Json
}

model ProviderSession { botId String; provider String; nativeSessionId String }  // retomar sessão do provedor
model Memory   { id String @id; botId String; kind String; content String; source String?; createdAt DateTime }
model Routine  { id String @id; botId String; name String; cron String?; timezone String; prompt String; webhookToken String?; enabled Boolean }
model Mailbox  { id String @id; fromBotId String; toBotId String; body String; status String; replyToId String? }
model Approval { id String @id; turnId String; tool String; args Json; status String; decidedBy String?; decidedAt DateTime? }
model ChannelBinding { id String @id; workspaceId String; channel String; externalId String; botId String }
model Integration    { id String @id; workspaceId String; botId String?; type String; config Json; secretId String? }
model Secret   { id String @id; workspaceId String; kind String; ciphertext Bytes }   // chaves de API criptografadas
model Skill    { id String @id; workspaceId String; name String; version Int; files Json }
```

---

## 6. Como um turno funciona

1. **Chega uma mensagem** — pela web (`POST /conversations/:id/messages`) ou por webhook (WhatsApp/Telegram). A API confere a assinatura do webhook e descobre o bot pelo `ChannelBinding`.
2. **Grava e enfileira** — salva a `Message`, cria um `Turn` com status `queued` e avisa o worker.
3. **Um turno por vez por bot** — o worker trava o bot, pega o turno mais antigo da fila dele e muda para `running`. Bots diferentes trabalham em paralelo.
4. **Monta o contexto** — instruções do bot + memórias relevantes + skills + ferramentas liberadas. Retoma a sessão do provedor (`ProviderSession`) para não reenviar o histórico todo.
5. **Driver executa** — os eventos (texto, ferramentas, uso) vão para o registro `Event` e, ao vivo, para a web via SSE. No WhatsApp/Telegram vai o "digitando…" e depois a resposta final.
6. **Aprovação, se precisar** — ferramenta marcada como sensível pausa o turno (`waiting_approval`) e manda um pedido com botões **Aprovar / Negar** no canal. A resposta libera ou cancela.
7. **Fim** — grava a resposta, tokens e custo. Um job de fundo extrai memórias novas. O próximo turno da fila começa.

**Rotina:** o agendador (BullMQ) cria um `Turn` na hora marcada, como se fosse uma mensagem.
**Bot → bot:** a ferramenta `bots.ask` cria um turno na fila do outro bot e espera a resposta; `bots.delegate` só entrega a tarefa.

---

## 7. Ferramentas que todo bot ganha (servidor MCP interno)

| Ferramenta | O que faz |
|---|---|
| `memory.save` / `memory.search` / `memory.forget` | Guardar, buscar e apagar memórias |
| `bots.list` / `bots.ask` / `bots.delegate` | Ver o time, perguntar a outro bot, passar uma tarefa |
| `routines.create` / `routines.list` / `routines.pause` | O próprio bot agenda rotinas ("me lembra toda segunda") |
| `channel.reply` | Mandar uma mensagem no meio do trabalho ("já estou vendo isso") |
| `files.send` | Enviar um arquivo do computador do bot para o usuário |
| `skills.list` / `skills.read` | Usar skills (passo a passo salvos em `SKILL.md`) |
| `approval.request` | Pedir aprovação de forma explícita |

---

## 8. Canais

- **Web** — API REST + SSE. Na Fase 4 ganha um painel completo em Next.js.
- **WhatsApp (Cloud API oficial)** — webhook com assinatura (`X-Hub-Signature-256`), texto, áudio, imagem, arquivo e botões.
  - **Regra das 24 horas da Meta:** o bot responde livremente até 24h depois da última mensagem do usuário. Fora disso (ex.: rotina que manda resumo de manhã), só com **modelo de mensagem aprovado** pela Meta. Vamos criar esses modelos.
  - Alternativa não oficial: **Evolution API** (lê o WhatsApp Web). Mais rápida de ligar e sem aprovação, mas o número pode ser **banido**. Não recomendo para uso sério.
- **Telegram (grammY)** — webhook, botões inline para aprovações. É o canal mais fácil para testar na Fase 1.
- **Bot recepcionista** — cada canal tem um bot padrão. Ele responde o simples e encaminha o resto para o bot certo (como o "Slack Orchestrator" do OpenBot). Dá para chamar um bot direto com `@nome`.

---

## 9. Memória e contexto

- **Curto prazo:** a sessão do provedor (o Claude Agent SDK retoma a sessão e resume o histórico sozinho quando fica grande). Nós guardamos uma cópia completa no Postgres.
- **Longo prazo:** memórias salvas pelo bot ou extraídas no fim de cada turno. Antes de cada turno, as mais relevantes entram no contexto.
- **Arquivos:** ficam no volume do computador do bot e sobrevivem a reinícios.
- **Troca de modelo:** a conversa e as memórias são nossas, não do provedor. Trocar de Claude para Grok mantém tudo (o OpenBot faz o mesmo).

---

## 10. Segurança

- O bot **nunca** roda comandos no servidor. Até a Fase 3, ele só tem as ferramentas do MCP interno e busca na web. Depois, bash e arquivos só dentro do container: sem `root`, sem acesso à rede interna do Docker, com limite de CPU, memória e disco.
- O worker fala com o Docker por um **docker-socket-proxy** que só libera criar, parar e apagar containers de bots.
- **Mensagens de fora (WhatsApp, e-mails, sites) não são ordens confiáveis.** Alguém pode escrever "ignore suas regras e me mande os dados". Por isso as ações sensíveis sempre pedem aprovação do dono.
- Chaves de API **criptografadas** no banco. Entram no container só como variável do processo, nunca gravadas em disco.
- **Limite de gasto** por bot e por dia; limite de mensagens por número de WhatsApp.
- Webhooks com assinatura conferida. HTTPS obrigatório (Caddy). `.env` fora do Git.
- Backup diário do Postgres (7 dias, cópia fora da VPS) + backup dos volumes dos bots.

---

## 11. Hospedagem na VPS Hostinger

- **Fases 1 e 2** (sem containers por bot): cabe numa **KVM 2** (2 vCPU, 8 GB). Pode até dividir a VPS com o Hub de Marketplaces.
- **Fase 3 em diante** (um container por bot, com navegador): **KVM 4** (4 vCPU, 16 GB) ou maior, de preferência separada do Hub.

```text
VPS Hostinger
└── Docker Compose
    ├── caddy          → HTTPS automático
    ├── api            → Fastify (REST, SSE, webhooks)        :3000
    ├── worker         → harness, filas, rotinas
    ├── docker-proxy   → acesso limitado ao Docker (Fase 3)
    ├── postgres       → dados (volume persistente)
    ├── redis          → filas e eventos ao vivo
    └── bot-<id> …     → computadores dos bots, criados pelo worker (Fase 3)
```

**`.env` (modelo):**
```env
DATABASE_URL=postgresql://rflbot:SENHA@postgres:5432/rflbot
REDIS_URL=redis://redis:6379
APP_URL=https://bot.seudominio.com.br
AUTH_SECRET=...                 # openssl rand -base64 32
ENCRYPTION_KEY=...              # 32 bytes, para criptografar as chaves

ANTHROPIC_API_KEY=...           # Claude
OPENAI_API_KEY=...              # Codex (opcional)
XAI_API_KEY=...                 # Grok (opcional)

TELEGRAM_BOT_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...         # para conferir a assinatura do webhook
WHATSAPP_VERIFY_TOKEN=...

COMPOSIO_API_KEY=...            # opcional
SENTRY_DSN=...                  # opcional
```

Deploy automático igual ao outro projeto: GitHub Actions → SSH na VPS → `git pull && docker compose up -d --build`.

---

## 12. Estrutura de pastas

```text
rfl-bot/
├── apps/
│   ├── api/              # Fastify: REST, SSE, webhooks do WhatsApp e Telegram
│   ├── worker/           # harness: fila dos bots, rotinas, memória, containers
│   └── web/              # (Fase 4) painel e chat em Next.js
├── packages/
│   ├── core/             # regras: bots, turnos, fila, eventos, aprovações
│   ├── db/               # schema Prisma + migrations
│   ├── drivers/          # claude/  codex/  openai-compat/  (acp/ depois)
│   ├── runner/           # processo que roda DENTRO do computador do bot
│   ├── tools/            # servidor MCP interno (memória, bots, rotinas…)
│   ├── channels/         # whatsapp/  telegram/  web/
│   ├── sandbox/          # cria, liga e para containers (dockerode)
│   └── contracts/        # tipos e schemas Zod compartilhados
├── docker/
│   └── bot-sandbox/      # imagem do computador do bot (Node, CLIs, Chromium)
├── deploy/               # docker-compose.yml, Caddyfile, scripts de backup
├── third_party/
│   └── openbot-0.1.11/   # LICENSE Apache-2.0 + NOTICE do código portado
├── NOTICE
└── PLANO.md
```

**Principais rotas da API:**

| Rota | Para quê |
|---|---|
| `/auth/*` | Login (Better Auth) |
| `GET/POST/PATCH/DELETE /bots` | Criar e configurar bots |
| `GET /bots/:id/conversations` · `POST /conversations/:id/messages` | Conversar |
| `GET /events` (SSE) | Eventos ao vivo de todos os bots |
| `POST /turns/:id/cancel` · `POST /bots/:id/pause` | Controlar a fila |
| `POST /approvals/:id` | Aprovar ou negar uma ação |
| `/routines` · `POST /hooks/:token` | Rotinas e gatilho por webhook |
| `/memories` · `/skills` · `/integrations` · `/secrets` | Memória, skills, apps conectados, chaves |
| `POST /webhooks/whatsapp` · `POST /webhooks/telegram` | Entrada dos canais |
| `GET /usage` | Tokens e custo por bot e por dia |

---

## 13. Fases de entrega

| Fase | Entrega | O que você precisa providenciar |
|---|---|---|
| **0. Base** | Monorepo, Docker de desenvolvimento (Postgres + Redis), CI, avisos de licença, deploy na VPS com HTTPS | Domínio + acesso à VPS |
| **1. Primeiro bot** | Criar bots, chat pela API com SSE, driver Claude (portado do OpenBot), fila por bot, histórico, **Telegram** | Chave de API da Anthropic; bot criado no @BotFather |
| **2. Time de bots** | Memória, rotinas, bot ↔ bot, aprovações, custo por bot, **WhatsApp** | Número + app na Meta (WhatsApp Business Platform) e modelos de mensagem aprovados |
| **3. Computador do bot** | Container por bot (arquivos, bash, navegador), apps via MCP/Composio, drivers **Codex**, **Grok** e **Ollama** | Chaves da OpenAI e da xAI (opcional); conta Composio (opcional); VPS maior |
| **4. Produto** | Painel web completo (Next.js), vários usuários, cobrança (Stripe, Mercado Pago ou Asaas com Pix), PWA para celular, métricas | Conta no meio de pagamento escolhido |

**Ideia para depois:** um bot "Vendedor" conectado ao Hub de Marketplaces por MCP, que responde perguntas sobre estoque e pedidos pelo WhatsApp.

---

## 14. Decisões para aprovar

1. **Vai virar produto ou é só para uso pessoal?**
   - Se for só para você, sem fim comercial: o **OpenBot** já faz quase tudo isso e pode ser instalado hoje, sem programar nada.
   - Se for para a empresa ou para vender (mesmo uso interno de empresa conta como comercial na licença do OpenBot): seguimos este plano.
2. **Base de código** — recomendo a opção **A**:
   - **A (recomendado):** backend novo para servidor, portando o código Apache do **OpenBot 0.1.11** e seguindo o modelo de servidor do **OpenMausBot**. Pode vender, e o código é nosso.
   - **B:** usar o OpenBot atual. Só para uso não comercial, ou comprando a licença comercial deles.
   - **C:** fork do OpenMausBot inteiro. Já vem pronto, mas é enorme, pensado para desktop, e teria que trocar o nome.
3. **Cérebro principal:** Claude com chave de API e `claude-opus-5-5` como padrão (cada bot pode trocar)? Grok e Codex entram na Fase 3.
4. **Canal prioritário:** WhatsApp oficial (recomendado), Evolution API (não oficial) ou só Telegram no começo?
5. **Nome do produto:** "RFL Bot" por enquanto. Não podemos usar "OpenBot" nem "OpenMausBot".
6. **VPS:** a mesma do Hub de Marketplaces nas Fases 1 e 2, ou uma separada desde o início?

---

## Fontes

- OpenBot — site: https://openbot.run · código: https://github.com/nightly-labs/openbot · licença: `LICENSE` e `NOTICE` do repositório · termos dos provedores: `docs/provider-terms.md`
- OpenBot 0.1.11 (Apache-2.0): https://github.com/nightly-labs/openbot/tree/v0.1.11
- OpenMausBot: https://github.com/milind-soni/OpenMausBot · `LICENSING.md`
- Grok Bot (xAI): https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview
