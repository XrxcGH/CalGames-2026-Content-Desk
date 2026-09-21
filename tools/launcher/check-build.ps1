<#
    Does the launcher still build, and is what comes out the right shape?

        npm run check:launcher

    This exists because the launcher is the one deliverable with nothing
    checking it, and it shipped broken. The commit that held harness.mjs out of
    the volunteer payload used PowerShell's -replace, which takes a REGEX, with
    a pattern of a single backslash, which is not one. build.ps1 threw on its
    first staging loop and produced no exe at all, and that went unnoticed
    because the only thing that exercises the build is a person running it.

    A syntax check would not have caught that: the file parses fine and fails
    at runtime. So this runs the real build, with -NoEmbedNode so it skips the
    34 MB Node copy, and then asserts the things that have actually gone wrong
    before:

      the build completes and writes an exe
      the exe is a Windows GUI binary, not a console one, so a double-click
        opens no window somebody can close and stop the show with
      the payload does NOT contain harness.mjs, the arena writer
      the payload DOES contain the desk itself

    About 18 seconds. Run it before handing an exe to anybody.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here     = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $Here '..\..')).Path
$Out      = Join-Path $env:TEMP ('cgcd-launcher-check-' + [guid]::NewGuid().ToString('N').Substring(0, 8))

$failures = New-Object System.Collections.Generic.List[string]
function Check([string]$what, [bool]$ok) {
    if ($ok) { Write-Host "  ok    $what" }
    else { Write-Host "  FAIL  $what"; $failures.Add($what) }
}

try {
    Write-Host "Building (no embedded Node)..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Here 'build.ps1') `
        -NoEmbedNode -Output $Out | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 exited $LASTEXITCODE" }

    $exe = Join-Path $Out 'CalGamesContentDesk.exe'
    Check "build produced an exe" (Test-Path $exe)
    if (-not (Test-Path $exe)) { throw "no exe to inspect" }

    # Subsystem 2 is IMAGE_SUBSYSTEM_WINDOWS_GUI; 3 is console. Read it out of
    # the PE optional header rather than trusting the build flag.
    $bytes  = [System.IO.File]::ReadAllBytes($exe)
    $peOff  = [BitConverter]::ToInt32($bytes, 0x3C)
    $subsys = [BitConverter]::ToUInt16($bytes, $peOff + 24 + 68)
    Check "no console window (PE subsystem 2, got $subsys)" ($subsys -eq 2)

    # Both: ZipArchive itself lives in System.IO.Compression, and the
    # FileSystem assembly is the one that carries the directory helpers.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $asm    = [System.Reflection.Assembly]::LoadFile($exe)
    $stream = $asm.GetManifestResourceStream('payload.zip')
    Check "payload.zip is embedded" ($null -ne $stream)
    if ($null -ne $stream) {
        $zip   = New-Object System.IO.Compression.ZipArchive($stream)
        # Entry names are written with the platform separator.
        $names = $zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }
        Check "the arena writer harness.mjs is NOT shipped" (-not ($names -contains 'harness.mjs'))
        Check "the desk console is shipped" ($names -contains 'surfaces/desk/desk.js')
        Check "the server is shipped" ($names -contains 'apps/core/src/server.ts')
        Check "node_modules/ws is shipped" ([bool]($names -like 'node_modules/ws/*'))
    }
}
catch {
    # A readable line, not a stack. The most likely reader of this is somebody
    # about to hand an exe to a volunteer, and what they need is the reason.
    Write-Host ""
    Write-Host "  FAIL  $($_.Exception.Message)"
    Write-Host ""
    Write-Host "The launcher did not build. Run it directly to see the whole error:"
    Write-Host "    powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1"
    Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
    exit 1
}
finally {
    Remove-Item -Recurse -Force $Out -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) check(s) failed."
    exit 1
}
Write-Host "Launcher build is good."
