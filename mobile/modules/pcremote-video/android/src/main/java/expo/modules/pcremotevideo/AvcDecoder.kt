package expo.modules.pcremotevideo

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Low-latency H.264 decoder: MediaCodec in async mode on its own thread,
 * output rendered straight to a Surface the moment it is ready.
 *
 * Input = Annex-B access units. The codec is (re)configured from the SPS/PPS
 * of a keyframe; until a keyframe arrives (start, gap, error) everything else
 * is dropped, because a P-frame without its reference decodes as garbage.
 * All codec state lives on [thread]; public methods only post to it.
 */
internal class AvcDecoder(private val emit: (Map<String, Any>) -> Unit) {
  private class Packet(val data: ByteArray, val ptsUs: Long, val key: Boolean)

  @Volatile var widthHint = 1280
  @Volatile var heightHint = 720

  private val thread = HandlerThread("pcremote-avc").also { it.start() }
  private val handler = Handler(thread.looper)
  private val posted = AtomicInteger(0)

  // ---- decoder-thread state ----
  private var surface: Surface? = null
  private var codec: MediaCodec? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private var configuredSps: ByteArray? = null
  private val freeInputs = ArrayDeque<Int>()
  private val pending = ArrayDeque<Packet>()
  private var waitKey = true
  private var rendered = 0
  private var firstSent = false
  private var statsAt = 0L
  private var released = false

  private val callback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
      if (c !== codec) return
      freeInputs.add(index)
      feed()
    }

    override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (c !== codec) return
      try {
        c.releaseOutputBuffer(index, true)
      } catch (e: Exception) {
        fail("render: ${e.message}")
        return
      }
      rendered += 1
      if (!firstSent) {
        firstSent = true
        emit(mapOf("type" to "first"))
      }
      val now = SystemClock.elapsedRealtime()
      if (statsAt == 0L) statsAt = now
      if (now - statsAt >= 1000) {
        emit(mapOf("type" to "stats", "fps" to (rendered * 1000.0 / (now - statsAt))))
        rendered = 0
        statsAt = now
      }
    }

    override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
      if (c !== codec) return
      fail("decoder: ${e.diagnosticInfo ?: e.message}")
    }

    override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
      if (c !== codec) return
      val w = if (format.containsKey(MediaFormat.KEY_WIDTH)) format.getInteger(MediaFormat.KEY_WIDTH) else 0
      val h = if (format.containsKey(MediaFormat.KEY_HEIGHT)) format.getInteger(MediaFormat.KEY_HEIGHT) else 0
      emit(mapOf("type" to "format", "width" to w, "height" to h))
    }
  }

  /** Any thread. Returns false when the packet was dropped (decoder backed up). */
  fun push(data: ByteArray, ptsUs: Long, key: Boolean): Boolean {
    if (posted.get() > MAX_POSTED && !key) {
      // Gap in the stream: everything until the next keyframe is useless.
      handler.post { waitKey = true }
      return false
    }
    posted.incrementAndGet()
    handler.post {
      posted.decrementAndGet()
      onPacket(Packet(data, ptsUs, key))
    }
    return true
  }

  /** Any thread; waits (bounded) so a dying Surface is never rendered into. */
  fun setSurface(s: Surface?) {
    val done = CountDownLatch(1)
    val ok = handler.post {
      releaseCodec()
      surface = s
      waitKey = true
      done.countDown()
    }
    if (ok) {
      try {
        done.await(500, TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
      }
    }
  }

  fun reset() {
    handler.post {
      releaseCodec()
      sps = null
      pps = null
      waitKey = true
    }
  }

  fun release() {
    handler.post {
      releaseCodec()
      surface = null
      released = true
      thread.quitSafely()
    }
  }

  // ---- decoder thread ----

  private fun onPacket(p: Packet) {
    if (released) return
    if (p.key) scanParamSets(p.data)
    val s = surface
    if (s == null) {
      waitKey = true
      return
    }
    if (waitKey && !p.key) return
    if (p.key) {
      val curSps = sps
      val curPps = pps
      if (curSps == null || curPps == null) return
      if (codec == null || !curSps.contentEquals(configuredSps)) {
        if (!configure(s, curSps, curPps)) return
      }
      waitKey = false
      // Older queued frames only add latency once a keyframe is here.
      pending.clear()
    }
    if (codec == null) return
    pending.add(p)
    if (pending.size > MAX_PENDING) {
      // The decoder cannot keep up: skip to the next keyframe.
      pending.clear()
      waitKey = true
      emit(mapOf("type" to "drop"))
      return
    }
    feed()
  }

  private fun feed() {
    val c = codec ?: return
    try {
      while (freeInputs.isNotEmpty() && pending.isNotEmpty()) {
        val index = freeInputs.poll() ?: break
        val p = pending.poll() ?: break
        val buf = c.getInputBuffer(index)
        if (buf == null || p.data.size > buf.capacity()) {
          // Give the slot back empty and resync on the next keyframe.
          c.queueInputBuffer(index, 0, 0, p.ptsUs, 0)
          pending.clear()
          waitKey = true
          break
        }
        buf.clear()
        buf.put(p.data)
        c.queueInputBuffer(index, 0, p.data.size, p.ptsUs, if (p.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
      }
    } catch (e: Exception) {
      fail("queue: ${e.message}")
    }
  }

  private fun configure(s: Surface, spsNal: ByteArray, ppsNal: ByteArray): Boolean {
    releaseCodec()
    val c = openCodec(s, spsNal, ppsNal, true) ?: openCodec(s, spsNal, ppsNal, false)
    if (c == null) {
      waitKey = true
      emit(mapOf("type" to "error", "message" to "configure failed"))
      return false
    }
    codec = c
    configuredSps = spsNal
    freeInputs.clear()
    firstSent = false
    rendered = 0
    statsAt = 0L
    try {
      c.start()
    } catch (e: Exception) {
      fail("start: ${e.message}")
      return false
    }
    emit(mapOf("type" to "configured", "decoder" to c.name))
    return true
  }

  /** A configured (not started) decoder, or null. lowLatency=false retries
   * without the vendor / low-latency keys some decoders reject. */
  private fun openCodec(s: Surface, spsNal: ByteArray, ppsNal: ByteArray, lowLatency: Boolean): MediaCodec? {
    var created: MediaCodec? = null
    return try {
      val c = MediaCodec.createDecoderByType(MIME)
      created = c
      // Async mode: the callback must be set before configure(); it runs on
      // this decoder thread.
      c.setCallback(callback, handler)
      c.configure(format(spsNal, ppsNal, c, lowLatency), s, null, 0)
      c
    } catch (e: Exception) {
      try {
        created?.release()
      } catch (_: Exception) {
      }
      null
    }
  }

  private fun format(spsNal: ByteArray, ppsNal: ByteArray, c: MediaCodec, lowLatency: Boolean): MediaFormat {
    val f = MediaFormat.createVideoFormat(MIME, widthHint.coerceIn(64, 4096), heightHint.coerceIn(64, 4096))
    f.setByteBuffer("csd-0", ByteBuffer.wrap(START + spsNal))
    f.setByteBuffer("csd-1", ByteBuffer.wrap(START + ppsNal))
    if (!lowLatency) return f
    f.setInteger(MediaFormat.KEY_PRIORITY, 0) // realtime
    if (Build.VERSION.SDK_INT >= 30) {
      val supported = try {
        c.codecInfo.getCapabilitiesForType(MIME)
          .isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_LowLatency)
      } catch (_: Exception) {
        false
      }
      if (supported) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
    }
    val name = c.name.lowercase()
    if (name.startsWith("c2.qti") || name.startsWith("omx.qcom")) {
      f.setInteger("vendor.qti-ext-dec-low-latency.enable", 1)
    } else if (name.contains("exynos")) {
      f.setInteger("vendor.rtc-ext-dec-low-latency.enable", 1)
    }
    return f
  }

  private fun fail(message: String) {
    releaseCodec()
    waitKey = true
    emit(mapOf("type" to "error", "message" to message))
  }

  private fun releaseCodec() {
    val c = codec
    codec = null
    configuredSps = null
    freeInputs.clear()
    pending.clear()
    if (c != null) {
      try {
        c.stop()
      } catch (_: Exception) {
      }
      try {
        c.release()
      } catch (_: Exception) {
      }
    }
  }

  /** Remember SPS/PPS from an Annex-B keyframe (they precede the slices). */
  private fun scanParamSets(d: ByteArray) {
    val n = d.size
    var i = 0
    var start = -1
    while (i + 3 <= n) {
      if (d[i].toInt() == 0 && d[i + 1].toInt() == 0 && d[i + 2].toInt() == 1) {
        if (start >= 0) takeNal(d, start, i)
        start = i + 3
        if (start < n) {
          val type = d[start].toInt() and 0x1f
          if (type in 1..5) return // first slice: no parameter sets after this
        }
        i += 3
      } else {
        i += 1
      }
    }
    if (start in 0 until n) takeNal(d, start, n)
  }

  private fun takeNal(d: ByteArray, start: Int, endExclusive: Int) {
    var end = endExclusive
    // A 4-byte start code leaves one zero at the end of the previous NAL.
    while (end > start && d[end - 1].toInt() == 0) end -= 1
    if (end <= start) return
    when (d[start].toInt() and 0x1f) {
      7 -> sps = d.copyOfRange(start, end)
      8 -> pps = d.copyOfRange(start, end)
    }
  }

  companion object {
    private const val MIME = "video/avc"
    private const val MAX_POSTED = 12
    private const val MAX_PENDING = 8
    private val START = byteArrayOf(0, 0, 0, 1)
  }
}
