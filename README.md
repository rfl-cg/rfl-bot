# RFL Bot

Plataforma de bots de IA persistentes, com o OpenBot como direção: cada bot tem nome, personalidade, memória e um "computador" próprio, roda nos CLIs oficiais logados com as suas assinaturas (Claude, Codex, Grok…) e conversa pelo WhatsApp. O plano completo está em [PLANO.md](PLANO.md).

**Status:** Fase 0 (base) pronta. Próxima: Fase 1, o primeiro bot no WhatsApp.

## O que tem aqui

```text
apps/
  api/          Fastify: /health e /ready (depois: REST, SSE, webhooks)
  worker/       BullMQ: fila do sistema e batimento (depois: turnos dos bots, rotinas)
packages/
  contracts/    schemas das variáveis de ambiente e tipos compartilhados
  core/         logger, leitura do .env, criptografia de segredos, desligamento seguro
  db/           schema Prisma (todas as tabelas do plano) e migrations
deploy/         Compose de produção, Caddyfile opcional, scripts de deploy e backup
scripts/        build dos apps
third_party/    licença e aviso do OpenBot 0.1.11 (Apache-2.0)
```

## Rodar no seu computador

Precisa de **Node.js 24**, **Docker** e do **pnpm** (`corepack enable` instala a versão certa).

```sh
corepack enable
pnpm install
cp .env.example .env
# Preencha ENCRYPTION_KEY no .env com o resultado de: openssl rand -base64 32

pnpm services:up      # sobe Postgres e Redis no Docker
pnpm db:deploy        # cria as tabelas
pnpm dev              # sobe api e worker
```

Teste em http://localhost:3000/ready. Deve mostrar `database`, `redis` e o batimento do `worker`.

### Comandos

| Comando                         | O que faz                                                  |
| ------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                      | API e worker com recarga automática                        |
| `pnpm check`                    | Lint + tipos + testes. Rode antes de cada commit           |
| `pnpm test`                     | Testes (os de banco e fila precisam do `pnpm services:up`) |
| `pnpm build`                    | Compila api e worker em `dist/`                            |
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
   nano .env   # POSTGRES_PASSWORD e ENCRYPTION_KEY
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

## Licença

Código privado. Partes adaptadas do OpenBot 0.1.11 seguem a Apache-2.0: veja [NOTICE](NOTICE) e [third_party/openbot-0.1.11](third_party/openbot-0.1.11/README.md).
