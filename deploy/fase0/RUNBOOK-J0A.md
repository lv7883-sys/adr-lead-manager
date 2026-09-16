# Runbook J0-A — Backup completo, teste de restauração e contagem diária

- **ADR:** ADR-051, Fase 0 (§6, §10a, §10b, §12) · anexo A (C3, X2, X9)
- **Janela:** domingo **20/09/2026, 13h–19h (Brasília)** = 16:00–22:00 UTC. **Hard stop às 19h**.
- **Plantão:** Leo, pelo WhatsApp.
- **Executor:** agente, seguindo este roteiro **sem improvisar**. Qualquer passo fora do roteiro = parar e avisar.

## 1. Escopo fechado

**Entra:**
1. Scripts em `/root/adr-fase0/` (cópia de `deploy/fase0/` num SHA registrado).
2. Senha do repositório de backup gerada **no servidor** (`/root/.adr-backup/restic.pass`, modo 600). O agente **não lê nem imprime** o valor.
3. Primeiro `backup-v2.sh` manual. Leva roles, os 3 bancos (`adr_scheduler`, `evolution`, `financial_app`), mídias do LM (1,1 GB), `/data` do dashboard e sessões do WhatsApp, num repositório restic local cifrado.
4. `restore-test.sh` (T-RESTORE-01) em Postgres isolado. **Tem de dar APROVADO.**
5. Primeira `contagem-referencia.sh` (baseline).
6. Três linhas novas no crontab (UTC):
   ```
   10 1 * * * /root/adr-fase0/contagem-referencia.sh >> /var/log/adr-contagem/cron.log 2>&1
   30 1 * * * /root/adr-fase0/backup-v2.sh >> /var/log/adr-backup-v2/backup.log 2>&1
   0 16 * * 0 /root/adr-fase0/restore-test.sh >> /var/log/adr-backup-v2/restore-cron.log 2>&1
   ```
   Horários em Brasília: contagem às 22:10, backup às 22:30, teste de restauração todo domingo às 13h.

**Não entra (fica para outras janelas):** cópia para o Backblaze B2 (entra sozinha quando o Leo criar `/root/.adr-backup/b2.env`; ver §7); alerta pelo WhatsApp; esconder "excluir franquia"; qualquer deploy de aplicação; qualquer mudança em tabela, código de produção, crontab existente ou no `backup.sh` antigo.

**O que NÃO muda em produção:** nenhum container de aplicação é reiniciado; nenhuma linha do banco é escrita; o `backup.sh` antigo continua rodando igual.

## 2. Pré-voo (qualquer item falhou = NO-GO, sem mexer em nada)

| # | Checagem | Comando (só leitura) | GO se |
|---|---|---|---|
| P1 | Horário | `date -u` | entre 16:00 e 21:00 UTC |
| P2 | Pausa avisada | mensagem às sessões ativas | todas confirmaram, ou não há sessão ativa |
| P3 | Espaço em disco | `df -BG /var` | ≥ 40 GB livres |
| P4 | Backup antigo da noite ok | `tail -3 /var/log/adr-backup.log` | "Backup completo." de hoje |
| P5 | Sem transação longa / pg_dump | `SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle' AND now() - xact_start > interval '60 seconds'` | 0 |
| P6 | Sem sincronização longa em execução | `ps aux \| grep -E "daily-sync-cadastro\|resources/daily-sync\|scrape-status-alunos\|backup.sh" \| grep -v grep \| wc -l` | 0. As rotinas curtas da tarde (acumular-presenca, diario-lembrete, faltas-alerta, sync de leads) rodam normalmente durante a janela, porque os passos só leem o banco. |
| P7 | Containers saudáveis | `docker ps` | `adr-lead-manager` healthy, `adr-dashboard` Up, Postgres healthy, Evolution Up |
| P8 | Arquivos de ambiente existem | `test -s /root/adr-whatsapp-scheduler/.env && test -s /apps/lead-manager/.env.claude-code` | ambos existem |
| P9 | Nomes não colidem | `docker ps -a --format '{{.Names}}' \| grep -c adr-restore` e `docker network ls \| grep -c adr-restore` | 0 e 0 |
| P10 | Imagens disponíveis | `docker pull restic/restic:0.17.3 && docker pull postgres:16-alpine` | as duas baixam |
| P11 | Baseline do smoke | contagens de `leads`, `conversations`, `messages`, `service_account`, `person`, `bi_raw.transactions`, `compasso.titulo` + `curl -s -o /dev/null -w "%{http_code}" https://agenda.leovecchi.com/login` | gravado em `/root/adr-fase0/preflight-20260920.txt`; login = 200 |

## 3. Passos

| # | Passo | Parar e reverter se |
|---|---|---|
| S1 | `mkdir -p /root/adr-fase0 && chmod 700 /root/adr-fase0`; copiar `deploy/fase0/*` do SHA registrado; `chmod 700 *.sh` | cópia incompleta (conferir `sha256sum` com o repositório) |
| S2 | `umask 077; mkdir -p /root/.adr-backup; [ -s /root/.adr-backup/restic.pass ] \|\| openssl rand -base64 48 > /root/.adr-backup/restic.pass` (**sem imprimir**) | arquivo vazio ou permissão ≠ 600 |
| S3 | `/root/adr-fase0/backup-v2.sh` (manual; ~10–20 min) | saída ≠ 0, ou `ultimo.json` com `"ok":false` |
| S4 | `/root/adr-fase0/restore-test.sh` (~10–20 min) | resultado ≠ **APROVADO** |
| S5 | `/root/adr-fase0/contagem-referencia.sh` | erro, ou arquivo do dia vazio |
| S6 | `crontab -l > /root/adr-fase0/crontab.antes-J0A`; acrescentar as 3 linhas do §1 **sem alterar as existentes**; `crontab -l > /root/adr-fase0/crontab.depois-J0A`; `diff` deve mostrar só as 3 linhas | diff com qualquer outra diferença |
| S7 | Pós-voo: repetir P7 e P11 | qualquer container fora do normal, login ≠ 200, contagens menores que no pré-voo |
| S8 | Relatório para o Leo: resultado de cada passo, tamanho do backup, tempo de restauração, contagens | — |

**Paradas automáticas (valem em qualquer passo):** passou das 18:30 sem chegar ao S6; comando bloqueado ou sem resposta por mais de 10 min; qualquer sinal de impacto em produção (P7 ou login ≠ 200 durante a janela).

## 4. Reversão

Nenhum passo altera produção. Reverter é **desligar o que foi acrescentado**:
1. Crontab: `crontab /root/adr-fase0/crontab.antes-J0A` (volta exatamente ao anterior).
2. Containers e rede de teste: `docker rm -f adr-restore-teste; docker network rm adr-restore-net` (o script já faz isso ao sair).
3. Arquivos restaurados com dado real: `rm -rf /var/backups/adr-v2/restore-teste` (o script já faz isso ao sair).
4. **Não apagar** `/var/backups/adr-v2/restic-local` nem `/root/.adr-backup/restic.pass`: são só backup e não afetam nada. Removê-los só com decisão do Leo.

## 5. Critério de pronto da J0-A
- `backup-v2.sh` concluído e `restore-test.sh` **APROVADO** na janela.
- Crontab com as 3 linhas novas e as antigas idênticas.
- Nos 7 dias seguintes: backup diário ok (`/var/log/adr-backup-v2/ultimo.json`) e contagem diária sem queda inexplicada (`/var/log/adr-contagem/`).
- **Leo guardou a senha do backup e as chaves no gerenciador de senhas** (§6). Até isso acontecer, o backup novo é considerado **não confiável**, e o `backup.sh` antigo continua valendo sozinho.

## 6. Tarefa do Leo depois da janela: guardar os segredos (≈10 min)
No terminal **dele** (o agente não vê os valores):
1. `ssh vps 'cat /root/.adr-backup/restic.pass'` → guardar como **"ADR · senha do backup (restic)"**.
2. `ssh vps 'cat /root/adr-whatsapp-scheduler/.env'` → guardar como nota segura **"ADR · .env do dashboard"**.
3. `ssh vps 'cat /apps/lead-manager/.env.claude-code'` → guardar como nota segura **"ADR · .env do Lead Manager"**.
4. Responder no chat: "segredos guardados".

**Sem a senha do item 1, o backup novo não pode ser aberto por ninguém.**

## 7. Tarefa do Leo quando quiser ligar a cópia fora da VPS (Backblaze B2)
1. Criar a conta em backblaze.com e um **bucket privado** (ex.: `adr-regente-backup`).
2. Criar uma **Application Key** com acesso **só a esse bucket** (leitura e escrita).
3. No terminal dele:
   ```
   ssh vps 'umask 077; cat > /root/.adr-backup/b2.env'
   ```
   Colar as três linhas abaixo, preenchidas, e apertar Ctrl+D:
   ```
   B2_ACCOUNT_ID=<keyID>
   B2_ACCOUNT_KEY=<applicationKey>
   RESTIC_REPOSITORY=b2:adr-regente-backup:/adr
   ```
4. Na noite seguinte, o `backup-v2.sh` cria o repositório no B2 e copia tudo. `ultimo.json` passa a mostrar `"b2":"ok"`.

A mesma senha do item 6.1 abre o repositório no B2.
