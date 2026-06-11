<#
  llama-turbo control script.
  Subcommands:  config (default) | start | stop | server | watchdog | status
  Driven by ..\models.json  (edit it with the TUI:  config.cmd).

  server   = run the SELECTED model's llama-server in the foreground (used by the
             ComfyUI gate and by the start window).
  start    = free VRAM, open the server window, start Open WebUI, start idle watchdog.
  stop     = stop watchdog + llama-server + Open WebUI.
  watchdog = poll /metrics; if idle for settings.idleTtlMinutes, stop everything.
  config   = interactive TUI to pick the model and edit per-model parameters.
#>
param(
  [Parameter(Position = 0)]
  [string]$Command = 'config'
)

$ErrorActionPreference = 'Stop'

# ---------- paths ----------
$Root        = Split-Path -Parent $PSScriptRoot      # ...\llama-turbo
$ConfigPath  = Join-Path $Root 'models.json'
$Bin         = Join-Path $Root 'atomic\build\bin'
$Exe         = Join-Path $Bin  'llama-server.exe'
$CudaBin     = Join-Path $Root 'cuda\bin\x64'
$RunDir      = Join-Path $Root '.run'
$WatchPidF   = Join-Path $RunDir 'watchdog.pid'
$ServerLog   = Join-Path $RunDir 'server.log'
$StopFlag    = Join-Path $RunDir 'stop.flag'      # written by Stop-ServerAndUi; signals intentional stop to Invoke-Up
$OwStart     = Join-Path $Root 'openwebui\openwebui-start.ps1'
$OwStop      = Join-Path $Root 'openwebui\openwebui-stop.ps1'

if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }

# ---------- config io ----------
function Load-Config {
  if (-not (Test-Path $ConfigPath)) { throw "Config not found: $ConfigPath" }
  return (Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json)
}
function Save-Config($cfg) {
  $cfg | ConvertTo-Json -Depth 12 | Out-File -FilePath $ConfigPath -Encoding utf8
}
function Get-Selected($cfg) {
  $m = $cfg.models | Where-Object { $_.id -eq $cfg.selected } | Select-Object -First 1
  if (-not $m) { $m = $cfg.models | Select-Object -First 1 }
  return $m
}

# ---------- build llama-server args ----------
function Get-ServerArgs($cfg) {
  $m = Get-Selected $cfg
  if (-not (Test-Path $m.model)) { throw "Model file missing: $($m.model)" }

  $a = New-Object System.Collections.Generic.List[string]
  $a.AddRange([string[]]@(
    '-m', $m.model,
    '-c', "$($m.ctx)",
    '-ngl', "$($m.ngl)",
    '-fit', 'off',
    '-fa', "$($m.flashAttn)",
    '-ctk', "$($m.ctk)", '-ctv', "$($m.ctv)",
    '--no-context-shift', '--ctx-checkpoints', '0',
    '--alias', "$($m.alias)",
    '--cont-batching',
    '--parallel', "$($m.parallel)", '-np', "$($m.parallel)",
    '-t', "$($m.threads)", '-tb', "$($m.threadsBatch)",
    '--temp', "$($m.sampling.temp)",
    '--top-p', "$($m.sampling.topP)",
    '--top-k', "$($m.sampling.topK)",
    '--min-p', "$($m.sampling.minP)",
    '--presence-penalty', "$($m.sampling.presencePenalty)",
    '--repeat-penalty', "$($m.sampling.repeatPenalty)",
    '--jinja',
    '--metrics',
    '--reasoning', "$($m.reasoning)",
    '--reasoning-format', "$($m.reasoningFormat)",
    '--host', "$($cfg.settings.host)",
    '--port', "$($cfg.settings.port)"
  ))
  if ($m.kvUnified) { $a.Add('--kv-unified') }
  if ($m.moe)       { $a.AddRange([string[]]@('--n-cpu-moe', "$($m.nCpuMoe)")) }
  if ($m.mmproj -and (Test-Path $m.mmproj)) {
    $a.AddRange([string[]]@('--mmproj', $m.mmproj, '--image-max-tokens', "$($m.imageMaxTokens)"))
    if (-not $m.mmprojOffload) { $a.Add('--no-mmproj-offload') }   # default = GPU (fast vision); CPU only if false
  }
  if ($m.cacheReuse -and [int]$m.cacheReuse -gt 0) { $a.AddRange([string[]]@('--cache-reuse', "$($m.cacheReuse)")) }
  if ($m.spec -eq 'nextn' -and $m.specCapable) {
    $a.AddRange([string[]]@('-md', $m.model, '--spec-type', 'nextn', '--draft-max', '4', '--draft-min', '0'))
    if ($m.moe) { $a.AddRange([string[]]@('--n-cpu-moe-draft', "$($m.nCpuMoe)")) }
  }
  if ($m.extraArgs) { foreach ($x in $m.extraArgs) { if ("$x".Trim()) { $a.Add("$x") } } }
  return $a.ToArray()
}

# ---------- server (foreground) ----------
function Invoke-Server {
  $cfg = Load-Config
  $m   = Get-Selected $cfg
  $env:PATH = "$Bin;$CudaBin;$env:PATH"
  $sargs = Get-ServerArgs $cfg
  Write-Host "=== llama-turbo: $($m.name) ===" -ForegroundColor Cyan
  Write-Host "model : $($m.model)"
  Write-Host "ctx=$($m.ctx)  parallel=$($m.parallel)  ncpu-moe=$(if($m.moe){$m.nCpuMoe}else{'n/a'})  KV=$($m.ctk)  vision=$(if($m.mmproj){if($m.mmprojOffload){'GPU'}else{'CPU'}}else{'none'})  spec=$(if($m.spec -eq 'nextn' -and $m.specCapable){'nextn'}else{'off'})"
  Write-Host "API   : http://$($cfg.settings.host):$($cfg.settings.port)/v1" -ForegroundColor Green
  Write-Host ("cmd   : llama-server " + ($sargs -join ' ')) -ForegroundColor DarkGray
  Write-Host ""
  & $Exe @sargs
}

# ---------- stop helpers ----------
function Stop-ServerAndUi {
  # Signal intentional stop so Invoke-Up's restart loop does not re-launch
  $null | Out-File -FilePath $StopFlag -Encoding ascii
  cmd /c "taskkill /F /IM llama-server.exe >nul 2>&1" | Out-Null
  if (Test-Path $OwStop) {
    powershell -ExecutionPolicy Bypass -NoProfile -File $OwStop | Out-Null
  }
}
function Invoke-Stop {
  # kill watchdog first so it doesn't restart anything
  if (Test-Path $WatchPidF) {
    $wpid = (Get-Content $WatchPidF | Select-Object -First 1)
    if ($wpid) { cmd /c "taskkill /PID $wpid /T /F >nul 2>&1" | Out-Null }
    Remove-Item $WatchPidF -ErrorAction SilentlyContinue
  }
  Stop-ServerAndUi
  Write-Host "Stopped llama-server + Open WebUI + idle watchdog." -ForegroundColor Yellow
}

# ---------- idle watchdog ----------
function Invoke-Watchdog {
  $cfg = Load-Config
  $ttl = [int]$cfg.settings.idleTtlMinutes
  if ($ttl -le 0) { return }   # 0/negative = disabled
  "$PID" | Out-File -Encoding ascii $WatchPidF
  $url    = "http://$($cfg.settings.host):$($cfg.settings.port)/metrics"
  $poll   = 60
  $idle   = 0
  $last   = $null
  $misses = 0
  while ($true) {
    Start-Sleep -Seconds $poll
    $cur = $null
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10
      $cur = 0.0
      foreach ($line in ($resp.Content -split "`n")) {
        if ($line -match '^(llamacpp:prompt_tokens_total|llamacpp:tokens_predicted_total)\s+([0-9.eE+-]+)') {
          $cur += [double]$matches[2]
        }
      }
    } catch {
      # server unreachable; after a few misses assume it's gone and exit watchdog
      $misses++
      if ($misses -ge 3) { break }
      continue
    }
    $misses = 0
    if ($null -ne $last -and $cur -eq $last) { $idle += $poll } else { $idle = 0 }
    $last = $cur
    if ($idle -ge ($ttl * 60)) {
      Stop-ServerAndUi
      break
    }
  }
  Remove-Item $WatchPidF -ErrorAction SilentlyContinue
}

# ---------- start (orchestrate) ----------
function Invoke-Start {
  $cfg = Load-Config
  $m   = Get-Selected $cfg

  if ($cfg.settings.freeVramFirst) {
    Write-Host "Freeing VRAM (lms unload --all)..." -ForegroundColor DarkGray
    cmd /c "lms unload --all >nul 2>&1" | Out-Null
  }

  # server in its own persistent window (cmd /k keeps it open if it ever exits)
  $serverCmd = Join-Path $PSScriptRoot 'server.cmd'
  Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/k', "`"$serverCmd`"" `
    -WorkingDirectory $Root | Out-Null
  Write-Host "Server window launched: $($m.name)" -ForegroundColor Green

  # Open WebUI
  if ($cfg.settings.startOpenWebUI -and (Test-Path $OwStart)) {
    powershell -ExecutionPolicy Bypass -NoProfile -File $OwStart
  }

  # idle watchdog (detached, hidden)
  $ttl = [int]$cfg.settings.idleTtlMinutes
  if ($ttl -gt 0) {
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList '-ExecutionPolicy','Bypass','-NoProfile','-WindowStyle','Hidden','-File',"`"$PSCommandPath`"",'watchdog' `
      -WindowStyle Hidden | Out-Null
    Write-Host "Idle watchdog armed: auto-stop after $ttl min idle." -ForegroundColor DarkGray
  }

  Write-Host ""
  Write-Host "READY shortly at http://$($cfg.settings.host):$($cfg.settings.port)/v1  (model load takes 30-75s)" -ForegroundColor Cyan
  if ($cfg.settings.startOpenWebUI) { Write-Host "Open WebUI: http://127.0.0.1:3000" -ForegroundColor Cyan }
  Write-Host "Stop with: stop.cmd"
}

# ---------- up (foreground, for Warp / a terminal pane) ----------
function Invoke-Up {
  $cfg = Load-Config
  $m   = Get-Selected $cfg

  # Clear stop flag so the crash-restart loop can detect intentional vs crash exits
  Remove-Item $StopFlag -ErrorAction SilentlyContinue

  if ($cfg.settings.freeVramFirst) {
    Write-Host "Freeing VRAM (lms unload --all)..." -ForegroundColor DarkGray
    cmd /c "lms unload --all >nul 2>&1" | Out-Null
  }
  if ($cfg.settings.startOpenWebUI -and (Test-Path $OwStart)) {
    powershell -ExecutionPolicy Bypass -NoProfile -File $OwStart
  }
  $ttl = [int]$cfg.settings.idleTtlMinutes
  if ($ttl -gt 0) {
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList '-ExecutionPolicy','Bypass','-NoProfile','-WindowStyle','Hidden','-File',"`"$PSCommandPath`"",'watchdog' `
      -WindowStyle Hidden | Out-Null
    Write-Host "Idle watchdog armed: auto-stop after $ttl min idle." -ForegroundColor DarkGray
  }
  Write-Host "Open WebUI -> http://127.0.0.1:3000   (stop.cmd to stop everything)" -ForegroundColor Cyan

  $env:PATH   = "$Bin;$CudaBin;$env:PATH"
  $crashCount = 0
  $maxCrashes = 5
  $lastStart  = [DateTime]::Now

  try {
    while ($true) {
      # Reload config each loop (supports hot-switching model via config.cmd)
      $cfg   = Load-Config
      $m     = Get-Selected $cfg
      $sargs = Get-ServerArgs $cfg
      Write-Host ""
      Write-Host "=== llama-turbo: $($m.name) ===" -ForegroundColor Cyan
      Write-Host "model : $($m.model)"
      Write-Host "ctx=$($m.ctx)  parallel=$($m.parallel)  ncpu-moe=$(if($m.moe){$m.nCpuMoe}else{'n/a'})  KV=$($m.ctk)  vision=$(if($m.mmproj){if($m.mmprojOffload){'GPU'}else{'CPU'}}else{'none'})  spec=$(if($m.spec -eq 'nextn' -and $m.specCapable){'nextn'}else{'off'})"
      Write-Host "API   : http://$($cfg.settings.host):$($cfg.settings.port)/v1" -ForegroundColor Green
      Write-Host ("cmd   : llama-server " + ($sargs -join ' ')) -ForegroundColor DarkGray
      Write-Host ""

      & $Exe @sargs
      $exitCode = $LASTEXITCODE
      $uptime   = [int]([DateTime]::Now - $lastStart).TotalSeconds

      # Intentional stop? (Stop-ServerAndUi writes stop.flag before killing the process)
      if (Test-Path $StopFlag) {
        Remove-Item $StopFlag -ErrorAction SilentlyContinue
        Write-Host "`nServer stopped intentionally." -ForegroundColor Yellow
        break
      }

      # If it ran stably for >5 min, reset the crash counter
      if ($uptime -gt 300) { $crashCount = 0 }
      $crashCount++
      $lastStart = [DateTime]::Now

      Write-Host "`n[CRASH #$crashCount] llama-server exited unexpectedly (code=$exitCode  uptime=${uptime}s)" -ForegroundColor Red

      if ($crashCount -ge $maxCrashes) {
        Write-Host "Too many consecutive crashes ($maxCrashes). Giving up." -ForegroundColor Red
        Write-Host "  'CUDA error: device not ready' = Windows GPU timeout (TDR, default 2s)." -ForegroundColor Yellow
        Write-Host "  Fix: run  fix-tdr.cmd  as Administrator, then reboot." -ForegroundColor Yellow
        break
      }

      $delay = [math]::Min(5 * $crashCount, 30)
      Write-Host "Restarting in ${delay}s ... (crash $crashCount/$maxCrashes)  [stop.cmd to cancel]" -ForegroundColor Yellow
      Write-Host "  HINT: 'CUDA error: device not ready' = Windows TDR. Run fix-tdr.cmd as Admin to fix." -ForegroundColor DarkGray
      Start-Sleep -Seconds $delay
    }
  } finally {
    Write-Host "`nCleaning up: Open WebUI + watchdog..." -ForegroundColor Yellow
    if (Test-Path $WatchPidF) {
      $wpid = (Get-Content $WatchPidF | Select-Object -First 1)
      if ($wpid) { cmd /c "taskkill /PID $wpid /T /F >nul 2>&1" | Out-Null }
      Remove-Item $WatchPidF -ErrorAction SilentlyContinue
    }
    if (Test-Path $OwStop) { powershell -ExecutionPolicy Bypass -NoProfile -File $OwStop | Out-Null }
  }
}

# ---------- status ----------
function Invoke-Status {
  $cfg = Load-Config
  $m   = Get-Selected $cfg
  Write-Host "Selected model : $($m.id)  ($($m.name))"
  Write-Host "API            : http://$($cfg.settings.host):$($cfg.settings.port)/v1"
  Write-Host "Idle TTL       : $($cfg.settings.idleTtlMinutes) min"
  $running = (Get-Process llama-server -ErrorAction SilentlyContinue) -ne $null
  Write-Host "llama-server   : $(if($running){'RUNNING'}else{'stopped'})"
  $wd = (Test-Path $WatchPidF) -and ((Get-Content $WatchPidF -ErrorAction SilentlyContinue) | ForEach-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue })
  Write-Host "watchdog       : $(if($wd){'armed'}else{'off'})"
}

# =====================================================================
#  TUI (config)
# =====================================================================
function Read-MenuChoice($title, $items, [string[]]$header) {
  $idx = 0
  while ($true) {
    Clear-Host
    Write-Host $title -ForegroundColor Cyan
    Write-Host ("=" * $title.Length) -ForegroundColor DarkCyan
    if ($header) { foreach ($h in $header) { Write-Host $h -ForegroundColor DarkGray }; Write-Host "" }
    for ($i = 0; $i -lt $items.Count; $i++) {
      if ($i -eq $idx) {
        Write-Host ("  > " + $items[$i]) -ForegroundColor Black -BackgroundColor Cyan
      } else {
        Write-Host ("    " + $items[$i])
      }
    }
    Write-Host ""
    Write-Host "  Up/Down move - Enter select - Esc back" -ForegroundColor DarkGray
    $k = [Console]::ReadKey($true)
    switch ($k.Key) {
      'UpArrow'   { $idx = ($idx - 1 + $items.Count) % $items.Count }
      'DownArrow' { $idx = ($idx + 1) % $items.Count }
      'Enter'     { return $idx }
      'Escape'    { return -1 }
      'Home'      { $idx = 0 }
      'End'       { $idx = $items.Count - 1 }
    }
  }
}

function Edit-Value($label, $current, $type, $choices) {
  Clear-Host
  Write-Host "Edit: $label" -ForegroundColor Cyan
  Write-Host ("Current value: " + $current) -ForegroundColor Yellow
  if ($type -eq 'bool') {
    $sel = Read-MenuChoice "Set $label" @('true','false') @("Current: $current")
    if ($sel -lt 0) { return $current }
    return ($sel -eq 0)
  }
  if ($choices) {
    $opts = @($choices) + @('(type a custom value)')
    $sel = Read-MenuChoice "Set $label" $opts @("Current: $current")
    if ($sel -lt 0) { return $current }
    if ($sel -lt $choices.Count) { $val = $choices[$sel] }
    else {
      Write-Host ""
      $val = Read-Host "Enter custom value for $label (blank=keep)"
      if ([string]::IsNullOrWhiteSpace($val)) { return $current }
    }
  } else {
    Write-Host ""
    $val = Read-Host "New value for $label (blank=keep)"
    if ([string]::IsNullOrWhiteSpace($val)) { return $current }
  }
  switch ($type) {
    'int'   { return [int]$val }
    'float' { return [double]$val }
    default { return $val }
  }
}

$ModelFields = @(
  @{ Key='name';            Label='Display name';                 Type='string' },
  @{ Key='model';           Label='Model GGUF path';              Type='string' },
  @{ Key='mmproj';          Label='mmproj/vision path (blank=none)'; Type='string' },
  @{ Key='alias';           Label='API alias';                    Type='string' },
  @{ Key='ctx';             Label='Context size';                 Type='int' },
  @{ Key='ngl';             Label='GPU layers (-ngl)';            Type='int' },
  @{ Key='moe';             Label='Is MoE (use --n-cpu-moe)';     Type='bool' },
  @{ Key='nCpuMoe';         Label='n-cpu-moe (experts on CPU; lower=faster/more VRAM)'; Type='int' },
  @{ Key='parallel';        Label='Parallel slots (agents)';      Type='int' },
  @{ Key='kvUnified';       Label='Unified KV (slots share ctx)'; Type='bool' },
  @{ Key='ctk';             Label='KV type K (-ctk)';             Type='string'; Choices=@('turbo4','turbo3','turbo2','f16','q8_0','q4_0') },
  @{ Key='ctv';             Label='KV type V (-ctv)';             Type='string'; Choices=@('turbo4','turbo3','turbo2','f16','q8_0','q4_0') },
  @{ Key='flashAttn';       Label='Flash attention (-fa)';        Type='string'; Choices=@('on','off','auto') },
  @{ Key='threads';         Label='CPU threads (-t)';             Type='int' },
  @{ Key='threadsBatch';    Label='Batch threads (-tb)';          Type='int' },
  @{ Key='imageMaxTokens';  Label='Image max tokens (~px)';       Type='int' },
  @{ Key='mmprojOffload';   Label='Vision encoder on GPU (fast; off=CPU)'; Type='bool' },
  @{ Key='cacheReuse';      Label='Prompt cache-reuse min chunk (0=off)';  Type='int' },
  @{ Key='reasoning';       Label='Reasoning/thinking';           Type='string'; Choices=@('on','off','auto') },
  @{ Key='reasoningFormat'; Label='Reasoning format';             Type='string'; Choices=@('deepseek','none') },
  @{ Key='spec';            Label='Speculative decode';           Type='string'; Choices=@('off','nextn') },
  @{ Key='specCapable';     Label='Has NextN/MTP head';           Type='bool' }
)
$SamplingFields = @(
  @{ Key='temp';            Label='temperature';      Type='float' },
  @{ Key='topP';            Label='top-p';            Type='float' },
  @{ Key='topK';            Label='top-k';            Type='int' },
  @{ Key='minP';            Label='min-p';            Type='float' },
  @{ Key='presencePenalty'; Label='presence-penalty'; Type='float' },
  @{ Key='repeatPenalty';   Label='repeat-penalty';   Type='float' }
)

function Edit-Sampling($m) {
  while ($true) {
    $items = foreach ($f in $SamplingFields) { "{0,-18}: {1}" -f $f.Label, $m.sampling.($f.Key) }
    $items = @($items) + @('<- Back')
    $sel = Read-MenuChoice "Sampling - $($m.id)" $items
    if ($sel -lt 0 -or $sel -eq $SamplingFields.Count) { return }
    $f = $SamplingFields[$sel]
    $m.sampling.($f.Key) = Edit-Value $f.Label $m.sampling.($f.Key) $f.Type $null
  }
}

function Edit-Model($cfg, $m) {
  while ($true) {
    $items = foreach ($f in $ModelFields) {
      $v = $m.($f.Key)
      "{0,-34}: {1}" -f $f.Label, $v
    }
    $items = @($items) + @('Sampling parameters...', '<- Back (saves on exit)')
    $sel = Read-MenuChoice "Edit model: $($m.id)" $items @("These are the launch parameters for this model.")
    if ($sel -lt 0 -or $sel -eq ($ModelFields.Count + 1)) { Save-Config $cfg; return }
    if ($sel -eq $ModelFields.Count) { Edit-Sampling $m; Save-Config $cfg; continue }
    $f = $ModelFields[$sel]
    $choices = if ($f.ContainsKey('Choices')) { $f.Choices } else { $null }
    $m.($f.Key) = Edit-Value $f.Label $m.($f.Key) $f.Type $choices
    Save-Config $cfg
  }
}

function Select-Model($cfg) {
  $items = foreach ($mm in $cfg.models) {
    $mark = if ($mm.id -eq $cfg.selected) { '[*]' } else { '[ ]' }
    "$mark $($mm.id)  -  $($mm.name)"
  }
  $sel = Read-MenuChoice "Select active model" $items @("[*] = current selection. This model loads on start.cmd.")
  if ($sel -lt 0) { return }
  $cfg.selected = $cfg.models[$sel].id
  Save-Config $cfg
}

function Edit-Settings($cfg) {
  $fields = @(
    @{ Key='host';            Label='Host';                 Type='string' },
    @{ Key='port';            Label='Port';                 Type='int' },
    @{ Key='idleTtlMinutes';  Label='Idle TTL (minutes, 0=off)'; Type='int' },
    @{ Key='startOpenWebUI';  Label='Start Open WebUI';     Type='bool' },
    @{ Key='freeVramFirst';   Label='Free VRAM (lms unload) on start'; Type='bool' }
  )
  while ($true) {
    $items = foreach ($f in $fields) { "{0,-32}: {1}" -f $f.Label, $cfg.settings.($f.Key) }
    $items = @($items) + @('<- Back')
    $sel = Read-MenuChoice "Global settings" $items
    if ($sel -lt 0 -or $sel -eq $fields.Count) { Save-Config $cfg; return }
    $f = $fields[$sel]
    $cfg.settings.($f.Key) = Edit-Value $f.Label $cfg.settings.($f.Key) $f.Type $null
    Save-Config $cfg
  }
}

function Invoke-Config {
  while ($true) {
    $cfg = Load-Config
    $m   = Get-Selected $cfg
    $hdr = @(
      "Selected : $($m.id)  ($($m.name))",
      "API      : http://$($cfg.settings.host):$($cfg.settings.port)/v1   |   Idle TTL: $($cfg.settings.idleTtlMinutes) min   |   Open WebUI: $($cfg.settings.startOpenWebUI)"
    )
    $menu = @(
      'Select active model',
      'Edit current model parameters',
      'Edit a different model',
      'Global settings (TTL / port / Open WebUI)',
      'Start server now',
      'Stop server now',
      'Quit'
    )
    $sel = Read-MenuChoice "llama-turbo control" $menu $hdr
    switch ($sel) {
      0 { Select-Model $cfg }
      1 { Edit-Model $cfg (Get-Selected $cfg) }
      2 {
          $names = $cfg.models | ForEach-Object { "$($_.id)  -  $($_.name)" }
          $pick = Read-MenuChoice "Pick a model to edit" $names
          if ($pick -ge 0) { Edit-Model $cfg $cfg.models[$pick] }
        }
      3 { Edit-Settings $cfg }
      4 { Clear-Host; Invoke-Start; Write-Host ''; Write-Host 'Press any key...'; [Console]::ReadKey($true) | Out-Null }
      5 { Clear-Host; Invoke-Stop;  Write-Host ''; Write-Host 'Press any key...'; [Console]::ReadKey($true) | Out-Null }
      -1 { return }
      6 { return }
    }
  }
}

# ---------- TDR fix (Windows GPU timeout; needs admin) ----------
function Invoke-TdrFix {
  Write-Host "TDR Fix: setting Windows GPU timeout delay to 60 s..." -ForegroundColor Cyan
  Write-Host "(Default is 2 s. Large LLM prefills exceed it -> GPU reset -> 'CUDA error: device not ready')" -ForegroundColor DarkGray
  $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
  try {
    Set-ItemProperty -Path $regPath -Name 'TdrDelay'    -Value 60 -Type DWord -ErrorAction Stop
    Set-ItemProperty -Path $regPath -Name 'TdrDdiDelay' -Value 60 -Type DWord -ErrorAction Stop
    Write-Host ""
    Write-Host "Done!  TdrDelay=60  TdrDdiDelay=60." -ForegroundColor Green
    Write-Host "REBOOT your PC for the change to take effect." -ForegroundColor Yellow
    Write-Host "After rebooting, 'CUDA error: device not ready' should be gone." -ForegroundColor Green
  } catch {
    Write-Host ""
    Write-Host "FAILED (Administrator required): $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Open an ADMIN PowerShell and paste:" -ForegroundColor Yellow
    Write-Host '  $p = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"' -ForegroundColor White
    Write-Host '  Set-ItemProperty -Path $p -Name TdrDelay    -Value 60 -Type DWord' -ForegroundColor White
    Write-Host '  Set-ItemProperty -Path $p -Name TdrDdiDelay -Value 60 -Type DWord' -ForegroundColor White
    Write-Host '  # Then reboot.' -ForegroundColor White
  }
}

# ---------- dispatch ----------
switch ($Command.ToLower()) {
  'server'   { Invoke-Server }
  'up'       { Invoke-Up }
  'args'     { $cfg = Load-Config; Write-Host ("llama-server " + ((Get-ServerArgs $cfg) -join ' ')) }
  'start'    { Invoke-Start }
  'stop'     { Invoke-Stop }
  'watchdog' { Invoke-Watchdog }
  'status'   { Invoke-Status }
  'config'   { Invoke-Config }
  'fix-tdr'  { Invoke-TdrFix }
  default    { Write-Host "Unknown command: $Command"; Write-Host "Use: config | start | up | stop | server | watchdog | status | args | fix-tdr" }
}
