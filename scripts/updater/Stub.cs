// AgentDeskUpdater.exe: unpacks the new version and update.ps1 (both embedded
// by build-updater.ps1) into a temporary folder and runs the script in this
// console window. Built with the C# compiler that ships with Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

static class Updater
{
    static int Main(string[] args)
    {
        string work = Path.Combine(Path.GetTempPath(), "AgentDeskUpdate-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            Directory.CreateDirectory(work);
            string script = Path.Combine(work, "update.ps1");
            string zip = Path.Combine(work, "payload.zip");
            string payload = Path.Combine(work, "payload");
            Extract("update.ps1", script);
            Extract("payload.zip", zip);
            ZipFile.ExtractToDirectory(zip, payload);

            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string extra = string.Join(" ", Array.ConvertAll(args, a => "\"" + a + "\""));
            var start = new ProcessStartInfo(powershell,
                "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Payload \"" + payload + "\" " + extra);
            start.UseShellExecute = false;
            using (var process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.WriteLine("アップデーターを起動できませんでした: " + error.Message);
            Console.WriteLine("Enter キーで閉じます");
            Console.ReadLine();
            return 1;
        }
        finally
        {
            try { Directory.Delete(work, true); } catch { }
        }
    }

    static void Extract(string name, string file)
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (FileStream target = File.Create(file))
        {
            source.CopyTo(target);
        }
    }
}
