<#
    Builds the one-file launcher the AV crew double-clicks.

    Everything the volunteer needs ends up inside a single .exe: the desk
    itself, its one runtime dependency, the image tools, and a private copy of
    Node. That matters because a gym is the worst place to discover that the
    guest wifi blocks nodejs.org.

    The compiler is the one already inside Windows, so this needs no toolchain
    and produces something that needs no runtime install.

        powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1

    Options:
        -NoEmbedNode    leave Node out, ~35 MB smaller, downloads on first run
        -Output <path>  where to write the exe (default dist\)
#>

[CmdletBinding()]
param(
    [switch]$NoEmbedNode,
    [string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Here     = $PSScriptRoot
$Cache    = Join-Path $Here '.cache'
$Stage    = Join-Path $env:TEMP ('cg2026-launcher-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
if (-not $Output) { $Output = Join-Path $RepoRoot 'dist' }

# Keep these in step with the constants at the top of Launcher.cs. The exe
# verifies the checksum at install time, so a mismatch here fails loudly rather
# than shipping something unexpected.
$NodeVersion = 'v22.23.2'
$NodeSha256  = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
$NodeZipName = "node-$NodeVersion-win-x64.zip"
$NodeUrl     = "https://nodejs.org/dist/$NodeVersion/$NodeZipName"

# Runtime dependencies only. typescript and @types are for developing the desk,
# not running it, and they are most of the weight in node_modules.
# sharp 0.35 carries @img/colour instead of the old color-* chain; @img also
# holds the platform binaries, so vendoring the whole scope stays correct
# across sharp's own dependency changes.
$RuntimeModules = @(
    'ws',
    'sharp', '@img', 'detect-libc', 'semver'
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Say([string]$msg) { Write-Host "  $msg" }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }

function Get-Csc {
    $candidates = @(
        'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
        'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "No C# compiler found. This needs the .NET Framework 4.x that ships with Windows."
}

function Copy-Into([string]$src, [string]$dstRoot, [string]$relative) {
    $dst = Join-Path $dstRoot $relative
    $dir = Split-Path $dst -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
}

# ---- stage the payload ----------------------------------------------------

Step 'Staging the desk'
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

Push-Location $RepoRoot
try { $tracked = & git ls-files } finally { Pop-Location }
if (-not $tracked -or $tracked.Count -eq 0) { throw "git ls-files returned nothing. Run this from inside the repo." }

$n = 0
foreach ($rel in $tracked) {
    $src = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    Copy-Into $src $Stage $rel
    $n++
}
Say "$n tracked files"

# node_modules is gitignored, so it has to be added by hand. Vendoring it means
# the volunteer never runs npm install, and never needs the network to.
$modulesRoot = Join-Path $RepoRoot 'node_modules'
if (-not (Test-Path $modulesRoot)) { throw "node_modules is missing. Run npm install first." }

$m = 0
foreach ($mod in $RuntimeModules) {
    $src = Join-Path $modulesRoot $mod
    if (-not (Test-Path $src)) {
        if ($mod -eq 'ws') { throw "node_modules\ws is missing and the desk cannot run without it." }
        Say "skipping optional $mod (not installed)"
        continue
    }
    Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
        $rel = 'node_modules\' + $_.FullName.Substring($modulesRoot.Length + 1)
        Copy-Into $_.FullName $Stage $rel
        $m++
    }
}
Say "$m dependency files"

# ---- third-party licence texts --------------------------------------------
# The exe embeds Node and vendors sharp's @img prebuilt binaries (libvips), so
# it REDISTRIBUTES both and the licence texts have to travel with it. libvips
# is LGPL, which makes this an obligation rather than a courtesy. NOTICE says
# these files are here; this is what puts them here.
Step 'Staging third-party licences'
$thirdParty = @{
    'NODE-LICENSE.txt' = 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE'
    'LIBVIPS-LICENSE.txt' = 'https://raw.githubusercontent.com/libvips/libvips/master/LICENSE'
}
foreach ($name in $thirdParty.Keys) {
    $cached = Join-Path $Cache $name
    if (-not (Test-Path $Cache)) { New-Item -ItemType Directory -Path $Cache -Force | Out-Null }
    if (-not (Test-Path $cached)) {
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $thirdParty[$name] -OutFile $cached -UseBasicParsing -TimeoutSec 120
        } catch {
            throw ("Could not fetch $name ($($thirdParty[$name])). The exe redistributes this " +
                   "component, so its licence text is not optional. Fetch it by hand into $cached " +
                   'and run again.')
        }
    }
    Copy-Into $cached $Stage ('third-party\' + $name)
    Say "third-party/$name"
}

# A first-run note the volunteer sees if they open the folder before the desk.
$readme = @"
CalGames 2026 Content Desk
==========================

Double-click START-DESK.cmd to run the desk for real.
Double-click START-PRACTICE.cmd to try it with a pretend match instead.

Either way, a window opens and after a minute it prints READY with an
address like http://10.0.100.23:8720/
Type that address into any pit monitor, laptop, or phone on the same
network to see the screens. Leave the window open: closing it stops
the desk.

Audience screens need no PIN. Control screens ask for the event PIN,
which the READY message prints.

Do not delete config.json or data/trivia.json: those are yours, and the
launcher leaves them alone when it updates everything else.

Full documentation is in the docs folder. Start with README.md.
"@
Set-Content -Path (Join-Path $Stage 'READ-ME-FIRST.txt') -Value $readme -Encoding UTF8

$payloadZip = Join-Path $Stage '..\cg2026-payload.zip'
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $Stage, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$payloadZip = (Resolve-Path $payloadZip).Path
Say ("payload.zip is {0:N1} MB" -f ((Get-Item $payloadZip).Length / 1MB))

# ---- fetch node -----------------------------------------------------------

$nodeZip = $null
if (-not $NoEmbedNode) {
    Step 'Fetching Node'
    if (-not (Test-Path $Cache)) { New-Item -ItemType Directory -Path $Cache -Force | Out-Null }
    $nodeZip = Join-Path $Cache $NodeZipName

    if (Test-Path $nodeZip) {
        Say 'using the cached copy'
    } else {
        Say "downloading $NodeUrl"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $NodeUrl -OutFile $nodeZip -UseBasicParsing -TimeoutSec 900
    }

    $actual = (Get-FileHash -Path $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $NodeSha256) {
        Remove-Item $nodeZip -Force
        throw "Node checksum mismatch. Expected $NodeSha256 but got $actual. The cached file has been deleted; run again."
    }
    Say ("checksum verified, {0:N1} MB" -f ((Get-Item $nodeZip).Length / 1MB))
}

# ---- compile --------------------------------------------------------------

Step 'Compiling'
$csc = Get-Csc
Say (Split-Path $csc -Parent)

if (-not (Test-Path $Output)) { New-Item -ItemType Directory -Path $Output -Force | Out-Null }
$exe = Join-Path $Output 'CalGamesContentDesk.exe'

# Written next to the source so the exe carries a sensible description in the
# Windows file properties dialog, which is where a suspicious volunteer looks.
$asmInfo = Join-Path $Stage 'AssemblyInfo.cs'
Set-Content -Path $asmInfo -Encoding UTF8 -Value @"
using System.Reflection;
[assembly: AssemblyTitle("CalGames 2026 Content Desk")]
[assembly: AssemblyDescription("Sets up and starts the CalGames 2026 content desk.")]
[assembly: AssemblyCompany("Western Region Robotics Forum")]
[assembly: AssemblyProduct("CalGames 2026 Content Desk")]
[assembly: AssemblyCopyright("(c) 2026 Western Region Robotics Forum")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
"@

$cscArgs = @(
    '-nologo',
    '-target:exe',
    '-platform:anycpu',
    '-optimize+',
    '-warnaserror-',
    "-out:$exe",
    '-r:System.dll',
    '-r:System.Core.dll',
    '-r:System.IO.Compression.dll',
    '-r:System.IO.Compression.FileSystem.dll',
    "-resource:$payloadZip,payload.zip"
)
if ($nodeZip) { $cscArgs += "-resource:$nodeZip,node.zip" }
$cscArgs += (Join-Path $Here 'Launcher.cs')
$cscArgs += $asmInfo

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compile failed with exit code $LASTEXITCODE." }

# ---- clean up -------------------------------------------------------------

Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $payloadZip -Force -ErrorAction SilentlyContinue

Step 'Done'
$size = (Get-Item $exe).Length
Say $exe
Say ("{0:N1} MB" -f ($size / 1MB))
Write-Host ''
Write-Host '  Hand that one file to the AV crew. Nothing else is needed.' -ForegroundColor Green
Write-Host ''
