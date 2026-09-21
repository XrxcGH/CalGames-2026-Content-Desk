/*
 * CalGames 2026 Content Desk, one-file launcher for the AV crew.
 *
 * The volunteer who sets up the pit monitors on Saturday morning has not seen a
 * terminal before and will not read a README. They get one file. They
 * double-click it. The desk comes up. That is the whole design brief, and every
 * decision below follows from it.
 *
 * What it does, in order:
 *   1. unpacks the desk into Downloads, keeping any config and question bank
 *      already there
 *   2. finds a usable Node, or installs a private copy that needs no admin
 *      rights and touches nothing else on the machine
 *   3. scans the local network for Cheesy Arena, read-only, using the same
 *      allowlisted endpoint the field bridge itself uses
 *   4. starts the desk and prints the address to type into every pit monitor
 *
 * Built with the C# compiler that ships inside Windows, so the build needs no
 * toolchain and the result needs no runtime install. That compiler is C# 5, so
 * there is no string interpolation and no null-conditional operator here. It
 * reads a little dated on purpose.
 *
 * Build:  powershell -File tools/launcher/build.ps1
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal static class Launcher
{
    private const string AppTitle = "CalGames 2026 Content Desk";
    private const string FolderName = "CalGames2026-ContentDesk";

    // Pinned so every AV machine at the event runs the same thing. The desk
    // needs 22.6 or newer for native TypeScript type stripping; this is the
    // Node 22 LTS line, which gets security fixes through the 2026 season.
    private const string NodeVersion = "v22.23.2";
    private const string NodeSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";
    private const int NodeMinMajor = 22;
    private const int NodeMinMinor = 6;

    private const string DefaultPin = "0864";
    private const int DefaultPort = 8720;

    // Cheesy Arena's own default. Worth probing first because at an FRC event it
    // is nearly always right, which turns a network scan into a single request.
    private const string FieldDefaultHost = "10.0.100.5";
    private const int FieldPort = 8080;

    // On the allowlist in apps/core/src/ingest/cheesy/client.ts, GET-only, and
    // read by the bridge anyway. Probing with anything else would weaken the
    // promise the FTA signed off on.
    private const string FieldProbePath = "/api/rankings";

    private static Options _opt;
    private static Process _desk;
    private static StreamWriter _log;
    private static string _logDir;
    private static readonly object ConsoleLock = new object();

    private static int Main(string[] rawArgs)
    {
        Console.Title = AppTitle;
        // Node prints box-drawing characters and the desk banner uses them.
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
        ServicePointManager.DefaultConnectionLimit = 128;
        ServicePointManager.Expect100Continue = false;

        try
        {
            _opt = Options.Parse(rawArgs);
            if (_opt.ShowHelp) { PrintHelp(); return 0; }

            Banner();

            // The bundled Node is the x64 build. 64-bit Windows on ARM emulates
            // it fine; genuine 32-bit Windows cannot run it at all, and finding
            // that out as a cryptic exec failure would waste somebody's morning.
            if (!Environment.Is64BitOperatingSystem)
            {
                Warn("This is 32-bit Windows. The bundled Node will not run here.");
                Detail("Use a 64-bit machine, or install Node " + NodeMinMajor + "." + NodeMinMinor +
                       " or newer by hand and run START-DESK.cmd.");
            }

            string installDir = Step1Unpack();
            string nodeExe = Step2Node();
            string fieldHost = Step3Field();
            return Step4Run(installDir, nodeExe, fieldHost);
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Fail("Something went wrong and the desk did not start.");
            Console.WriteLine();
            Console.WriteLine("   " + ex.Message);
            Console.WriteLine();
            Console.WriteLine("   Tell the content desk lead, and include the line above.");
            Console.WriteLine("   The full detail is in: " + LogPath());
            // Through the same writer the relay uses. Opening the file a second
            // time would collide with it and lose exactly the detail we want.
            WriteLog(DateTime.Now.ToString(CultureInfo.InvariantCulture));
            WriteLog(ex.ToString());
            Hold();
            return 1;
        }
    }

    // ---- step 1: unpack ----------------------------------------------------

    private static string Step1Unpack()
    {
        string target = _opt.InstallDir ?? Path.Combine(DownloadsFolder(), FolderName);
        Step(1, "Unpacking the content desk");
        Detail("into " + target);

        Directory.CreateDirectory(target);
        _logDir = target;

        using (Stream payload = OpenResource("payload.zip"))
        {
            if (payload == null)
            {
                // A build without the payload is a development build. Running
                // from a checkout is a legitimate way to test the launcher, so
                // this is a warning rather than an error.
                Warn("no payload inside this launcher, using the folder as it is");
                return target;
            }

            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                int written = 0, kept = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;

                    string dest = SafeCombine(target, entry.FullName);
                    if (dest == null) continue;

                    if (File.Exists(dest) && IsUserData(entry.FullName))
                    {
                        // The operator edits the question bank from the quiz
                        // console during the event. Shipping a fresh copy over
                        // the top of that would quietly delete an afternoon of
                        // their work.
                        kept++;
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    entry.ExtractToFile(dest, true);
                    written++;
                }
                Ok(written + " files unpacked" + (kept > 0 ? ", " + kept + " of yours left alone" : ""));
            }
        }

        WriteRestartScript(target);
        return target;
    }

    /// Files the operator owns once the event starts. Never overwrite these.
    private static bool IsUserData(string relativePath)
    {
        string p = relativePath.Replace('\\', '/').ToLowerInvariant();
        return p == "config.json"
            || p == "data/trivia.json"
            || p.StartsWith("data/events/", StringComparison.Ordinal)
            || p.StartsWith("media/", StringComparison.Ordinal);
    }

    /// Zip entries are untrusted input even when we built the zip ourselves.
    private static string SafeCombine(string root, string entryName)
    {
        string cleaned = entryName.Replace('/', Path.DirectorySeparatorChar);
        string full = Path.GetFullPath(Path.Combine(root, cleaned));
        string rootFull = Path.GetFullPath(root);
        if (!rootFull.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
            rootFull += Path.DirectorySeparatorChar;
        return full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    /// So the crew can restart the desk after a reboot without hunting for the
    /// exe, and so it restarts in place even if somebody moved the folder off
    /// Downloads onto a shared drive.
    private static void WriteRestartScript(string target)
    {
        try
        {
            string exe = Assembly.GetExecutingAssembly().Location;
            string copy = Path.Combine(target, "START-DESK.exe");
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return;
            if (string.Equals(Path.GetFullPath(exe), Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase))
                return;

            // Skip the 40 MB copy when it is already the same build.
            if (!File.Exists(copy) || new FileInfo(copy).Length != new FileInfo(exe).Length)
                File.Copy(exe, copy, true);

            string cmd =
                "@echo off\r\n" +
                "title " + AppTitle + "\r\n" +
                "cd /d \"%~dp0\"\r\n" +
                "\"%~dp0START-DESK.exe\" /dir:\"%~dp0.\" %*\r\n";
            File.WriteAllText(Path.Combine(target, "START-DESK.cmd"), cmd);

            // The practice route for someone who has never typed a flag:
            // double-click this instead of START-DESK.cmd.
            string demo =
                "@echo off\r\n" +
                "title " + AppTitle + " (practice)\r\n" +
                "cd /d \"%~dp0\"\r\n" +
                "\"%~dp0START-DESK.exe\" /dir:\"%~dp0.\" /demo %*\r\n";
            File.WriteAllText(Path.Combine(target, "START-PRACTICE.cmd"), demo);
        }
        catch
        {
            // A read-only Downloads folder is not worth failing the launch over.
        }
    }

    // ---- step 2: node ------------------------------------------------------

    private static string Step2Node()
    {
        Step(2, "Checking for Node.js");

        string priv = PrivateNodeExe();
        if (File.Exists(priv) && VersionOk(NodeVersionOf(priv)))
        {
            Ok("using the copy installed here earlier (" + NodeVersionOf(priv) + ")");
            return priv;
        }

        string onPath = WhichNode();
        if (onPath != null)
        {
            string v = NodeVersionOf(onPath);
            if (VersionOk(v))
            {
                Ok("found " + v + " already on this machine");
                return onPath;
            }
            Detail("found " + (v ?? "an unreadable version") + ", but the desk needs " +
                   NodeMinMajor + "." + NodeMinMinor + " or newer");
        }

        Detail("installing a private copy of Node " + NodeVersion + ", nothing else on this machine changes");
        return InstallNode();
    }

    private static string PrivateNodeRoot()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CalGamesContentDesk", "node");
    }

    private static string PrivateNodeExe()
    {
        return Path.Combine(PrivateNodeRoot(), "node-" + NodeVersion + "-win-x64", "node.exe");
    }

    private static string InstallNode()
    {
        string root = PrivateNodeRoot();
        Directory.CreateDirectory(root);

        string zipPath = Path.Combine(Path.GetTempPath(), "node-" + NodeVersion + "-win-x64.zip");
        bool haveZip = false;

        using (Stream embedded = OpenResource("node.zip"))
        {
            if (embedded != null)
            {
                Detail("unpacking the bundled Node, no download needed");
                using (FileStream fs = File.Create(zipPath)) embedded.CopyTo(fs);
                haveZip = true;
            }
        }

        if (!haveZip)
        {
            string url = "https://nodejs.org/dist/" + NodeVersion + "/node-" + NodeVersion + "-win-x64.zip";
            Detail("downloading Node from nodejs.org, about 34 MB");
            Download(url, zipPath);
            haveZip = true;
        }

        string actual = Sha256File(zipPath);
        if (!string.Equals(actual, NodeSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new Exception(
                "The Node download does not match its published checksum, so it was not installed. " +
                "Expected " + NodeSha256 + " but got " + actual + ". " +
                "Try again on a different network.");
        }

        string marker = Path.Combine(root, "node-" + NodeVersion + "-win-x64");
        if (Directory.Exists(marker)) Directory.Delete(marker, true);
        ZipFile.ExtractToDirectory(zipPath, root);
        try { File.Delete(zipPath); } catch { }

        string exe = PrivateNodeExe();
        if (!File.Exists(exe)) throw new Exception("Node unpacked but node.exe is not where it should be: " + exe);

        Ok("installed Node " + NodeVersion);
        return exe;
    }

    private static string WhichNode()
    {
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            string candidate;
            try { candidate = Path.Combine(dir.Trim(), "node.exe"); } catch { continue; }
            if (File.Exists(candidate)) return candidate;
        }
        foreach (string guess in new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
        })
        {
            if (File.Exists(guess)) return guess;
        }
        return null;
    }

    private static string NodeVersionOf(string nodeExe)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "-v");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                string outp = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(10000);
                return outp.Length > 0 ? outp : null;
            }
        }
        catch { return null; }
    }

    private static bool VersionOk(string v)
    {
        if (string.IsNullOrEmpty(v)) return false;
        Match m = Regex.Match(v, @"v?(\d+)\.(\d+)\.");
        if (!m.Success) return false;
        int major = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        int minor = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        return major > NodeMinMajor || (major == NodeMinMajor && minor >= NodeMinMinor);
    }

    // ---- step 3: find the field -------------------------------------------

    private static string Step3Field()
    {
        Step(3, "Looking for the field");

        if (_opt.Demo)
        {
            // Demo drives pretend match data onto the bus. Attaching a real
            // field at the same time would give every screen two sources.
            Detail("skipped, practice mode uses pretend match data");
            return null;
        }
        if (_opt.NoCheesy)
        {
            Detail("skipped, the desk will run without a field connection");
            return null;
        }
        if (_opt.CheesyHost != null)
        {
            Detail("using the address you gave: " + _opt.CheesyHost);
            return _opt.CheesyHost;
        }

        // The scan is GET-only against one allowlisted endpoint, which is the
        // same guarantee the running bridge makes. Nothing here can steer the
        // field, and a machine that is not Cheesy Arena just fails to answer.
        List<string> candidates = FieldCandidates();
        Detail("checking " + candidates.Count + " addresses on port " + FieldPort + ", read-only");

        string found = ScanForField(candidates);
        if (found == null)
        {
            Warn("no field found");
            // The venue case and the kitchen-table case look identical here.
            // At the venue the right answer is manual mode; at home it is the
            // demo, because blank screens make a first-timer assume it broke.
            // Ask, default to manual after the timeout so an unattended AV
            // machine never stalls on a question.
            if (OfferDemo())
            {
                _opt.Demo = true;
                Ok("practice mode: the screens will show a pretend match");
                return null;
            }
            Detail("starting in manual mode; the producer types match numbers by hand");
            Detail("to attach the field later, restart with:  START-DESK.cmd /cheesy-host:10.0.100.5:8080");
            return null;
        }

        Ok("found Cheesy Arena at " + found);
        return found;
    }

    /// The field's own default first, then our own /24s. Order matters: the
    /// scan stops at the first answer, and at an FRC event the first guess
    /// is nearly always right.
    private static List<string> FieldCandidates()
    {
        List<string> list = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        Action<string> add = ip =>
        {
            if (!string.IsNullOrEmpty(ip) && seen.Add(ip)) list.Add(ip);
        };

        add(FieldDefaultHost);

        // The FRC field network is 10.0.100.0/24 by convention whether or not
        // this machine happens to be sitting on it.
        for (int i = 1; i < 255; i++) add("10.0.100." + i);

        foreach (UnicastIPAddressInformation info in LocalIPv4s())
        {
            byte[] addr = info.Address.GetAddressBytes();
            int prefix = PrefixLength(info);

            // A /16 scan is 65k requests and would look like a port sweep on
            // the venue network. Stay inside our own /24 and let the operator
            // pass an address by hand for anything stranger.
            if (prefix < 24) prefix = 24;
            if (prefix > 24) continue;

            for (int i = 1; i < 255; i++)
                add(addr[0] + "." + addr[1] + "." + addr[2] + "." + i);
        }

        return list;
    }

    private static int PrefixLength(UnicastIPAddressInformation info)
    {
        try
        {
            byte[] mask = info.IPv4Mask.GetAddressBytes();
            int bits = 0;
            foreach (byte b in mask)
            {
                for (int i = 7; i >= 0; i--) if ((b & (1 << i)) != 0) bits++;
            }
            return bits;
        }
        catch { return 24; }
    }

    private static IEnumerable<UnicastIPAddressInformation> LocalIPv4s()
    {
        foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up) continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (UnicastIPAddressInformation ip in ni.GetIPProperties().UnicastAddresses)
            {
                if (ip.Address.AddressFamily == AddressFamily.InterNetwork) yield return ip;
            }
        }
    }

    /// Two passes: a cheap TCP knock on every candidate, then an HTTP check on
    /// only the few that answered. One pass of HTTP against 500 addresses would
    /// take minutes; this takes seconds.
    private static string ScanForField(List<string> candidates)
    {
        var answered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Deliberately not disposed. If the scan hits its deadline the probes
        // behind it are still in flight, and disposing this out from under them
        // turns a slow network into a pile of exceptions on background threads.
        var gate = new SemaphoreSlim(96);

        var tasks = candidates.Select(ip => Task.Run(async () =>
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (await TcpOpen(ip, FieldPort, 600).ConfigureAwait(false))
                {
                    lock (answered) answered.Add(ip);
                }
            }
            finally { gate.Release(); }
        })).ToArray();

        if (!Task.WaitAll(tasks, TimeSpan.FromSeconds(25)))
            Detail("scan is taking a while, checking what has answered so far");

        List<string> open;
        lock (answered) open = candidates.Where(answered.Contains).ToList();
        if (open.Count == 0) return null;

        // Candidate order is preserved, so 10.0.100.5 wins a tie. Something
        // else on 8080 is usually one machine, not twenty, and each check is a
        // couple of seconds at worst, so cap it rather than let a weird network
        // stall the launch.
        foreach (string ip in open.Take(12))
        {
            if (LooksLikeCheesy(ip)) return ip + ":" + FieldPort;
        }
        if (open.Count > 0)
            Detail(open.Count + " machine(s) answered on 8080 but none of them is Cheesy Arena");
        return null;
    }

    /// Ten seconds to press D for the demo, then manual mode wins. Redirected
    /// or headless input (the /no-wait test path, a scheduled start) skips the
    /// question entirely rather than reading an EOF as an answer.
    private static bool OfferDemo()
    {
        try
        {
            if (Console.IsInputRedirected) return false;
            Console.WriteLine();
            WriteColor(ConsoleColor.White,
                "        Just trying this out, with no field to connect to?");
            WriteColor(ConsoleColor.White,
                "        Press D to run a practice match so every screen has something to show.");
            Detail("starting normally in 10 seconds...");
            DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
            while (DateTime.UtcNow < deadline)
            {
                if (Console.KeyAvailable)
                {
                    ConsoleKeyInfo k = Console.ReadKey(true);
                    return k.Key == ConsoleKey.D;
                }
                Thread.Sleep(120);
            }
        }
        catch { }
        return false;
    }

    private static async Task<bool> TcpOpen(string host, int port, int timeoutMs)
    {
        using (TcpClient client = new TcpClient())
        {
            try
            {
                Task connect = client.ConnectAsync(host, port);
                Task done = await Task.WhenAny(connect, Task.Delay(timeoutMs)).ConfigureAwait(false);
                if (done != connect) return false;
                await connect.ConfigureAwait(false);
                return client.Connected;
            }
            catch { return false; }
        }
    }

    private static bool LooksLikeCheesy(string ip)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                "http://" + ip + ":" + FieldPort + FieldProbePath);
            req.Method = "GET";
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            req.AllowAutoRedirect = false;
            req.UserAgent = "CalGames-ContentDesk-Launcher";
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                if (res.StatusCode != HttpStatusCode.OK) return false;
                using (StreamReader sr = new StreamReader(res.GetResponseStream()))
                {
                    char[] buf = new char[64];
                    int n = sr.Read(buf, 0, buf.Length);
                    string head = new string(buf, 0, Math.Max(0, n)).TrimStart();
                    // Cheesy answers this endpoint with a JSON array or object.
                    // Anything else on 8080 is somebody's dev server.
                    return head.StartsWith("[", StringComparison.Ordinal)
                        || head.StartsWith("{", StringComparison.Ordinal);
                }
            }
        }
        catch { return false; }
    }

    // ---- step 4: run -------------------------------------------------------

    private static int Step4Run(string installDir, string nodeExe, string fieldHost)
    {
        Step(4, "Starting the content desk");

        int port = _opt.Port;
        if (!PortFree(port))
        {
            int handled = ResolveBusyPort(port);
            if (handled >= 0) return handled;
        }

        string entry = Path.Combine(installDir, "apps", "core", "src", "index.ts");
        if (!File.Exists(entry))
            throw new Exception("The desk files are not where they should be. Missing: " + entry);

        StringBuilder args = new StringBuilder();
        args.Append("--experimental-strip-types ");
        args.Append("\"").Append(entry).Append("\" ");
        args.Append("--port ").Append(port);
        if (fieldHost != null) args.Append(" --cheesy --cheesy-host ").Append(fieldHost);
        if (_opt.Demo) args.Append(" --demo");
        if (_opt.Rehearsal) args.Append(" --rehearsal");
        // Layer 1 of tying the desk to this window: see TieToThisWindow below.
        args.Append(" --exit-with-parent");

        ProcessStartInfo psi = new ProcessStartInfo(nodeExe, args.ToString());
        psi.WorkingDirectory = installDir;
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        // Not for sending anything. This process holds the write end, so the
        // desk learns that this window is gone the moment the handle closes.
        psi.RedirectStandardInput = true;
        psi.CreateNoWindow = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        // The PIN travels in the environment, never on the command line: argv is
        // readable by every other process on the machine.
        psi.EnvironmentVariables["REMOTE_PIN"] = _opt.Pin;

        _desk = new Process();
        _desk.StartInfo = psi;
        _desk.EnableRaisingEvents = true;
        _desk.OutputDataReceived += (s, e) => { if (e.Data != null) Relay(e.Data); };
        _desk.ErrorDataReceived += (s, e) => { if (e.Data != null) Relay(e.Data); };

        _desk.Start();
        _desk.BeginOutputReadLine();
        _desk.BeginErrorReadLine();

        TieToThisWindow(_desk);
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; StopDesk(); };
        AppDomain.CurrentDomain.ProcessExit += (s, e) => StopDesk();

        if (!WaitForDesk(port, TimeSpan.FromSeconds(45)))
        {
            Console.WriteLine();
            if (_desk.HasExited)
                Fail("The desk stopped while starting up (exit code " + _desk.ExitCode + ").");
            else
                Fail("The desk did not answer within 45 seconds.");
            Detail("The lines above say why. The same text is in " + LogPath() + ".");
            StopDesk();
            Hold();
            return 1;
        }

        Ok("running");
        ReadyBanner(port, fieldHost, installDir);

        if (!_opt.NoBrowser)
        {
            try { Process.Start("http://localhost:" + port + "/"); } catch { }
        }

        _desk.WaitForExit();
        Console.WriteLine();
        Console.WriteLine("   The content desk has stopped.");
        Hold();
        return _desk.ExitCode;
    }

    // ---- tying the desk to this window -------------------------------------
    //
    // Closing this window with the X button used to leave node running headless,
    // still holding the port, so the next double-click died with "port already
    // in use" and nothing on screen said why. Three layers, because the failure
    // is silent and the fix has to survive even a hard kill of this process:
    //
    //   1. STDIN. The desk runs with --exit-with-parent and watches its standard
    //      input. This process holds the write end, so when it goes away for any
    //      reason the pipe closes, the desk reads EOF, and it shuts down the way
    //      Ctrl-C shuts it down: event log flushed, port released.
    //   2. A CONSOLE CONTROL HANDLER, because .NET's ProcessExit does not run
    //      when a console window is closed with the X button. Ctrl-C was always
    //      handled; the X button never was, and the X button is what people use.
    //   3. A JOB OBJECT marked kill-on-close. If this process is killed so hard
    //      that no handler of ours runs, Windows still tears the desk down with
    //      it. This is the layer that holds when the other two cannot.

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;
    private static IntPtr _job = IntPtr.Zero;
    private static ConsoleCtrlHandler _ctrlHandler;

    private delegate bool ConsoleCtrlHandler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static void TieToThisWindow(Process child)
    {
        // Layer 2. Keep the delegate in a field: hand a collectable one to
        // Windows and the handler stops working whenever the GC feels like it.
        _ctrlHandler = delegate(uint ctrlType)
        {
            // 0 Ctrl-C, 1 Ctrl-Break, 2 window closed, 5 logoff, 6 shutdown.
            // Windows allows a close handler about five seconds before it
            // terminates us regardless, which is why StopDesk is written to
            // finish well inside that.
            StopDesk();
            return true;
        };
        try { SetConsoleCtrlHandler(_ctrlHandler, true); } catch { }

        // Layer 3. Best effort: if any of this fails the first two still apply,
        // so a machine that refuses job objects is degraded, not broken.
        try
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return;

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr mem = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, mem, false);
                if (SetInformationJobObject(_job, JobObjectExtendedLimitInformation, mem, (uint)size))
                    AssignProcessToJobObject(_job, child.Handle);
            }
            finally { Marshal.FreeHGlobal(mem); }
        }
        catch { }
    }

    private static readonly object StopLock = new object();
    private static bool _stopping;

    private static void StopDesk()
    {
        // Ctrl-C reaches this twice (CancelKeyPress and the control handler),
        // and a failed startup calls it before ProcessExit does.
        lock (StopLock)
        {
            if (_stopping) return;
            _stopping = true;
        }
        try
        {
            if (_desk == null || _desk.HasExited) return;

            // The graceful path: closing the pipe is the desk's signal to flush
            // its event log and release the port itself. Two seconds is far more
            // than it needs and still inside what a console close allows.
            try { _desk.StandardInput.Close(); } catch { }
            if (_desk.WaitForExit(2000)) return;

            // Still there, so stop being polite. Node owns ffmpeg children when
            // recording, and killing only the parent leaves the most recent
            // segment unplayable, which is exactly the clip somebody wants after
            // a crash. Kill the tree.
            ProcessStartInfo kill = new ProcessStartInfo("taskkill",
                "/PID " + _desk.Id + " /T /F");
            kill.UseShellExecute = false;
            kill.CreateNoWindow = true;
            Process.Start(kill).WaitForExit(2000);
        }
        catch { }
    }

    /// The port is taken. Almost always that is a desk left over from an earlier
    /// double-click, which is the one case a volunteer cannot diagnose and can
    /// fix in one keystroke. Returns -1 to carry on starting, or the exit code.
    private static int ResolveBusyPort(int port)
    {
        bool ours = DeskAnswers(port);
        int pid = ListenerPid(port);

        Warn("port " + port + " is already busy on this machine");
        if (ours)
        {
            Detail("it answers as a content desk, so one is already running here" +
                (pid > 0 ? " (process " + pid + ")" : ""));
        }
        else
        {
            string who = ProcessNameFor(pid);
            Detail(who != null
                ? "held by " + who + " (process " + pid + "), which is not a content desk"
                : "held by something that is not a content desk");
            Detail("start on a different port instead:  START-DESK.cmd /port:" + (port + 1));
            Hold();
            return 1;
        }

        // Only ever offer to kill something that answered as our own desk.
        if (pid <= 0 || _opt.NoWait)
        {
            Detail("close the other window and try again, or:  START-DESK.cmd /port:" + (port + 1));
            Hold();
            return 1;
        }

        Console.WriteLine();
        Console.WriteLine("  [S] stop it and start fresh      [O] open the one already running      [Q] quit");
        while (true)
        {
            ConsoleKey key;
            try { key = Console.ReadKey(true).Key; }
            catch { Detail("no keyboard here; leaving the running desk alone"); Hold(); return 1; }

            if (key == ConsoleKey.Q) return 1;
            if (key == ConsoleKey.O)
            {
                try { Process.Start("http://localhost:" + port + "/"); } catch { }
                Ok("opened the desk that was already running");
                Hold();
                return 0;
            }
            if (key != ConsoleKey.S) continue;

            Detail("stopping process " + pid + "...");
            try
            {
                ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                Process.Start(kill).WaitForExit(8000);
            }
            catch { }

            // Killing the process is not the same as the port coming back: the
            // socket closes on its own schedule. Wait for the thing we actually
            // need rather than for the thing we just did.
            for (int i = 0; i < 20 && !PortFree(port); i++) Thread.Sleep(250);
            if (PortFree(port)) { Ok("port " + port + " is free again"); return -1; }

            Fail("Port " + port + " is still busy after stopping that process.");
            Detail("start on a different port instead:  START-DESK.cmd /port:" + (port + 1));
            Hold();
            return 1;
        }
    }

    /// PID listening on a TCP port, or 0. Parsed structurally rather than by
    /// looking for the word LISTENING, which is translated on a localized
    /// Windows: a listening row is the one whose foreign address is the
    /// wildcard. Failure is not fatal anywhere it is used.
    private static int ListenerPid(int port)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("netstat", "-ano -p TCP");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                string all = p.StandardOutput.ReadToEnd();
                p.WaitForExit(5000);
                foreach (string line in all.Split('\n'))
                {
                    string[] f = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (f.Length < 5) continue;
                    if (!f[1].EndsWith(":" + port, StringComparison.Ordinal)) continue;
                    if (f[2] != "0.0.0.0:0" && f[2] != "[::]:0" && f[2] != "*:*") continue;
                    int pid;
                    if (int.TryParse(f[f.Length - 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
                        return pid;
                }
            }
        }
        catch { }
        return 0;
    }

    private static string ProcessNameFor(int pid)
    {
        if (pid <= 0) return null;
        try { return Process.GetProcessById(pid).ProcessName; }
        catch { return null; }
    }

    /// Binds the way the desk binds. Testing loopback alone let a process
    /// already listening on 0.0.0.0 slip through, and the volunteer got a raw
    /// Node stack trace instead of the sentence explaining what to do.
    private static bool PortFree(int port)
    {
        try
        {
            TcpListener l = new TcpListener(IPAddress.Any, port);
            l.ExclusiveAddressUse = true;
            l.Start();
            l.Stop();
            return true;
        }
        catch { return false; }
    }

    /// An open socket is not proof the desk is up: anything at all could be
    /// holding that port. Ask for a page only the desk serves.
    private static bool WaitForDesk(int port, TimeSpan limit)
    {
        DateTime deadline = DateTime.UtcNow + limit;
        while (DateTime.UtcNow < deadline)
        {
            if (_desk != null && _desk.HasExited) return false;
            if (DeskAnswers(port)) return true;
            Thread.Sleep(400);
        }
        return false;
    }

    private static bool DeskAnswers(int port)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + port + "/api/state");
            req.Method = "GET";
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            req.AllowAutoRedirect = false;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                return res.StatusCode == HttpStatusCode.OK;
            }
        }
        catch { return false; }
    }

    // ---- console -----------------------------------------------------------

    private static void Banner()
    {
        Console.WriteLine();
        WriteColor(ConsoleColor.Yellow, "  CALGAMES 2026 CONTENT DESK");
        Console.WriteLine("  Setting up. This takes a minute the first time and seconds after that.");
        Console.WriteLine();
    }

    private static void ReadyBanner(int port, string fieldHost, string installDir)
    {
        string lan = LanAddress();
        Console.WriteLine();
        WriteColor(ConsoleColor.Yellow, _opt.Demo ? "  READY (practice mode)" : "  READY");
        Console.WriteLine();
        Console.WriteLine("  Open this on any pit monitor, laptop, or phone on this network:");
        WriteColor(ConsoleColor.Cyan, "      http://" + (lan ?? "localhost") + ":" + port + "/");
        Console.WriteLine();
        Console.WriteLine("  That page lists every screen. Pick one per monitor.");
        Console.WriteLine();
        Console.WriteLine("  Event PIN for the control screens: " + _opt.Pin);
        Console.WriteLine("  Audience screens need no PIN.");
        Console.WriteLine();
        if (_opt.Demo)
        {
            Console.WriteLine("  Mode:    practice, showing a pretend match on a loop");
            Console.WriteLine("           next time, START-DESK.cmd runs the real thing");
        }
        else
        {
            Console.WriteLine("  Field:   " + (fieldHost ?? "not connected, running in manual mode"));
        }
        Console.WriteLine("  Files:   " + installDir);
        Console.WriteLine();
        WriteColor(ConsoleColor.DarkGray, "  Leave this window open. Closing it stops the desk.");
        Console.WriteLine();
    }

    private static string LanAddress()
    {
        foreach (UnicastIPAddressInformation ip in LocalIPv4s())
        {
            if (!IPAddress.IsLoopback(ip.Address)) return ip.Address.ToString();
        }
        return null;
    }

    private static void Step(int n, string what)
    {
        Console.WriteLine();
        WriteColor(ConsoleColor.White, "  [" + n + "/4] " + what);
    }

    private static void Ok(string msg) { WriteColor(ConsoleColor.Green, "        " + msg); }
    private static void Detail(string msg) { WriteColor(ConsoleColor.DarkGray, "        " + msg); }
    private static void Warn(string msg) { WriteColor(ConsoleColor.Yellow, "        " + msg); }
    private static void Fail(string msg) { WriteColor(ConsoleColor.Red, "  " + msg); }

    private static void Relay(string line)
    {
        WriteColor(ConsoleColor.DarkGray, "  " + line);
        WriteLog(line);
    }

    /// The desk is chatty at 10Hz. Opening and closing the log for every line
    /// was enough to show up as stutter in the relayed output.
    private static void WriteLog(string line)
    {
        try
        {
            lock (ConsoleLock)
            {
                if (_log == null) _log = new StreamWriter(LogPath(), true) { AutoFlush = true };
                _log.WriteLine(line);
            }
        }
        catch { }
    }

    private static void WriteColor(ConsoleColor c, string s)
    {
        lock (ConsoleLock)
        {
            ConsoleColor was = Console.ForegroundColor;
            try { Console.ForegroundColor = c; Console.WriteLine(s); }
            finally { Console.ForegroundColor = was; }
        }
    }

    private static void Hold()
    {
        if (_opt != null && _opt.NoWait) return;
        Console.WriteLine("  Press any key to close this window.");
        try { Console.ReadKey(true); } catch { Thread.Sleep(20000); }
    }

    /// Next to the desk's own files once we know where those are, so the crew
    /// can find it without being told about %TEMP%.
    private static string LogPath()
    {
        if (_logDir != null)
        {
            try { return Path.Combine(_logDir, "desk-log.txt"); } catch { }
        }
        return Path.Combine(Path.GetTempPath(), "calgames-content-desk.log");
    }

    // ---- plumbing ----------------------------------------------------------

    private static Stream OpenResource(string name)
    {
        Assembly asm = Assembly.GetExecutingAssembly();
        foreach (string candidate in asm.GetManifestResourceNames())
        {
            if (candidate.EndsWith(name, StringComparison.OrdinalIgnoreCase))
                return asm.GetManifestResourceStream(candidate);
        }
        return null;
    }

    private static string DownloadsFolder()
    {
        // SpecialFolder has no Downloads member, and the user may have moved it.
        try
        {
            object v = Microsoft.Win32.Registry.GetValue(
                @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
                "{374DE290-123F-4565-9164-39C4925E467B}", null);
            string s = v as string;
            if (!string.IsNullOrEmpty(s) && Directory.Exists(s)) return s;
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    }

    private static void Download(string url, string dest)
    {
        using (WebClient wc = new WebClient())
        {
            int lastPct = -1;
            wc.DownloadProgressChanged += (s, e) =>
            {
                if (e.ProgressPercentage / 10 == lastPct / 10) return;
                lastPct = e.ProgressPercentage;
                Detail("  " + e.ProgressPercentage + "%");
            };
            var done = new ManualResetEventSlim(false);
            Exception error = null;
            wc.DownloadFileCompleted += (s, e) => { error = e.Error; done.Set(); };
            wc.DownloadFileAsync(new Uri(url), dest);
            if (!done.Wait(TimeSpan.FromMinutes(15)))
            {
                wc.CancelAsync();
                throw new Exception("The Node download took too long. Check the network and try again.");
            }
            if (error != null)
                throw new Exception("Could not download Node from nodejs.org: " + error.Message);
        }
    }

    private static string Sha256File(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream fs = File.OpenRead(path))
        {
            byte[] hash = sha.ComputeHash(fs);
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine();
        Console.WriteLine("  " + AppTitle);
        Console.WriteLine();
        Console.WriteLine("  Double-click to set up and start the desk. No options needed.");
        Console.WriteLine();
        Console.WriteLine("  For the content desk lead:");
        Console.WriteLine("    /pin:1234              set the event PIN (default " + DefaultPin + ")");
        Console.WriteLine("    /port:8720             serve on a different port");
        Console.WriteLine("    /dir:D:\\desk           install somewhere other than Downloads");
        Console.WriteLine("    /cheesy-host:ip:8080   skip the scan, use this field address");
        Console.WriteLine("    /no-cheesy             do not look for the field at all");
        Console.WriteLine("    /demo                  practice mode: a pretend match on a loop, no field needed");
        Console.WriteLine("    /rehearsal             practising by hand: keeps the practice out of the day's history");
        Console.WriteLine("    /no-browser            do not open a browser window");
        Console.WriteLine("    /no-wait               do not pause before closing the window");
        Console.WriteLine();
    }

    private sealed class Options
    {
        public string InstallDir;
        public string Pin = DefaultPin;
        public int Port = DefaultPort;
        public string CheesyHost;
        public bool NoCheesy;
        public bool Demo;
        /// A practice run the crew drives BY HAND on the event machine. The
        /// desk rebuilds the day from the day's log at boot, so an untagged
        /// rehearsal comes back as history: practice cards on the ledger,
        /// phantom matches in coverage, a practised award marked presented to
        /// a team that did not win it. /demo implies it.
        public bool Rehearsal;
        public bool NoBrowser;
        public bool NoWait;
        public bool ShowHelp;

        public static Options Parse(string[] args)
        {
            Options o = new Options();
            foreach (string raw in args)
            {
                string a = raw.Trim();
                string lower = a.ToLowerInvariant();
                // Accept both /flag and --flag: the crew will try both.
                if (lower.StartsWith("--", StringComparison.Ordinal)) { lower = "/" + lower.Substring(2); a = "/" + a.Substring(2); }

                if (lower == "/?" || lower == "/help" || lower == "-h") o.ShowHelp = true;
                else if (lower == "/no-cheesy") o.NoCheesy = true;
                else if (lower == "/demo") o.Demo = true;
                else if (lower == "/rehearsal" || lower == "/practice") o.Rehearsal = true;
                else if (lower == "/no-browser") o.NoBrowser = true;
                else if (lower == "/no-wait") o.NoWait = true;
                else if (lower.StartsWith("/pin:", StringComparison.Ordinal)) o.Pin = a.Substring(5);
                else if (lower.StartsWith("/dir:", StringComparison.Ordinal)) o.InstallDir = a.Substring(5);
                else if (lower.StartsWith("/cheesy-host:", StringComparison.Ordinal)) o.CheesyHost = a.Substring(13);
                else if (lower.StartsWith("/port:", StringComparison.Ordinal))
                {
                    int p;
                    if (int.TryParse(a.Substring(6), NumberStyles.Integer, CultureInfo.InvariantCulture, out p) &&
                        p > 0 && p < 65536) o.Port = p;
                }
            }
            if (string.IsNullOrEmpty(o.Pin)) o.Pin = DefaultPin;
            // A host without a port is the common typo, and the bridge needs both.
            if (o.CheesyHost != null && !o.CheesyHost.Contains(":")) o.CheesyHost += ":" + FieldPort;
            return o;
        }
    }
}
