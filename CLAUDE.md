# RFL Bot

Plataforma de bots de IA persistentes (estilo Grok Bot / OpenBot). O plano completo e as fases estão em `PLANO.md`.

## Regras

- Textos, comentários, logs e mensagens de commit em **português do Brasil**.
- **Direção:** o OpenBot atual é a referência de produto. Antes de criar uma parte nova, veja como ele resolve (docs em `docs/architecture/` do repositório dele) e siga o mesmo comportamento e os mesmos nomes de ferramentas, sem copiar código.
- **Decisões (PLANO.md, seção 14):** uso pessoal agora e venda no futuro; provedores pelo login de assinatura nos CLIs oficiais (modo `api-key` também, para a venda); canal principal WhatsApp via WhatsApp Web (Baileys); VPS compartilhada (sem portas 80/443, API em `127.0.0.1:3100`).
- Os bots só executam coisas no serviço **runner**, que não tem acesso ao banco, ao Redis nem à `ENCRYPTION_KEY`. Credenciais de login dos CLIs ficam com o próprio CLI; nunca leia, copie ou registre em log (nem o link e o código do login).
- **Licença:** só copie código do OpenBot até a versão 0.1.11 (Apache-2.0). Nunca copie código de versões mais novas (PolyForm Noncommercial). Arquivo adaptado leva o cabeçalho descrito em `third_party/openbot-0.1.11/README.md`.
- Toda dependência de terceiros usada por um app (`apps/*`) precisa estar em `dependencies` dele, com `"catalog:"` (versões em `pnpm-workspace.yaml`). O `scripts/build-app.mjs` falha se faltar.
- Pacotes internos (`packages/*`) exportam o TypeScript direto (`src/index.ts`); só os apps são compilados.
- Variáveis de ambiente: schemas Zod em `packages/contracts/src/env.ts`, lidas com `loadEnv` do `@rfl-bot/core`. Atualize `.env.example` e `deploy/.env.example` junto.
- Banco: Prisma 7 com `@prisma/adapter-pg`. Mudou `schema.prisma`? Rode `pnpm db:migrate --name <nome>` e faça commit da migration.

## Comandos

```sh
pnpm services:up      # Postgres + Redis no Docker
pnpm db:deploy        # aplica as migrations
pnpm dev              # api + worker com recarga automática
pnpm check            # lint + tipos + testes (rode antes de cada commit)
pnpm build            # compila api e worker
pnpm db:check         # confere se falta migration para o schema atual
```

Os testes de banco e de fila usam o Postgres e o Redis locais (`pnpm services:up`); sem eles, esses testes são pulados.
