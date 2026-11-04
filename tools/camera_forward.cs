// Forwards the camera's RTSP port over Tailscale so the EC2 server can reach it.
// Runs: tailscale serve --bg --tcp 554 tcp://192.168.8.100:554
// Optional arguments: camera_forward.exe [camera-ip:port] [tailscale-port]
using System;
using System.Diagnostics;
using System.IO;

class CameraForward
{
    static int Main(string[] args)
    {
        string target = args.Length > 0 ? args[0] : "192.168.8.100:554";
        string port = args.Length > 1 ? args[1] : "554";
        string exe = @"C:\Program Files\Tailscale\tailscale.exe";

        if (!File.Exists(exe))
        {
            Console.WriteLine("Tailscale not found at " + exe);
            return Pause(1);
        }

        var psi = new ProcessStartInfo(exe, "serve --bg --tcp " + port + " tcp://" + target)
        {
            UseShellExecute = false,
        };
        Console.WriteLine("> tailscale " + psi.Arguments);
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            if (p.ExitCode == 0)
                Console.WriteLine("Forwarding tailnet port " + port + " -> " + target);
            else
                Console.WriteLine("tailscale exited with code " + p.ExitCode);
            return Pause(p.ExitCode);
        }
    }

    static int Pause(int code)
    {
        Console.WriteLine("Press Enter to close...");
        Console.ReadLine();
        return code;
    }
}
