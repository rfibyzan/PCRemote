// NetstatTest.cs: checks Netstat.TryParseListeningPid. Console program, run
// by launcher\build.bat and CI before PCRemote.exe is built:
//   csc /nologo /noconfig /target:exe /r:System.dll /out:NetstatTest.exe NetstatTest.cs Netstat.cs
// Exit code 0 = all cases pass.

using System;

namespace PCRemote
{
    internal static class NetstatTest
    {
        private static int failures;

        private static void Expect(string line, bool ok, int pid, int port)
        {
            int gotPid, gotPort;
            bool got = Netstat.TryParseListeningPid(line, out gotPid, out gotPort);
            bool pass = got == ok && (!ok || (gotPid == pid && gotPort == port));
            if (!pass)
            {
                failures++;
                Console.WriteLine("FAIL: [" + line + "] -> " + got + " pid=" + gotPid + " port=" + gotPort);
            }
        }

        private static int Main()
        {
            // The agent listening (IPv4 and IPv6, any slot in the range).
            Expect("  TCP    0.0.0.0:18765          0.0.0.0:0              LISTENING       4321", true, 4321, 18765);
            Expect("  TCP    [::]:18766             [::]:0                 LISTENING       4321", true, 4321, 18766);
            Expect("  TCP    127.0.0.1:18774        0.0.0.0:0              LISTENING       77", true, 77, 18774);
            Expect("\tTCP\t0.0.0.0:18765\t0.0.0.0:0\tLISTENING\t4321", true, 4321, 18765);
            // German Windows translates the state; wildcard foreign address still marks it.
            Expect("  TCP    0.0.0.0:18765          0.0.0.0:0              ABH\u00D6REN         4321", true, 4321, 18765);

            // THE BUG: a browser tab on http://127.0.0.1:18765 (remote port 18765).
            Expect("  TCP    127.0.0.1:52344        127.0.0.1:18765        ESTABLISHED     9876", false, 0, 0);
            Expect("  TCP    [::1]:52345            [::1]:18765            ESTABLISHED     9876", false, 0, 0);
            Expect("  TCP    127.0.0.1:52346        127.0.0.1:18765        TIME_WAIT       0", false, 0, 0);
            // The agent's own side of that connection is not a listener either.
            Expect("  TCP    127.0.0.1:18765        127.0.0.1:52344        ESTABLISHED     4321", false, 0, 0);
            Expect("  TCP    127.0.0.1:18765        127.0.0.1:52344        HERGESTELLT     4321", false, 0, 0);
            Expect("  TCP    127.0.0.1:18765        127.0.0.1:52344        CLOSE_WAIT      4321", false, 0, 0);

            // Outside the range, UDP, headers, junk.
            Expect("  TCP    0.0.0.0:18764          0.0.0.0:0              LISTENING       5", false, 0, 0);
            Expect("  TCP    0.0.0.0:18775          0.0.0.0:0              LISTENING       5", false, 0, 0);
            Expect("  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       5", false, 0, 0);
            Expect("  UDP    0.0.0.0:18765          *:*                                    5", false, 0, 0);
            Expect("  Proto  Local Address          Foreign Address        State           PID", false, 0, 0);
            Expect("Active Connections", false, 0, 0);
            Expect("", false, 0, 0);
            Expect(null, false, 0, 0);
            Expect("  TCP    0.0.0.0:18765          0.0.0.0:0              LISTENING       0", false, 0, 0);
            Expect("  TCP    0.0.0.0:18765          0.0.0.0:0              LISTENING       abc", false, 0, 0);

            if (Netstat.FirstPort != 18765 || Netstat.PortCount != 10) { failures++; Console.WriteLine("FAIL: port range"); }

            Console.WriteLine(failures == 0 ? "NetstatTest: ok" : ("NetstatTest: " + failures + " failure(s)"));
            return failures == 0 ? 0 : 1;
        }
    }
}
