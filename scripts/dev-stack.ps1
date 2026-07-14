<#
.SYNOPSIS
  Levanta / detiene la pila de ComprePDF de forma NATIVA (sin Docker) en Windows.

.DESCRIPTION
  Arranca MySQL portable, backend Node, worker Python (poller) y frontend Angular.
  Pensado para desarrollo/pruebas cuando no hay Docker disponible.

  Requisitos (ya presentes en la maquina donde se creo):
    - MySQL portable en  C:\Proyectos\mysql-test\mysql-8.0.40-winx64  (my.ini en C:\Proyectos\mysql-test\my.ini)
    - node_modules instalados en backend/ y frontend/
    - deps de python-worker instaladas (pikepdf, pyhanko, mysql-connector-python)
    - (opcional) Ghostscript en PATH para la operacion 'compress'

.PARAMETER Action
  start  | stop | status   (default: start)

.EXAMPLE
  .\scripts\dev-stack.ps1 start
  .\scripts\dev-stack.ps1 status
  .\scripts\dev-stack.ps1 stop
#>
param(
  [ValidateSet('start','stop','status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

# --- Rutas (ajusta si moviste algo) ---
$Project   = 'C:\Proyectos\comprepdf'
$MysqlBin  = 'C:\Proyectos\mysql-test\mysql-8.0.40-winx64\bin'
$MysqlIni  = 'C:\Proyectos\mysql-test\my.ini'

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-Stack {
  # 1) MySQL
  if (Test-Port 3306) {
    Write-Host "[MySQL]    ya escucha en :3306" -ForegroundColor Green
  } else {
    Write-Host "[MySQL]    arrancando..." -ForegroundColor Cyan
    Start-Process -FilePath "$MysqlBin\mysqld.exe" -ArgumentList "--defaults-file=`"$MysqlIni`"" -WindowStyle Hidden
    for ($i=0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 700
      $ping = & "$MysqlBin\mysqladmin.exe" -h 127.0.0.1 -u root ping 2>$null
      if ($ping -match 'is alive') { break }
    }
    if (Test-Port 3306) { Write-Host "[MySQL]    OK :3306" -ForegroundColor Green }
    else { Write-Host "[MySQL]    NO arranco - revisa $MysqlBin" -ForegroundColor Red }
  }

  # 2) Backend Node
  if (Test-Port 3000) {
    Write-Host "[Backend]  ya escucha en :3000" -ForegroundColor Green
  } else {
    Write-Host "[Backend]  arrancando (npm run dev)..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory "$Project\backend" -WindowStyle Minimized
  }

  # 3) Worker Python (poller)
  $worker = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'app.workers.poller' }
  if ($worker) {
    Write-Host "[Worker]   ya corriendo (PID $($worker.ProcessId))" -ForegroundColor Green
  } else {
    Write-Host "[Worker]   arrancando (poller)..." -ForegroundColor Cyan
    Start-Process -FilePath "python" -ArgumentList "-m app.workers.poller" -WorkingDirectory "$Project\python-worker" -WindowStyle Minimized
  }

  # 4) Frontend Angular
  if (Test-Port 4200) {
    Write-Host "[Frontend] ya escucha en :4200" -ForegroundColor Green
  } else {
    Write-Host "[Frontend] arrancando (ng serve)..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx ng serve --port 4200 --host 127.0.0.1" -WorkingDirectory "$Project\frontend" -WindowStyle Minimized
  }

  Write-Host "`nListo. Frontend: http://127.0.0.1:4200/tools  |  API: http://localhost:3000/api/v1/health" -ForegroundColor Yellow
  Write-Host "(el frontend tarda ~10s en compilar la primera vez)" -ForegroundColor DarkGray
}

function Stop-Stack {
  Write-Host "[Frontend] deteniendo ng serve / node de :4200..." -ForegroundColor Cyan
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'ng serve|@angular' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Write-Host "[Backend]  deteniendo backend (ts-node/nodemon)..." -ForegroundColor Cyan
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'backend|ts-node|nodemon' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Write-Host "[Worker]   deteniendo poller..." -ForegroundColor Cyan
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'app.workers.poller' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  Write-Host "[MySQL]    apagando (mysqladmin shutdown)..." -ForegroundColor Cyan
  & "$MysqlBin\mysqladmin.exe" -h 127.0.0.1 -u root shutdown 2>$null
  Write-Host "`nPila detenida." -ForegroundColor Yellow
}

function Show-Status {
  "{0,-10} {1}" -f 'MySQL',    $(if (Test-Port 3306) {'UP  :3306'} else {'down'})
  "{0,-10} {1}" -f 'Backend',  $(if (Test-Port 3000) {'UP  :3000'} else {'down'})
  "{0,-10} {1}" -f 'Frontend', $(if (Test-Port 4200) {'UP  :4200'} else {'down'})
  $w = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'app.workers.poller' }
  "{0,-10} {1}" -f 'Worker',   $(if ($w) {"UP  PID $($w.ProcessId)"} else {'down'})
}

switch ($Action) {
  'start'  { Start-Stack }
  'stop'   { Stop-Stack }
  'status' { Show-Status }
}
