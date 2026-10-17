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
      the payload DOES contain the desk itself, every module it imports,
        and every file the first-run note sends the volunteer to
      the launcher's own decisions, run inside the built exe: the desk's
        command line for each kind of start, and the cap on restarts

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
    # From the bytes already read, not LoadFile: a loaded file stays locked
    # until this PowerShell exits, so the cleanup below could not delete it
    # and every check left a 20 MB exe in TEMP.
    $asm    = [System.Reflection.Assembly]::Load($bytes)
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

        # Every module the desk imports is in the payload. build.ps1 ships
        # what git tracks, so a new file nobody has run `git add` on is left
        # out, and that exe dies at start with ERR_MODULE_NOT_FOUND: on the
        # AV table it is a browser page that never loads, with nothing on it
        # to say why. So read every shipped desk module and surface script
        # and check each relative import resolves to a shipped file.
        $shipped = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($nm in $names) { [void]$shipped.Add($nm) }
        $missing = New-Object System.Collections.Generic.List[string]
        $importRx = [regex]'(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)[''"](\.{1,2}/[^''"]+)[''"]'
        foreach ($entry in $zip.Entries) {
            $full = $entry.FullName.Replace('\', '/')
            $isDesk = $full -like 'apps/core/src/*.ts' -and -not ($full -like '*.test.ts')
            $isSurface = $full -like 'surfaces/*.js'
            if (-not ($isDesk -or $isSurface)) { continue }
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $folder = $full.Substring(0, $full.LastIndexOf('/'))
            foreach ($m in $importRx.Matches($text)) {
                $parts = New-Object System.Collections.Generic.List[string]
                foreach ($seg in ($folder + '/' + $m.Groups[1].Value).Split('/')) {
                    if ($seg -eq '.' -or $seg -eq '') { continue }
                    if ($seg -eq '..') { if ($parts.Count -gt 0) { $parts.RemoveAt($parts.Count - 1) }; continue }
                    $parts.Add($seg)
                }
                $target = [string]::Join('/', $parts)
                if (-not $shipped.Contains($target)) { $missing.Add("$full imports $target") }
            }
        }
        foreach ($line in ($missing | Select-Object -First 8)) { Write-Host "        not shipped: $line" }
        if ($missing.Count -gt 0) {
            Write-Host "        build.ps1 ships only what git tracks: git add the new files, then build again."
        }
        Check "every module the desk imports is shipped ($($missing.Count) missing)" ($missing.Count -eq 0)

        # Every file the first-run note sends the volunteer to is shipped.
        # READ-ME-FIRST.txt opens with "START WITH QUICK-START.pdf", and the
        # same git-tracked-only rule leaves out a quick start nobody has run
        # git add on: the note would then point a first-time volunteer at a
        # file that is not there, which is the night the one page exists for.
        # START-*.cmd are not checked: the launcher writes those at install.
        $readmeEntry = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'READ-ME-FIRST.txt' } | Select-Object -First 1
        Check "the first-run note READ-ME-FIRST.txt is shipped" ($null -ne $readmeEntry)
        if ($null -ne $readmeEntry) {
            $reader = New-Object System.IO.StreamReader($readmeEntry.Open())
            try { $readmeText = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $named = @([regex]::Matches($readmeText, '\b[A-Z][A-Z0-9-]*\.(?:pdf|md|txt)\b') |
                ForEach-Object { $_.Value } | Sort-Object -Unique)
            Check "the first-run note names the one-page quick start" ($named -contains 'QUICK-START.pdf')
            foreach ($file in $named) {
                Check "the first-run note names $file, and it is shipped" ($names -contains $file)
            }
            if (-not (($names -contains 'QUICK-START.pdf') -and ($names -contains 'QUICK-START.md'))) {
                Write-Host "        git add QUICK-START.md QUICK-START.pdf, then build again."
            }
        }
    }

    # The launcher's own decisions, run inside the exe just built. They are
    # private, and the only other way to exercise them is to start real desks,
    # so this reaches them by reflection. Each case is a start a volunteer
    # really makes, and each assertion is a way it has gone wrong or could:
    # a desk that never looks for the field, practice mode searching a real
    # network, or a bare --display-id that the desk refuses with exit code 1.
    $flags    = [System.Reflection.BindingFlags]'NonPublic, Public, Static'
    $launcher = $asm.GetType('Launcher')
    $optsType = $launcher.GetNestedType('Options', [System.Reflection.BindingFlags]'NonPublic')
    $parse    = $optsType.GetMethod('Parse', $flags)
    $optField = $launcher.GetField('_opt', $flags)
    $deskArgs = $launcher.GetMethod('DeskArguments', $flags)
    $allow    = $launcher.GetMethod('AllowRestart', $flags)
    Check "the launcher's start logic can be reached in the exe" (
        ($null -ne $parse) -and ($null -ne $optField) -and ($null -ne $deskArgs) -and ($null -ne $allow))
    if (($null -ne $parse) -and ($null -ne $optField) -and ($null -ne $deskArgs) -and ($null -ne $allow)) {
      # Its own try: a failure in here is a failed check, not "did not build".
      try {
        # $fieldHost untyped on purpose: a [string] parameter turns $null into
        # "", and null is what "no field found" is.
        function OptionsFor([string[]]$launcherArgs) { return $parse.Invoke($null, @(, $launcherArgs)) }
        function ArgsFor([string[]]$launcherArgs, $fieldHost) {
            $optField.SetValue($null, (OptionsFor $launcherArgs))
            [object[]]$call = 'C:\cg\apps\core\src\index.ts', 8720, $fieldHost
            return [string]$deskArgs.Invoke($null, $call)
        }

        $plain = ArgsFor @() $null
        Check "a plain start with no field yet: --discover, the default display ID, quoted" (
            $plain.Contains(' --discover') -and $plain.Contains(' --display-id "contentdesk1"') -and
            -not $plain.Contains('--no-field-search') -and -not $plain.Contains(' --demo') -and
            -not $plain.Contains(' --cheesy'))

        $found = ArgsFor @() '10.0.100.5:8080'
        Check "a start that found the field: bridged at once, and still --discover" (
            $found.Contains(' --cheesy --cheesy-host 10.0.100.5:8080') -and $found.Contains(' --discover') -and
            $found.Contains(' --display-id "contentdesk1"'))

        $demo = ArgsFor @('/demo') $null
        Check "practice (/demo): --demo, and never --discover" (
            $demo.Contains(' --demo') -and -not $demo.Contains('--discover') -and -not $demo.Contains('--display-id'))

        $off = ArgsFor @('/no-cheesy') $null
        Check "/no-cheesy: --discover --no-field-search, no field and no display ID" (
            $off.Contains(' --discover --no-field-search') -and -not $off.Contains(' --cheesy') -and
            -not $off.Contains('--display-id'))

        $bare = ArgsFor @('/display-id:') $null
        Check "/display-id: with nothing after it keeps the default, not a bare --display-id" (
            $bare.Contains(' --display-id "contentdesk1"'))
        $spaced = ArgsFor @('/display-id: Desk 2 "x\') $null
        Check "a display ID with a space stays one quoted argument" ($spaced.Contains(' --display-id "Desk 2 x"'))
        $dashes = ArgsFor @('/display-id:--') $null
        Check "a display ID of only dashes keeps the default" ($dashes.Contains(' --display-id "contentdesk1"'))

        $emptyHost = OptionsFor @('/cheesy-host:')
        Check "/cheesy-host: with nothing after it means not given, not :8080" (
            $null -eq $optsType.GetField('CheesyHost').GetValue($emptyHost))

        # A desk that stops while starting: the message box says what to do,
        # in words, from what the desk printed. Fed the lines Node 22 really
        # prints for a missing module, and a tagged refusal of the desk's own.
        $note    = $launcher.GetMethod('NoteDeskError', $flags)
        $failMsg = $launcher.GetMethod('StartFailure', $flags)
        $saidF   = $launcher.GetField('_deskSaid', $flags)
        $missF   = $launcher.GetField('_deskMissingFiles', $flags)
        function Feed([string[]]$lines) {
            $saidF.SetValue($null, $null)
            $missF.SetValue($null, $false)
            foreach ($l in $lines) { [void]$note.Invoke($null, [object[]]@(, $l)) }
            return [string]$failMsg.Invoke($null, [object[]]@(, 1))
        }
        $moduleMsg = Feed @(
            'node:internal/modules/esm/resolve:271',
            '    throw new ERR_MODULE_NOT_FOUND(',
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\cg\apps\core\src\settings.ts' imported from C:\cg\apps\core\src\index.ts",
            '    at finalizeResolution (node:internal/modules/esm/resolve:271:11)',
            "  code: 'ERR_MODULE_NOT_FOUND',",
            'Node.js v22.23.2')
        Check "a desk missing its own files: the message says get a new copy of the exe" (
            $moduleMsg.Contains('missing some of its own files') -and $moduleMsg.Contains('new copy of the exe') -and
            -not $moduleMsg.Contains('exit code'))
        $refusedMsg = Feed @(
            '(node:4242) ExperimentalWarning: Type Stripping is an experimental feature',
            '[core] --port needs a value after it, and none was given.',
            'Node.js v22.23.2')
        Check "a desk that refused to start: the message repeats what it said" (
            $refusedMsg.Contains('It said: [core] --port needs a value') -and -not $refusedMsg.Contains('missing'))
        $quietMsg = Feed @('Node.js v22.23.2')
        Check "a desk that said nothing useful: the exit code alone" (
            $quietMsg -eq 'The desk stopped while starting up (exit code 1).')

        # Three restarts inside ten minutes, then no more; a fourth is allowed
        # again once the first has aged out of the window.
        # ::new, not New-Object: New-Object hands back a PSObject wrapper,
        # which reflection cannot pass as a List<DateTime>.
        $restarts = [System.Collections.Generic.List[DateTime]]::new()
        $t0 = [DateTime]::UtcNow
        $got = @()
        foreach ($s in 0, 60, 120, 180) {
            $call = [object[]]::new(2)
            $call[0] = $restarts
            $call[1] = $t0.AddSeconds($s)
            $got += [bool]$allow.Invoke($null, $call)
        }
        $call = [object[]]::new(2)
        $call[0] = $restarts
        $call[1] = $t0.AddMinutes(10).AddSeconds(1)
        $later = [bool]$allow.Invoke($null, $call)
        Check "restarts: 3 allowed inside 10 minutes, the 4th refused, allowed again later (got $($got -join ','),$later)" (
            ($got -join ',') -eq 'True,True,True,False' -and $later)
      }
      catch {
        Check "the launcher's start logic ran in the exe ($($_.Exception.Message))" $false
      }
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
