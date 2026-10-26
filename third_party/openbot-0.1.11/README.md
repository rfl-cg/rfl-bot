# OpenBot 0.1.11 (Apache-2.0)

- **Origem:** https://github.com/nightly-labs/openbot/tree/v0.1.11
- **Commit:** `e9cae2ac7c83936a6e7d22c820e9d7ec0726d880`
- **Licença:** Apache License 2.0 ([LICENSE](LICENSE)) — permite uso comercial.
- **Aviso original:** [NOTICE](NOTICE)

## Regra

Só copiamos código **desta versão**. As versões do OpenBot depois da 0.1.11 usam a
PolyForm Noncommercial 1.0.0, que **proíbe uso comercial**. Delas usamos apenas ideias
de arquitetura, nunca código.

## O que vamos adaptar (Fase 1 em diante)

| Arquivo original                   | Vira                                 |
| ---------------------------------- | ------------------------------------ |
| `src/backend/claude-client.ts`     | `packages/drivers/claude`            |
| `src/backend/app-server-client.ts` | `packages/drivers/codex`             |
| `src/backend/jsonl.ts`             | leitor de JSON por linha dos drivers |
| `src/backend/agent-client.ts`      | interface comum dos drivers          |
| `src/backend/mailbox-store.ts`     | mensagens entre bots (no Postgres)   |
| `src/backend/agent-service.ts`     | lógica da fila por bot               |

## Como marcar um arquivo adaptado

A Apache-2.0 exige avisar que o arquivo foi alterado. Coloque no topo:

```ts
// Adaptado de OpenBot 0.1.11 (src/backend/claude-client.ts), Apache-2.0, com alterações.
// Licença e aviso originais em third_party/openbot-0.1.11/.
```
