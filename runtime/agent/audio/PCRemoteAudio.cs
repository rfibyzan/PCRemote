// PCRemoteAudio.exe: PC sound -> stdout for the PC Remote agent (audio.js).
//
// WASAPI loopback of the DEFAULT output device, written to stdout as raw
// 16-bit little-endian stereo PCM at the device's mix rate. The agent pipes it
// into ffmpeg (Opus) and sends the packets to phones that turned "Suara" on.
//
//   stderr "fmt <rate>"   once, before any PCM (the agent starts ffmpeg then)
//   exit 0                stdout closed (agent stopped us)
//   exit 3                default device changed / invalidated: start again
//   exit 2                no output device / WASAPI error
//
// Loopback on many drivers is taken AFTER the Windows master volume (tested
// 17 Oct 2026 on the user's PC: 32 % volume = quieter capture, mute = digital
// silence). So we undo the master volume (gain = 1 / volume, at most +18 dB)
// with a soft limiter, and the phone hears a steady level. "--nogain" skips it.
// Never touches the default device, its volume, or its mute.
//
// Kept to C# 5 so the csc.exe that ships with .NET Framework 4.x compiles it
// on the user's PC (audio.js does that on first use, like PCRemoteStart.cs).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace PCRemoteAudio
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
        void GetMasterVolumeLevel(out float levelDb);
        void GetMasterVolumeLevelScalar(out float level);
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

    static class Program
    {
        const int CLSCTX_ALL = 23;
        const uint LOOPBACK = 0x00020000;
        const uint BUFFERFLAGS_SILENT = 0x2;
        const double MAX_GAIN = 8.0; // +18 dB
        static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");

        [MTAThread]
        static int Main(string[] args)
        {
            bool useGain = Array.IndexOf(args, "--nogain") < 0;
            Stream stdout = Console.OpenStandardOutput();
            try
            {
                return Run(stdout, useGain);
            }
            catch (IOException)
            {
                return 0; // agent closed the pipe
            }
            catch (COMException e)
            {
                Console.Error.WriteLine("err wasapi 0x" + e.ErrorCode.ToString("X8"));
                // AUDCLNT_E_DEVICE_INVALIDATED / not found: device went away.
                return (uint)e.ErrorCode == 0x88890004 || (uint)e.ErrorCode == 0x80070490 ? 3 : 2;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("err " + e.Message);
                return 2;
            }
        }

        static string DefaultId(IMMDeviceEnumerator en)
        {
            IMMDevice d;
            en.GetDefaultAudioEndpoint(0, 0, out d);
            string id;
            d.GetId(out id);
            return id;
        }

        static int Run(Stream stdout, bool useGain)
        {
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice dev;
            en.GetDefaultAudioEndpoint(0, 0, out dev);
            string devId;
            dev.GetId(out devId);

            object o;
            Guid iid = IID_IAudioClient;
            dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o);
            IAudioClient client = (IAudioClient)o;
            Guid iidVol = IID_IAudioEndpointVolume;
            dev.Activate(ref iidVol, CLSCTX_ALL, IntPtr.Zero, out o);
            IAudioEndpointVolume vol = (IAudioEndpointVolume)o;

            IntPtr wf;
            client.GetMixFormat(out wf);
            int tag = (ushort)Marshal.ReadInt16(wf, 0);
            int channels = Marshal.ReadInt16(wf, 2);
            int rate = Marshal.ReadInt32(wf, 4);
            int bits = Marshal.ReadInt16(wf, 14);
            bool isFloat = tag == 3 || (tag == 0xFFFE && Marshal.ReadInt32(wf, 24) == 3);
            client.Initialize(0, LOOPBACK, 1000000, 0, wf, IntPtr.Zero); // 100 ms buffer
            Marshal.FreeCoTaskMem(wf);
            Guid iidCap = IID_IAudioCaptureClient;
            client.GetService(ref iidCap, out o);
            IAudioCaptureClient cap = (IAudioCaptureClient)o;

            Console.Error.WriteLine("fmt " + rate);
            Console.Error.Flush();

            int frameBytes = channels * bits / 8;
            byte[] src = new byte[0];
            byte[] dst = new byte[0];
            double gain = 1.0;
            DateTime nextCheck = DateTime.MinValue;
            client.Start();
            try
            {
                while (true)
                {
                    if (DateTime.UtcNow >= nextCheck)
                    {
                        nextCheck = DateTime.UtcNow.AddMilliseconds(500);
                        if (DefaultId(en) != devId) return 3; // headphones plugged, etc.
                        if (useGain)
                        {
                            float db;
                            vol.GetMasterVolumeLevel(out db);
                            gain = Math.Min(MAX_GAIN, Math.Pow(10, -db / 20.0));
                            if (gain < 1) gain = 1;
                        }
                    }
                    Thread.Sleep(10);
                    uint next;
                    int hr;
                    while ((hr = cap.GetNextPacketSize(out next)) == 0 && next > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong a, b;
                        hr = cap.GetBuffer(out data, out frames, out flags, out a, out b);
                        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                        int n = (int)frames;
                        int srcBytes = n * frameBytes;
                        if (src.Length < srcBytes) src = new byte[srcBytes];
                        bool silent = (flags & BUFFERFLAGS_SILENT) != 0;
                        if (!silent) Marshal.Copy(data, src, 0, srcBytes);
                        cap.ReleaseBuffer(frames);
                        int outBytes = n * 4;
                        if (dst.Length < outBytes) dst = new byte[outBytes];
                        if (silent) Array.Clear(dst, 0, outBytes);
                        else Convert(src, n, channels, bits, isFloat, gain, dst);
                        stdout.Write(dst, 0, outBytes);
                    }
                    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                    stdout.Flush();
                }
            }
            finally
            {
                try { client.Stop(); } catch { }
            }
        }

        /// Any mix format -> stereo s16le with gain + soft limit. Channels past
        /// two are dropped (front L/R are channels 0/1 in every WASAPI layout);
        /// mono is duplicated.
        static void Convert(byte[] src, int frames, int channels, int bits, bool isFloat, double gain, byte[] dst)
        {
            int bps = bits / 8;
            int o = 0;
            for (int f = 0; f < frames; f++)
            {
                int baseOff = f * channels * bps;
                double l = Sample(src, baseOff, bps, isFloat);
                double r = channels > 1 ? Sample(src, baseOff + bps, bps, isFloat) : l;
                WriteS16(dst, o, Limit(l * gain));
                WriteS16(dst, o + 2, Limit(r * gain));
                o += 4;
            }
        }

        static double Sample(byte[] b, int off, int bps, bool isFloat)
        {
            if (isFloat && bps == 4) return BitConverter.ToSingle(b, off);
            if (bps == 2) return BitConverter.ToInt16(b, off) / 32768.0;
            if (bps == 3) return ((b[off] << 8 | b[off + 1] << 16 | b[off + 2] << 24) >> 8) / 8388608.0;
            if (bps == 4) return BitConverter.ToInt32(b, off) / 2147483648.0;
            return 0;
        }

        /// Linear below 0.8, then a smooth knee that never passes 1.0.
        static double Limit(double x)
        {
            double a = Math.Abs(x);
            if (a <= 0.8) return x;
            double y = 0.8 + 0.2 * Math.Tanh((a - 0.8) / 0.2);
            return x < 0 ? -y : y;
        }

        static void WriteS16(byte[] d, int off, double v)
        {
            int s = (int)Math.Round(v * 32767.0);
            if (s > 32767) s = 32767;
            if (s < -32768) s = -32768;
            d[off] = (byte)(s & 0xFF);
            d[off + 1] = (byte)((s >> 8) & 0xFF);
        }
    }
}
