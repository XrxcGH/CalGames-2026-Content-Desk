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

Push-Location $RepoRoot
try {
    $tracked = & git ls-files
    # Files the desk needs that git does not know about yet. The payload is
    # what git tracks, so a new module left out of git builds an exe that
    # stops at start with ERR_MODULE_NOT_FOUND, on the AV table, with nobody
    # who can fix it. Refused here, by name, rather than found there. Tests
    # are not shipped code, so a new *.test.ts alone does not stop a build.
    $untracked = @(& git ls-files --others --exclude-standard -- apps surfaces packages QUICK-START.md QUICK-START.pdf |
        Where-Object { $_ -notmatch '\.test\.ts$' })
} finally { Pop-Location }
if (-not $tracked -or $tracked.Count -eq 0) { throw "git ls-files returned nothing. Run this from inside the repo." }
if ($untracked.Count -gt 0) {
    $list = $untracked -join "`n  "
    throw "These files are not in git, so the exe would be built without them and the desk would not start:`n  $list`nRun git add -N on each one (or git add them), then build again."
}
# Made only once the checks above have passed, so a refused build leaves
# nothing behind in TEMP.
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

# Tracked, but never shipped. harness.mjs is a Cheesy Arena WRITER: it opens
# /match_play/websocket and the scoring panels and sends toggleBypass,
# startMatch, fabricated scoring and commitAndPost. It exists to drive a local
# dev arena while developing the bridge, and it has no business on a machine
# sitting on the field network at an event. The desk's own bridge is
# receive-only and GET-only; this would be the one thing in the payload that
# could write a result into the event database.
$NeverShip = @('harness.mjs')

$n = 0
$skipped = 0
foreach ($rel in $tracked) {
    # .Replace, not -replace: the latter takes a REGEX, and a lone backslash is
    # not a valid one. `git ls-files` already reports forward slashes, so this
    # is only here for the case where it does not.
    if ($NeverShip -contains $rel.Replace('\', '/')) { $skipped++; continue }
    $src = Join-Path $RepoRoot $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    Copy-Into $src $Stage $rel
    $n++
}
Say "$n tracked files ($skipped held back: arena-writing tools)"

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
# It sends them to the one-page QUICK-START first: the 43-page handbook was the
# only help on a test night when a screen stuck on white, and the volunteers
# gave up rather than troubleshoot through it. So it promises nothing to read
# beyond that page, and nothing to edit: the desk finds the field and the
# switcher itself, and the codes change on a page. No dollar signs in it: this
# is a double-quoted here-string, which would expand them.
$readme = @"
CalGames 2026 Content Desk
==========================

START WITH QUICK-START.pdf IN THIS FOLDER. It is one page: the five things
only a person can do, and where the desk itself explains anything that looks
wrong. (QUICK-START.md is the same text.)

Double-click START-DESK.cmd to run the desk for real.
Double-click START-PRACTICE.cmd to try it with a pretend match instead.

Nothing appears for up to a minute the first time. Then your web browser
opens by itself on the desk's front page. It says what this computer is for,
what the desk found (the field, the video switcher, the screens), and what to
do if something is not working. The "Start here" box under the big buttons
shows this desk's address on the network and the PIN: write both on the
whiteboard.

The desk finds the field and the video switcher by itself once this laptop
is on the field network, and keeps looking until it does. Nothing needs
editing and nothing needs restarting.

The video switcher: on the computer that feeds its overlay input (the one
that showed Cheesy Arena's score overlay), open that address with s/program
on the end and press F11. A projector or TV: on the computer whose HDMI
cable goes to it, open the address with s/watch on the end, click the card
for that display (Program for the projector), and press F11. OBS is not
needed.

Before doors, change the desk PIN, the settings code and the awards code:
"Change the codes" in the Start here box opens the page that does it.

There is no other window, on purpose. If something goes wrong, a red error
box says what. Lost the browser tab, or something looks stuck? Double-click
again: if the desk is running it just reopens it, and it never stops a show.
To start it fresh instead (for example to run a newer copy of the exe), stop
it first:
Task Manager (Ctrl+Shift+Esc), find "CalGames 2026 Content Desk", End task,
then double-click again.

To check every screen before there is a show, press "Fill the screens with
sample data" in the Start here box. You do not need to restart anything
afterwards: the sample clears itself from every screen when the first real
match loads. To clear it sooner, press "Clear sample data" in the Sample
data section of the desk console.

Do not delete config.json, desk-pin.txt or the data folder: those are
yours (the codes and connections changed on the settings page are kept
there), and the launcher leaves them alone when it updates everything else.

RUN-THE-DESK.pdf in this folder is the full handbook, for reference only:
nobody needs to read it to run the show.

The rest of the documentation is in the docs folder.
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
    # winexe, not exe: a console application gets a black window that stays on
    # the desk laptop for the whole event, and closing it stops the show. The
    # launcher attaches to a parent console when it is started from one, so
    # running it from PowerShell still prints everything.
    '-target:winexe',
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
