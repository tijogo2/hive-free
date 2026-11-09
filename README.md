# FreeHive

Plugin para **DeepAI Code (pi)** que faz trÃªs coisas:

1. **Divide toda tarefa nÃ£o trivial entre os modelos gratuitos (0 theos)** e sintetiza o resultado.
2. **MantÃ©m memÃ³ria de longo prazo do projeto** em markdown (formato OKF), offline.
3. **Troca bloqueio por ferramenta**: busca no GitHub (`selfhelp`), faz reconhecimento estÃ¡tico de
   binÃ¡rio/`.asar` (`recon`) e registra a liÃ§Ã£o na memÃ³ria (`escalate`).

Uma ferramenta sÃ³ (`hive`) com 14 aÃ§Ãµes, mais o comando `/hive`. Nenhum caminho usa modelo pago.

## Instalar em uma linha

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 | iex
```

Linux / macOS / Git Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/tijogo2/hive-free/main/install.sh | bash
```

VersÃ£o fixa (recomendado â€” `main` muda):

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/v0.1.0/install.ps1 | iex
```

O `install.ps1` Ã© **self-contained**: a extensÃ£o vai embutida em base64. Ele nÃ£o baixa mais nada,
nÃ£o precisa de Node/npm e nÃ£o pede build â€” o pi transpila TypeScript em tempo de carga.

## Pedir a outro agente DeepAI que instale

Copie e cole numa thread do DeepAI Code:

> Instale o plugin FreeHive: rode no terminal
> `powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/tijogo2/hive-free/v0.1.0/install.ps1 | iex"`
> e me diga o caminho onde a extensÃ£o ficou. Depois confirme com `/hive stats`.

Isso funciona porque o instalador Ã© um arquivo Ãºnico e idempotente: descobre o diretÃ³rio de agente
do pi, faz backup do que existir e copia os `.ts` para `extensions/free-hive`.

## Requisitos na mÃ¡quina de destino

- DeepAI Code instalado e **aberto uma vez com login**, para existir
  `%USERPROFILE%\.deepai-code\userdata\<instancia>\pi\<agente>`.
- Conta com os modelos gratuitos no catÃ¡logo. Faltando algum, o instalador avisa e o enxame usa os
  que existirem (`/hive models` lista).

## O que o instalador faz (e o que nÃ£o faz)

Faz:

- Descobre o diretÃ³rio do agente (`PI_CODING_AGENT_DIR` â†’ glob em `userdata\*\pi\*` â†’ padrÃ£o).
- Backup de `extensions/free-hive` existente em `free-hive.bak-<data>`; nunca sobrescreve calado.
- Copia `index.ts, catalog.ts, memory.ts, orchestrator.ts, recon.ts, selfhelp.ts`.
- Cria/preserva a pasta de memÃ³ria `~/.deepai-code/free-hive`.
- Confere o `models.json` e avisa quais modelos gratuitos faltam.

NÃ£o faz (de propÃ³sito):

- NÃ£o copia `models.json`, `auth.json`, `models-store.json`, `userdata/secrets`, `statev2.sqlite`
  nem sessÃµes â€” tÃªm token e URL local; a mÃ¡quina nova gera os dela no login.
- NÃ£o instala Node, nÃ£o roda `npm install`, nÃ£o altera configuraÃ§Ã£o de modelo.

OpÃ§Ãµes:

| PowerShell | shell | efeito |
|---|---|---|
| `-IncludeMemory` | `--include-memory` | copia tambÃ©m a pasta `memory/` ao lado do instalador |
| `-Uninstall` | `--uninstall` | remove a extensÃ£o (guarda `.removed-<data>`) |
| `-DryRun` | `--dry-run` | mostra o destino sem alterar nada |
| `-AgentDir <dir>` | `--agent-dir <dir>` | forÃ§a o diretÃ³rio do agente |
| `-MemoryDir <dir>` | `--memory-dir <dir>` | forÃ§a o diretÃ³rio da memÃ³ria |

Modo pipe (`irm ... | iex`, `curl ... | bash`) nÃ£o aceita argumentos: use as variÃ¡veis
`FREEHIVE_AGENT_DIR`, `FREEHIVE_MEMORY_DIR`, `PI_CODING_AGENT_DIR`.

## Depois de instalar

1. Feche e abra o DeepAI Code (ou abra uma thread nova).
2. `/hive stats` â†’ mostra versÃ£o e caminho da memÃ³ria.
3. `/hive models` â†’ confirma os gratuitos.
4. `/hive auto off` desliga o enxame automÃ¡tico; `/hive enforce off` sÃ³ tira o bloqueio de ediÃ§Ã£o.

Desinstalar:

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## SeguranÃ§a

- `irm | iex` executa cÃ³digo sem revisÃ£o. Se preferir, baixe primeiro
  (`irm <url> -OutFile install.ps1`), leia o topo e rode com `-File`.
- O payload embutido Ã© o zip daqui de `dist/`, com sha256 publicado em cada release:
  `free-hive-<versao>.zip.sha256`. Para conferir:
  `Get-FileHash .\dist\free-hive-0.1.0.zip -Algorithm SHA256`.
- NÃ£o hÃ¡ download em tempo de execuÃ§Ã£o, nem `npm`, nem `curl` interno: o instalador sÃ³ escreve
  arquivos dentro de `~/.deepai-code` e faz backup antes.

## Estrutura do repositÃ³rio

```
src/free-hive/*.ts        fonte da extensÃ£o (Ã© isto que vocÃª edita)
templates/install.ps1.tmpl, install.sh.tmpl
build.ps1 / build.sh      regeram install.ps1, install.sh e dist/free-hive-<versao>.zip
install.ps1, install.sh   gerados â€” Ã© o que a URL raw serve
publish.ps1               build + commit + push + tag + release no GitHub
VERSION                   versÃ£o atual
.github/workflows/        release automÃ¡tica ao empurrar uma tag v*
```

Fluxo de manutenÃ§Ã£o:

```powershell
# 1. editar src/free-hive/*.ts
powershell -ExecutionPolicy Bypass -File .\build.ps1     # ou ./build.sh no Linux/macOS
powershell -ExecutionPolicy Bypass -File .\publish.ps1  # sugere owner/free-hive se conseguir detectar a conta
```

O `publish.ps1` sÃ³ precisa de Git: gera os instaladores, faz commit, configura `origin` para o
repositÃ³rio existente, envia `main` e a tag `v<versao>`, e verifica que o instalador raw responde
HTTP 200. Ele nunca cria o repositÃ³rio nem a release pelo computador local.

## Publicar sem GitHub CLI

1. Crie um repositÃ³rio **vazio** no github.com (sem README, licenÃ§a ou `.gitignore`). Instale o Git
   com Git Credential Manager e faÃ§a login no navegador quando o primeiro push solicitar.
2. No PowerShell, na pasta do projeto, execute a sequÃªncia abaixo. Troque o owner pelo nome da
   conta/organizaÃ§Ã£o e mantenha o nome escolhido para o repositÃ³rio:

```powershell
git init -b main
git add -A
git commit -m "FreeHive 0.1.0"
git remote add origin https://github.com/tijogo2/hive-free.git
git push -u origin main
git tag -a v0.1.0 -m "FreeHive 0.1.0"
git push origin v0.1.0
```

O usuÃ¡rio pode ser sugerido pelo `publish.ps1` a partir do `origin`, da configuraÃ§Ã£o `github.user`,
de `GH_USER`/`GITHUB_USER`/`GITHUB_USERNAME` ou das contas do Git Credential Manager. `git user.name`
nÃ£o Ã© necessariamente o username do GitHub. TambÃ©m Ã© possÃ­vel passar o destino diretamente:
`.\publish.ps1 -Repo tijogo2/hive-free`.

ApÃ³s o push, confirme no navegador que
`https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1` abre o script (HTTP 200).
Teste a instalaÃ§Ã£o em PowerShell com:

```powershell
irm https://raw.githubusercontent.com/tijogo2/hive-free/main/install.ps1 | iex
```

O push da tag aciona o workflow do GitHub Actions para tentar gerar a release com ZIP e SHA256.
Sem `gh` local, se o workflow nÃ£o publicar a release, crie-a manualmente em **Releases â†’ Draft a new
release**, escolha a tag `v0.1.0` e anexe `dist/free-hive-0.1.0.zip` e
`dist/free-hive-0.1.0.zip.sha256`.

Serve tambÃ©m em qualquer host estÃ¡tico (Gist raw, S3, Cloudflare R2, seu servidor): basta servir
`install.ps1` e `install.sh` â€” sÃ£o arquivos Ãºnicos.

## Problemas comuns

| sintoma | causa |
|---|---|
| `/hive` nÃ£o existe depois de instalar | extensÃ£o nÃ£o carregou: confirme os 6 `.ts` em `...\extensions\free-hive\` e reinicie o app |
| instalador diz que `~/.deepai-code/userdata` nÃ£o existe | o app nunca foi aberto nesta mÃ¡quina; abra e faÃ§a login, depois repita |
| aviso de modelos gratuitos ausentes | a conta nÃ£o tem aquele modelo; o enxame usa os disponÃ­veis |
| extraÃ§Ã£o falhou no `install.sh` | falta `unzip`/`python3`; instale um deles (o `.ps1` nÃ£o tem essa dependÃªncia) |
