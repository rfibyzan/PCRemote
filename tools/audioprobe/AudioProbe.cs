// AudioProbe: answers one question before PCRemote gets PC audio on the phone.
// "If the speakers are muted (IAudioEndpointVolume::SetMute), does loopback
//  capture still hear the sound?"
//
// Runs four 4-second recordings while something plays (YouTube, Spotify):
//   1. endpoint loopback, speakers ON
//   2. endpoint loopback, speakers MUTED
//   3. process loopback (everything except this probe), speakers MUTED
//   4. process loopback, speakers ON
// Prints the peak level of each and writes probe-*.wav to listen to.
// Never changes the default output device; restores the mute state it found.
//
// Build (C# 5, csc from .NET Framework 4.x that ships with Windows):
//   see build-and-run.ps1 next to this file.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace PCRemoteAudioProbe
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        void OpenPropertyStore(int access, out IntPtr store);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        void RegisterControlChangeNotify(IntPtr notify);
        void UnregisterControlChangeNotify(IntPtr notify);
        void GetChannelCount(out uint count);
        void SetMasterVolumeLevel(float level, ref Guid ctx);
        void SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        void GetMasterVolumeLevel(out float level);
        void GetMasterVolumeLevelScalar(out float level);
        void SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
        void SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
        void GetChannelVolumeLevel(uint ch, out float level);
        void GetChannelVolumeLevelScalar(uint ch, out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr sessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long def, out long min);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr handle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
    }

    // .NET callable wrappers aggregate the free-threaded marshaler, so this is
    // agile, which ActivateAudioInterfaceAsync requires.
    [ComVisible(true)]
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr = -1;
        public object Client;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                int hr;
                object iface;
                op.GetActivateResult(out hr, out iface);
                Hr = hr;
                Client = iface;
            }
            catch (Exception e)
            {
                Hr = Marshal.GetHRForException(e);
            }
            Done.Set();
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariantBlob
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public uint cbSize;
        [FieldOffset(16)] public IntPtr pBlobData;
    }

    class Fmt
    {
        public int Channels;
        public int Rate;
        public int Bits;
        public bool Float;
    }

    static class Program
    {
        const int CLSCTX_ALL = 23;
        const uint LOOPBACK = 0x00020000;
        const uint EVENTCALLBACK = 0x00040000;
        const uint AUTOCONVERTPCM = 0x80000000;
        const uint SRC_DEFAULT_QUALITY = 0x08000000;
        const uint BUFFERFLAGS_SILENT = 0x2;
        const int SECONDS = 4;

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid,
            ref PropVariantBlob activationParams, IActivateAudioInterfaceCompletionHandler handler,
            out IActivateAudioInterfaceAsyncOperation op);

        [DllImport("kernel32.dll")]
        static extern IntPtr CreateEvent(IntPtr attrs, bool manualReset, bool initial, string name);

        [DllImport("kernel32.dll")]
        static extern uint WaitForSingleObject(IntPtr handle, uint ms);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static Guid ctx = Guid.NewGuid();

        [MTAThread]
        static int Main(string[] args)
        {
            Console.WriteLine("PCRemote AudioProbe - putar musik/YouTube di PC sekarang, lalu tunggu ~20 detik.");
            Console.WriteLine("Windows " + Environment.OSVersion.Version);
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice dev;
            en.GetDefaultAudioEndpoint(0, 0, out dev);
            string id;
            dev.GetId(out id);
            Console.WriteLine("Output default: " + id);
            object volObj;
            Guid iidVol = IID_IAudioEndpointVolume;
            dev.Activate(ref iidVol, CLSCTX_ALL, IntPtr.Zero, out volObj);
            IAudioEndpointVolume vol = (IAudioEndpointVolume)volObj;
            bool wasMuted;
            vol.GetMute(out wasMuted);
            Console.WriteLine("Mute awal: " + (wasMuted ? "ya" : "tidak"));
            Console.WriteLine();

            try
            {
                Run("1-endpoint-nyala", vol, false, delegate { return EndpointClient(dev); });
                Run("2-endpoint-mute", vol, true, delegate { return EndpointClient(dev); });
                Run("3-process-mute", vol, true, delegate { return ProcessClient(); });
                Run("4-process-nyala", vol, false, delegate { return ProcessClient(); });
            }
            finally
            {
                vol.SetMute(wasMuted, ref ctx);
                Console.WriteLine();
                Console.WriteLine("Mute dikembalikan ke: " + (wasMuted ? "ya" : "tidak"));
            }
            Console.WriteLine();
            Console.WriteLine("Kirim semua baris di atas ke Hark. File probe-*.wav ada di folder ini untuk didengar.");
            return 0;
        }

        delegate Tuple<IAudioClient, Fmt, bool> ClientFactory();

        static void Run(string name, IAudioEndpointVolume vol, bool mute, ClientFactory make)
        {
            vol.SetMute(mute, ref ctx);
            Thread.Sleep(300);
            try
            {
                Tuple<IAudioClient, Fmt, bool> c = make();
                double peak;
                int silentPackets;
                int packets;
                string file = "probe-" + name + ".wav";
                Capture(c.Item1, c.Item2, c.Item3, file, out peak, out packets, out silentPackets);
                string db = peak > 0 ? (20 * Math.Log10(peak)).ToString("0.0") + " dBFS" : "-inf (diam)";
                Console.WriteLine(string.Format("{0,-18} peak {1,-14} paket {2} (diam {3})  -> {4}",
                    name, db, packets, silentPackets, peak > 0.001 ? "ADA SUARA" : "TIDAK ADA SUARA"));
            }
            catch (Exception e)
            {
                Console.WriteLine(string.Format("{0,-18} GAGAL: 0x{1:X8} {2}", name, Marshal.GetHRForException(e), e.Message));
            }
        }

        static Tuple<IAudioClient, Fmt, bool> EndpointClient(IMMDevice dev)
        {
            object o;
            Guid iid = IID_IAudioClient;
            dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            IAudioClient client = (IAudioClient)o;
            IntPtr wf;
            client.GetMixFormat(out wf);
            Fmt f = ReadFormat(wf);
            client.Initialize(0, LOOPBACK, 2000000, 0, wf, IntPtr.Zero);
            Marshal.FreeCoTaskMem(wf);
            return Tuple.Create(client, f, false);
        }

        static Tuple<IAudioClient, Fmt, bool> ProcessClient()
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS: type 1 = process loopback,
            // mode 1 = EXCLUDE this process tree (= everything else on the PC).
            IntPtr p = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(p, 0, 1);
            Marshal.WriteInt32(p, 4, Process.GetCurrentProcess().Id);
            Marshal.WriteInt32(p, 8, 1);
            PropVariantBlob pv = new PropVariantBlob();
            pv.vt = 65; // VT_BLOB
            pv.cbSize = 12;
            pv.pBlobData = p;
            ActivationHandler h = new ActivationHandler();
            IActivateAudioInterfaceAsyncOperation op;
            Guid iid = IID_IAudioClient;
            int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref pv, h, out op);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            if (!h.Done.WaitOne(5000)) throw new TimeoutException("aktivasi process loopback tidak selesai");
            Marshal.FreeHGlobal(p);
            if (h.Hr != 0) Marshal.ThrowExceptionForHR(h.Hr);
            IAudioClient client = (IAudioClient)h.Client;
            // Process loopback has no mix format: ask for 48 kHz stereo float.
            Fmt f = new Fmt();
            f.Channels = 2;
            f.Rate = 48000;
            f.Bits = 32;
            f.Float = true;
            IntPtr wf = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(wf, 0, 3); // WAVE_FORMAT_IEEE_FLOAT
            Marshal.WriteInt16(wf, 2, 2);
            Marshal.WriteInt32(wf, 4, 48000);
            Marshal.WriteInt32(wf, 8, 48000 * 8);
            Marshal.WriteInt16(wf, 12, 8);
            Marshal.WriteInt16(wf, 14, 32);
            Marshal.WriteInt16(wf, 16, 0);
            client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 2000000, 0, wf, IntPtr.Zero);
            Marshal.FreeHGlobal(wf);
            return Tuple.Create(client, f, true);
        }

        static Fmt ReadFormat(IntPtr wf)
        {
            Fmt f = new Fmt();
            int tag = (ushort)Marshal.ReadInt16(wf, 0);
            f.Channels = Marshal.ReadInt16(wf, 2);
            f.Rate = Marshal.ReadInt32(wf, 4);
            f.Bits = Marshal.ReadInt16(wf, 14);
            if (tag == 3) f.Float = true;
            else if (tag == 0xFFFE) f.Float = Marshal.ReadInt32(wf, 24) == 3; // SubFormat.Data1
            return f;
        }

        static void Capture(IAudioClient client, Fmt f, bool useEvent, string file,
            out double peak, out int packets, out int silentPackets)
        {
            IntPtr ev = IntPtr.Zero;
            if (useEvent)
            {
                ev = CreateEvent(IntPtr.Zero, false, false, null);
                client.SetEventHandle(ev);
            }
            object o;
            Guid iid = IID_IAudioCaptureClient;
            client.GetService(ref iid, out o);
            IAudioCaptureClient cap = (IAudioCaptureClient)o;
            int frameBytes = f.Channels * f.Bits / 8;
            MemoryStream pcm = new MemoryStream();
            peak = 0;
            packets = 0;
            silentPackets = 0;
            client.Start();
            Stopwatch sw = Stopwatch.StartNew();
            try
            {
                while (sw.ElapsedMilliseconds < SECONDS * 1000)
                {
                    if (useEvent) WaitForSingleObject(ev, 100);
                    else Thread.Sleep(10);
                    uint next;
                    while (cap.GetNextPacketSize(out next) == 0 && next > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong a, b;
                        if (cap.GetBuffer(out data, out frames, out flags, out a, out b) != 0) break;
                        packets++;
                        int bytes = (int)frames * frameBytes;
                        byte[] buf = new byte[bytes];
                        if ((flags & BUFFERFLAGS_SILENT) != 0) silentPackets++;
                        else Marshal.Copy(data, buf, 0, bytes);
                        cap.ReleaseBuffer(frames);
                        pcm.Write(buf, 0, bytes);
                        double p = Peak(buf, f);
                        if (p > peak) peak = p;
                    }
                }
            }
            finally
            {
                client.Stop();
                if (ev != IntPtr.Zero) CloseHandle(ev);
            }
            WriteWav(file, pcm.ToArray(), f);
        }

        static double Peak(byte[] buf, Fmt f)
        {
            double peak = 0;
            if (f.Float && f.Bits == 32)
            {
                for (int i = 0; i + 4 <= buf.Length; i += 4)
                {
                    double v = Math.Abs(BitConverter.ToSingle(buf, i));
                    if (v > peak) peak = v;
                }
            }
            else if (f.Bits == 16)
            {
                for (int i = 0; i + 2 <= buf.Length; i += 2)
                {
                    double v = Math.Abs(BitConverter.ToInt16(buf, i) / 32768.0);
                    if (v > peak) peak = v;
                }
            }
            else if (f.Bits == 32)
            {
                for (int i = 0; i + 4 <= buf.Length; i += 4)
                {
                    double v = Math.Abs(BitConverter.ToInt32(buf, i) / 2147483648.0);
                    if (v > peak) peak = v;
                }
            }
            return peak;
        }

        static void WriteWav(string file, byte[] pcm, Fmt f)
        {
            using (BinaryWriter w = new BinaryWriter(File.Create(file)))
            {
                int blockAlign = f.Channels * f.Bits / 8;
                w.Write(new char[] { 'R', 'I', 'F', 'F' });
                w.Write(36 + pcm.Length);
                w.Write(new char[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
                w.Write(16);
                w.Write((short)(f.Float ? 3 : 1));
                w.Write((short)f.Channels);
                w.Write(f.Rate);
                w.Write(f.Rate * blockAlign);
                w.Write((short)blockAlign);
                w.Write((short)f.Bits);
                w.Write(new char[] { 'd', 'a', 't', 'a' });
                w.Write(pcm.Length);
                w.Write(pcm);
            }
        }
    }
}
