# RFL Bot

Plataforma de bots de IA persistentes, com o OpenBot como direção: cada bot tem nome, personalidade, memória e um "computador" próprio, roda nos CLIs oficiais logados com as suas assinaturas (Claude, Codex, Grok…) e conversa pelo WhatsApp. O plano completo está em [PLANO.md](PLANO.md).

**Status:** Fase 1 pronta para testar: o primeiro bot no WhatsApp, com o Claude logado pela sua assinatura. Falta só você parear o número e conectar o Claude (veja [Primeiro uso](#primeiro-uso-whatsapp-e-claude)).

## O que tem aqui

```text
apps/
  api/          Fastify: /health e /ready (depois: REST, SSE, painel)
  worker/       fila de turnos por bot, rotinas do sistema, respostas
  whatsapp/     gateway WhatsApp Web (Baileys): mensagens, comandos do dono, envio
  runner/       o "computador dos bots": CLIs dos provedores (Claude) e logins
packages/
  contracts/    schemas Zod: variáveis de ambiente, eventos, mensagens, provedores
  core/         logger, leitura do .env, criptografia de segredos, desligamento seguro
  db/           schema Prisma e migrations
  runner-client/ cliente HTTP do runner (usado pelo worker e pelo WhatsApp)
e2e/            teste de ponta a ponta: mensagem entra, resposta sai
deploy/         Compose de produção, Caddyfile opcional, scripts de deploy e backup
third_party/    licença e aviso do OpenBot 0.1.11 (Apache-2.0)
```

**Como uma mensagem vira resposta:** o `whatsapp` recebe a mensagem e põe na fila do bot → o `worker` pega o turno e manda para o `runner` → o runner roda o CLI do Claude na pasta do bot → a resposta volta pelo worker e sai pelo `whatsapp`. O runner não tem acesso ao banco nem às senhas.

## Rodar no seu computador

Precisa de **Node.js 24**, **Docker** e do **pnpm** (`corepack enable` instala a versão certa).

```sh
corepack enable
pnpm install
cp .env.example .env
# No .env, preencha ENCRYPTION_KEY (openssl rand -base64 32), RUNNER_TOKEN
# (openssl rand -hex 32), WHATSAPP_PHONE e WHATSAPP_OWNER.

pnpm services:up      # sobe Postgres e Redis no Docker
pnpm db:deploy        # cria as tabelas
pnpm dev              # sobe api, worker, runner e whatsapp
```

Teste em http://localhost:3000/ready. Deve mostrar `database`, `redis` e o batimento do `worker`.

No desenvolvimento, `WHATSAPP_CONNECT=false` deixa o gateway sem conectar no WhatsApp, e `RUNNER_ENABLE_ECHO=true` liga o provedor "eco" (responde repetindo a mensagem) para testar sem login. O teste `e2e/` faz o caminho completo sem celular.

### Comandos

| Comando                         | O que faz                                                  |
| ------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                      | API, worker, runner e WhatsApp com recarga automática      |
| `pnpm check`                    | Lint + tipos + testes. Rode antes de cada commit           |
| `pnpm test`                     | Testes (os de banco e fila precisam do `pnpm services:up`) |
| `pnpm build`                    | Compila os apps em `dist/`                                 |
| `pnpm format`                   | Arruma a formatação                                        |
| `pnpm db:migrate --name <nome>` | Cria uma migration depois de mudar o `schema.prisma`       |
| `pnpm db:deploy`                | Aplica as migrations pendentes                             |
| `pnpm db:check`                 | Confere se falta migration para o schema atual             |
| `pnpm db:studio`                | Abre o Prisma Studio para ver os dados                     |
| `pnpm services:down`            | Para Postgres e Redis                                      |

## Deploy na VPS (Hostinger, compartilhada com outros apps)

O RFL Bot não ocupa as portas 80 e 443. A API fica só em `127.0.0.1:3100`, e o proxy que já existe na VPS encaminha o domínio para ela. Postgres e Redis são próprios do bot, sem portas abertas, e cada container tem limite de memória.

Uma vez só:

1. **Domínio:** crie um registro A (ex.: `bot.seudominio.com.br`) apontando para o IP da VPS.
2. **Docker:** se ainda não tiver, `curl -fsSL https://get.docker.com | sh` e depois `sudo usermod -aG docker $USER` (saia e entre de novo no SSH).
3. **Código:** o repositório é privado. Gere uma chave na VPS (`ssh-keygen -t ed25519`) e cadastre a pública (`~/.ssh/id_ed25519.pub`) como _deploy key_ (só leitura) em GitHub → Settings → Deploy keys. Depois:

   ```sh
   sudo mkdir -p /opt/rfl-bot && sudo chown $USER /opt/rfl-bot
   git clone git@github.com:rfl-cg/rfl-bot.git /opt/rfl-bot
   ```

4. **Configuração:**

   ```sh
   cd /opt/rfl-bot/deploy
   cp .env.example .env
   nano .env   # POSTGRES_PASSWORD, ENCRYPTION_KEY, RUNNER_TOKEN e os números do WhatsApp
   ```

   Guarde uma cópia da `ENCRYPTION_KEY` fora da VPS. Sem ela, as chaves salvas no banco não abrem mais.

5. **Subir:** `./deploy.sh`. Teste na própria VPS: `curl http://127.0.0.1:3100/ready`.
6. **Domínio no proxy que já existe** (escolha o seu):

   **Nginx** (com HTTPS pelo `certbot --nginx -d bot.seudominio.com.br`):

   ```nginx
   server {
       server_name bot.seudominio.com.br;
       location / {
           proxy_pass http://127.0.0.1:3100;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;      # eventos ao vivo (SSE)
           proxy_read_timeout 1h;
       }
   }
   ```

   **Caddy instalado na VPS:**

   ```caddyfile
   bot.seudominio.com.br {
       reverse_proxy 127.0.0.1:3100
   }
   ```

   **Proxy rodando dentro do Docker** (Caddy, Nginx ou Traefik de outro app): no `deploy/.env` do bot, troque para `API_BIND=172.17.0.1` e rode `./deploy.sh` de novo. No serviço do proxy, adicione `extra_hosts: ["host.docker.internal:host-gateway"]` e aponte o domínio para `host.docker.internal:3100`.

   **VPS sem nenhum proxy:** use o Caddy incluso. No `deploy/.env`, coloque `COMPOSE_PROFILES=caddy` e `APP_DOMAIN=bot.seudominio.com.br`, e rode `./deploy.sh`.

7. **Backup diário** (`crontab -e`):

   ```cron
   0 3 * * * /opt/rfl-bot/deploy/backup.sh >> /var/log/rfl-bot-backup.log 2>&1
   ```

   Guarda 7 dias em `deploy/backups/`. Copie também para fora da VPS (ex.: `rclone` para Google Drive).

**Deploy automático** a cada push na `main` (depois do CI passar). Em GitHub → Settings → Secrets and variables → Actions:

- Segredos: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (chave privada que entra na VPS) e `VPS_PORT` se não for 22
- Variável: `DEPLOY_ENABLED` = `true`

### Restaurar um backup

```sh
cd /opt/rfl-bot/deploy
docker compose stop api worker
docker compose exec -T postgres dropdb -U rflbot rflbot
docker compose exec -T postgres createdb -U rflbot rflbot
zcat backups/rflbot-AAAAMMDD-HHMMSS.sql.gz | docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U rflbot -d rflbot
docker compose start api worker
```

## Primeiro uso: WhatsApp e Claude

Depois do `./deploy.sh`, na pasta `deploy/` da VPS:

1. **Parear o WhatsApp** (uma vez só). Veja o código:

   ```sh
   docker compose logs whatsapp | grep -i parear
   ```

   O código de 8 letras aparece no campo `pairingCode`. No celular **do número do bot**: _WhatsApp → Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone_, e digite o código. Ele muda a cada minuto; se expirar, rode o comando de novo.

2. **Conectar o Claude:** do **seu** WhatsApp (o `WHATSAPP_OWNER`), mande para o número do bot:

   ```text
   /login claude
   ```

   O bot responde com um link. Abra, entre com a conta que tem a assinatura (Pro ou Max), copie o código que a página mostra e mande `/codigo SEU_CÓDIGO`.

3. **Conversar:** mande qualquer mensagem. Quem atende é o bot padrão, o _Assistente_. Para falar com outro bot, comece com `@Nome`.

**Comandos do dono** (só do seu número):

| Comando                          | O que faz                                      |
| -------------------------------- | ---------------------------------------------- |
| `/ajuda`                         | Lista os comandos                              |
| `/bots`                          | Lista os bots                                  |
| `/novo Nome \| instruções`       | Cria um bot                                    |
| `/padrao Nome`                   | Bot que atende quem escreve sem @              |
| `/instrucoes Nome \| texto`      | Muda a personalidade do bot                    |
| `/modelo Nome modelo`            | Troca o modelo (ex.: `claude-sonnet-5-5`)      |
| `/login claude` · `/codigo X`    | Conecta a sua assinatura do Claude             |
| `/provedores` · `/status`        | Mostra o que está conectado e a situação geral |
| `/fila`                          | O que cada bot está fazendo                    |
| `/parar [Nome]`                  | Cancela o que o bot está fazendo               |
| `/pausar Nome` · `/retomar Nome` | Pausa e retoma um bot                          |
| `/nova [Nome]`                   | Conversa nova: o bot esquece este chat         |

**Cuidados com o WhatsApp Web:** use um chip só para o bot. Só respondem os números em `WHATSAPP_OWNER` e `WHATSAPP_ALLOWED`; o resto é ignorado. Há um limite de mensagens por minuto (`WHATSAPP_MAX_PER_MINUTE`). Se o celular desconectar o aparelho, o gateway mostra um código novo nos logs.

**Logins e arquivos dos bots** ficam no volume `runner-data`; a sessão do WhatsApp, no volume `whatsapp-data`. Apagar um volume = logar ou parear de novo.

## Licença

Código privado. Partes adaptadas do OpenBot 0.1.11 seguem a Apache-2.0: veja [NOTICE](NOTICE) e [third_party/openbot-0.1.11](third_party/openbot-0.1.11/README.md).
