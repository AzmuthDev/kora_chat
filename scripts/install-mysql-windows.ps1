# Prepara o MySQL 8.4 (instalado pelo winget) para rodar como serviço do Windows.
# Rode UMA vez, num PowerShell aberto como administrador:
#   powershell -ExecutionPolicy Bypass -File scripts\install-mysql-windows.ps1
#
# O que faz:
#   1. cria C:\ProgramData\MySQL\MySQL Server 8.4\my.ini (só aceita conexões deste computador)
#   2. inicializa a pasta de dados (root local ainda sem senha; o setup-mysql.mjs define uma em seguida)
#   3. registra e inicia o serviço "MySQL84", que passa a iniciar junto com o Windows
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$base = 'C:\Program Files\MySQL\MySQL Server 8.4'
$root = 'C:\ProgramData\MySQL\MySQL Server 8.4'
$data = Join-Path $root 'Data'
$ini = Join-Path $root 'my.ini'
$service = 'MySQL84'

if (-not (Test-Path "$base\bin\mysqld.exe")) { throw "MySQL não encontrado em $base. Instale com: winget install Oracle.MySQL" }

if (Get-Service -Name $service -ErrorAction SilentlyContinue) {
  Write-Host "O serviço $service já existe; garantindo que está rodando."
  Start-Service -Name $service
  exit 0
}
if (Test-Path $data) { throw "Já existe uma pasta de dados em $data. Remova-a ou use outra pasta antes de continuar." }

New-Item -ItemType Directory -Force -Path $root | Out-Null
$baseFwd = $base -replace '\\', '/'
$dataFwd = $data -replace '\\', '/'
Set-Content -Path $ini -Encoding ascii -Value @"
[mysqld]
basedir="$baseFwd"
datadir="$dataFwd"
port=3306
bind-address=127.0.0.1
mysqlx=OFF
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone='+00:00'
"@

Write-Host 'Inicializando a pasta de dados...'
& "$base\bin\mysqld.exe" --defaults-file="$ini" --initialize-insecure --console
if ($LASTEXITCODE -ne 0) { throw 'Falha ao inicializar o MySQL.' }

Write-Host "Registrando o serviço $service..."
& "$base\bin\mysqld.exe" --install $service --defaults-file="$ini"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao registrar o serviço.' }
Start-Service -Name $service

Write-Host ''
Write-Host "MySQL rodando como serviço $service na porta 3306 (somente localhost)."
Write-Host 'Agora, na pasta do projeto (terminal normal): node scripts/setup-mysql.mjs'
