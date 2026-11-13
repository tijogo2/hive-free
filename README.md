# FreeHive

Plugin para **DeepAI Code (pi)** que faz três coisas:

1. **Divide toda tarefa não trivial entre os melhores modelos disponíveis** (gratuitos e, quando
   cabe no orçamento, os que gastam THEO) e sintetiza o resultado.
2. **Mantém memória de longo prazo do projeto** em markdown (formato OKF), offline.
3. **Troca bloqueio por ferramenta**: busca no GitHub (`selfhelp`), faz reconhecimento estático de
   binário/`.asar` (`recon`) e registra a lição na memória (`escalate`).

Uma ferramenta só (`hive`) com 19 ações, mais o comando `/hive`. Nenhum despacho acontece sem
passar pelo governador de cota: ele reserva antes, faz settlement depois e nunca gasta a última
fatia da cota diária (senão você fica 24 h sem provider).

## Instalar em uma linha

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 | iex
```

Linux / macOS / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/tijogo2/hive-free/main/install.sh | bash
```

Versão fixa (recomendado — `main` muda):

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/v0.2.0/install.ps1 | iex
```

O `install.ps1` é **self-contained**: a extensão vai embutida em base64. Ele não baixa mais nada,
não precisa de Node/npm e não pede build — o pi transpila TypeScript em tempo de carga.

## Pedir a outro agente DeepAI que instale

Copie e cole numa thread do DeepAI Code:

> Instale o plugin FreeHive: rode no terminal
> `powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/tijogo2/hive-free/v0.2.0/install.ps1 | iex"`
> e me diga o caminho onde a extensão ficou. Depois confirme com `/hive stats`.

Isso funciona porque o instalador é um arquivo único e idempotente: descobre o diretório de agente
do pi, faz backup do que existir e copia os `.ts` para `extensions/free-hive`.

## Requisitos na máquina de destino

- DeepAI Code instalado e **aberto uma vez com login**, para existir
  `%USERPROFILE%\.deepai-code\userdata\<instancia>\pi\<agente>`.
- Conta com os modelos gratuitos no catálogo. Faltando algum, o instalador avisa e o enxame usa os
  que existirem (`/hive models` lista).
- Para usar modelos em THEO, a conta precisa do plano que os libera. O teto por request e a margem
  diária são configuráveis (`/hive budget set 200 10 25%`).

## O que o instalador faz (e o que não faz)

Faz:

- Descobre o diretório do agente (`PI_CODING_AGENT_DIR` → glob em `userdata\*\pi\*` → padrão).
- Backup de `extensions/free-hive` existente em `free-hive.bak-<data>`; nunca sobrescreve calado.
- Copia `index.ts, catalog.ts, budget.ts, memory.ts, orchestrator.ts, recon.ts, security.ts,
  selfhelp.ts, skills.ts` e `skills/`.
- Cria/preserva a pasta de memória `~/.deepai-code/free-hive`.
- Confere o `models.json` e avisa quais modelos gratuitos faltam.
- Preserva `budget.json` e `attempts.jsonl` em `~/.deepai-code/free-hive` quando já existem.

Não faz (de propósito):

- Não copia `models.json`, `auth.json`, `models-store.json`, `userdata/secrets`, `statev2.sqlite`
  nem sessões — têm token e URL local; a máquina nova gera os dela no login.
- Não instala Node, não roda `npm install`, não altera configuração de modelo.

Opções:

| PowerShell | shell | efeito |
|---|---|---|
| `-IncludeMemory` | `--include-memory` | copia também a pasta `memory/` ao lado do instalador |
| `-Uninstall` | `--uninstall` | remove a extensão (guarda `.removed-<data>`) |
| `-DryRun` | `--dry-run` | mostra o destino sem alterar nada |
| `-AgentDir <dir>` | `--agent-dir <dir>` | força o diretório do agente |
| `-MemoryDir <dir>` | `--memory-dir <dir>` | força o diretório da memória |

Modo pipe (`irm ... | iex`, `curl ... | bash`) não aceita argumentos: use as variáveis
`FREEHIVE_AGENT_DIR`, `FREEHIVE_MEMORY_DIR`, `PI_CODING_AGENT_DIR`.

## Depois de instalar

1. Feche e abra o DeepAI Code (ou abra uma thread nova).
2. `/hive stats` → mostra versão e caminho da memória.
3. `/hive models` → catálogo com provider, lane, custo em THEO e cota do dia.
4. `/hive budget` → extrato de cota (req/min, req/dia, THEO, resets, cooldowns).
5. `/hive auto off` desliga o enxame automático; `/hive enforce off` só tira o bloqueio de edição.
6. `/hive allowpaid off` usa só modelos gratuitos; `/hive theos 400` ajusta a cota diária.

Desinstalar:

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## Segurança

- `irm | iex` executa código sem revisão. Se preferir, baixe primeiro
  (`irm <url> -OutFile install.ps1`), leia o topo e rode com `-File`.
- O payload embutido é o zip daqui de `dist/`, com sha256 publicado em cada release:
  `free-hive-<versao>.zip.sha256`. Para conferir:
  `Get-FileHash .\dist\free-hive-0.2.0.zip -Algorithm SHA256`.
- Não há download em tempo de execução, nem `npm`, nem `curl` interno: o instalador só escreve
  arquivos dentro de `~/.deepai-code` e faz backup antes.

## Estrutura do repositório

```
src/free-hive/*.ts        fonte da extensão (é isto que você edita)
templates/install.ps1.tmpl, install.sh.tmpl
build.ps1 / build.sh      regeram install.ps1, install.sh e dist/free-hive-<versao>.zip
install.ps1, install.sh   gerados — é o que a URL raw serve
publish.ps1               build + commit + push + tag + release no GitHub
VERSION                   versão atual
.github/workflows/        release automática ao empurrar uma tag v*
```

Fluxo de manutenção:

```powershell
# 1. editar src/free-hive/*.ts
powershell -ExecutionPolicy Bypass -File .\build.ps1     # ou ./build.sh no Linux/macOS
powershell -ExecutionPolicy Bypass -File .\publish.ps1  # sugere owner/free-hive se conseguir detectar a conta
```

O `publish.ps1` só precisa de Git: gera os instaladores, faz commit, configura `origin` para o
repositório existente, envia `main` e a tag `v<versao>`, e verifica que o instalador raw responde
HTTP 200. Ele nunca cria o repositório nem a release pelo computador local.

## Publicar sem GitHub CLI

1. Crie um repositório **vazio** no github.com (sem README, licença ou `.gitignore`). Instale o Git
   com Git Credential Manager e faça login no navegador quando o primeiro push solicitar.
2. No PowerShell, na pasta do projeto, execute a sequência abaixo. Troque o owner pelo nome da
   conta/organização e mantenha o nome escolhido para o repositório:

```powershell
git init -b main
git add -A
git commit -m "FreeHive 0.2.0"
git remote add origin https://github.com/tijogo2/hive-free.git
git push -u origin main
git tag -a v0.2.0 -m "FreeHive 0.2.0"
git push origin v0.2.0
```

O usuário pode ser sugerido pelo `publish.ps1` a partir do `origin`, da configuração `github.user`,
de `GH_USER`/`GITHUB_USER`/`GITHUB_USERNAME` ou das contas do Git Credential Manager. `git user.name`
não é necessariamente o username do GitHub. Também é possível passar o destino diretamente:
`.\publish.ps1 -Repo tijogo2/hive-free`.

Após o push, confirme no navegador que
`https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1` abre o script (HTTP 200).
Teste a instalação em PowerShell com:

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 | iex
```

O push da tag aciona o workflow do GitHub Actions para tentar gerar a release com ZIP e SHA256.
Sem `gh` local, se o workflow não publicar a release, crie-a manualmente em **Releases → Draft a new
release**, escolha a tag `v0.2.0` e anexe `dist/free-hive-0.2.0.zip` e
`dist/free-hive-0.2.0.zip.sha256`.

Serve também em qualquer host estático (Gist raw, S3, Cloudflare R2, seu servidor): basta servir
`install.ps1` e `install.sh` — são arquivos únicos.

## Problemas comuns

| sintoma | causa |
|---|---|
| `/hive` não existe depois de instalar | extensão não carregou: confirme os 6 `.ts` em `...\extensions\free-hive\` e reinicie o app |
| instalador diz que `~/.deepai-code/userdata` não existe | o app nunca foi aberto nesta máquina; abra e faça login, depois repita |
| aviso de modelos gratuitos ausentes | a conta não tem aquele modelo; o enxame usa os disponíveis |
| extração falhou no `install.sh` | falta `unzip`/`python3`; instale um deles (o `.ps1` não tem essa dependência) |
