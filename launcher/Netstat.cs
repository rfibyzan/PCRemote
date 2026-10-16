// Netstat.cs: the pure part of PCRemote.exe's "replace the old PC Remote"
// step, kept free of Windows calls so NetstatTest.cs can check it in CI.
//
// The old launcher killed (taskkill /T /F) every PID that netstat showed next
// to an agent port. A browser tab on http://127.0.0.1:18765 owns an
// ESTABLISHED row whose *remote* port is 18765, so restarting PC Remote
// closed the browser. Here only rows that LISTEN on a local agent port count.
//
// C# 5 (in-box .NET Framework 4 csc.exe).

using System;

namespace PCRemote
{
    internal static class Netstat
    {
        // Same as DEFAULT_PORT / PORT_RANGE in runtime/agent/src/lock.js.
        public const int FirstPort = 18765;
        public const int PortCount = 10;

        private static readonly string[] OtherStates = new string[]
        {
            "ESTABLISHED", "TIME_WAIT", "CLOSE_WAIT", "SYN_SENT", "SYN_RECEIVED", "SYN_RCVD",
            "FIN_WAIT_1", "FIN_WAIT_2", "LAST_ACK", "CLOSING", "CLOSED", "BOUND", "DELETE_TCB"
        };

        public static bool InAgentRange(int port)
        {
            return port >= FirstPort && port < FirstPort + PortCount;
        }

        /// One line of `netstat -ano`. True only for a TCP socket that is
        /// LISTENING on a local port in the agent range; pid/port are its
        /// owner and local port. ESTABLISHED/TIME_WAIT/... rows (clients such
        /// as a browser tab on the dashboard), UDP rows and anything outside
        /// the range give false.
        ///
        /// "LISTENING" is translated on some Windows languages, so a row is
        /// treated as listening when its foreign address is the wildcard
        /// (0.0.0.0:0, [::]:0, *:*), which only listening sockets have, and
        /// its state is not one of the English non-listening states.
        public static bool TryParseListeningPid(string line, out int pid, out int port)
        {
            pid = 0;
            port = 0;
            if (line == null) return false;
            string[] t = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            // TCP  <local>  <foreign>  <state...>  <pid>
            if (t.Length < 5) return false;
            if (!t[0].StartsWith("TCP", StringComparison.OrdinalIgnoreCase)) return false;

            int localPort;
            if (!TrySplitEndpoint(t[1], out localPort)) return false;
            if (!InAgentRange(localPort)) return false;
            if (!IsWildcardEndpoint(t[2])) return false;

            for (int i = 3; i < t.Length - 1; i++)
            {
                foreach (string s in OtherStates)
                {
                    if (string.Equals(t[i], s, StringComparison.OrdinalIgnoreCase)) return false;
                }
            }

            int owner;
            if (!int.TryParse(t[t.Length - 1], out owner) || owner <= 0) return false;
            pid = owner;
            port = localPort;
            return true;
        }

        private static bool TrySplitEndpoint(string endpoint, out int port)
        {
            port = 0;
            int colon = endpoint.LastIndexOf(':');
            if (colon < 0 || colon == endpoint.Length - 1) return false;
            return int.TryParse(endpoint.Substring(colon + 1), out port);
        }

        private static bool IsWildcardEndpoint(string endpoint)
        {
            if (endpoint == "*:*") return true;
            int colon = endpoint.LastIndexOf(':');
            if (colon <= 0) return false;
            string host = endpoint.Substring(0, colon);
            string p = endpoint.Substring(colon + 1);
            if (p != "0" && p != "*") return false;
            return host == "0.0.0.0" || host == "[::]" || host == "[::0]" || host == "*";
        }
    }
}
