package expo.modules.pcremotevideo

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * PC sound: Opus packets (20 ms, 48 kHz stereo, "PA" frames from the agent's
 * audio.js) -> MediaCodec "audio/opus" -> AudioTrack, on one thread.
 *
 * Latency stays bounded: AudioTrack's blocking write paces playback, and when
 * the network delivers a burst the queue is trimmed to the newest packets
 * instead of letting the delay grow.
 */
internal object OpusPlayer {
  private const val TAG = "PcremoteOpus"
  private const val RATE = 48000
  private const val CHANNELS = 2
  private const val PRE_SKIP = 312 // samples, libopus default at 48 kHz
  private const val MAX_QUEUE = 12 // 240 ms waiting -> trim
  private const val KEEP = 3 // ...down to 60 ms

  private val queue = LinkedBlockingDeque<ByteArray>()
  @Volatile private var running = false
  @Volatile private var gen = 0
  private var thread: Thread? = null

  val supported: Boolean by lazy {
    try {
      MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
        !info.isEncoder && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_AUDIO_OPUS, ignoreCase = true) }
      }
    } catch (t: Throwable) {
      false
    }
  }

  @Synchronized
  fun start(): Boolean {
    if (!supported) return false
    if (running) return true
    running = true
    queue.clear()
    val my = ++gen
    thread = Thread({ loop(my) }, "pcremote-opus").also {
      it.priority = Thread.MAX_PRIORITY
      it.start()
    }
    return true
  }

  fun push(bytes: ByteArray): Boolean {
    if (!running) return false
    if (queue.size >= MAX_QUEUE) {
      while (queue.size > KEEP) queue.pollFirst()
    }
    queue.offerLast(bytes)
    return true
  }

  @Synchronized
  fun stop() {
    running = false
    gen++
    thread?.interrupt()
    thread = null
    queue.clear()
  }

  val isRunning: Boolean
    get() = running

  private fun opusHead(): ByteArray {
    val b = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
    b.put("OpusHead".toByteArray(Charsets.US_ASCII))
    b.put(1.toByte()) // version
    b.put(CHANNELS.toByte())
    b.putShort(PRE_SKIP.toShort())
    b.putInt(RATE)
    b.putShort(0.toShort()) // output gain
    b.put(0.toByte()) // mapping family 0 (mono/stereo)
    return b.array()
  }

  private fun nanos(ns: Long): ByteBuffer {
    val b = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder())
    b.putLong(ns)
    b.flip()
    return b
  }

  private fun makeTrack(): AudioTrack {
    val minBuf = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT)
    val size = maxOf(minBuf * 2, RATE * 4 / 10) // >= 100 ms
    val builder = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(RATE)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
          .build(),
      )
      .setBufferSizeInBytes(size)
      .setTransferMode(AudioTrack.MODE_STREAM)
    if (Build.VERSION.SDK_INT >= 26) builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
    return builder.build()
  }

  private fun alive(my: Int) = running && gen == my

  private fun loop(my: Int) {
    var codec: MediaCodec? = null
    var track: AudioTrack? = null
    try {
      val fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, RATE, CHANNELS)
      fmt.setByteBuffer("csd-0", ByteBuffer.wrap(opusHead()))
      fmt.setByteBuffer("csd-1", nanos(PRE_SKIP * 1_000_000_000L / RATE))
      fmt.setByteBuffer("csd-2", nanos(80_000_000L))
      codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
      codec.configure(fmt, null, null, 0)
      codec.start()
      track = makeTrack()
      track.play()
      val info = MediaCodec.BufferInfo()
      var pcm = ByteArray(RATE / 50 * 4)
      var ptsUs = 0L
      while (alive(my)) {
        val pkt = queue.pollFirst(50, TimeUnit.MILLISECONDS)
        if (pkt != null) {
          val inIdx = codec.dequeueInputBuffer(20_000)
          if (inIdx >= 0) {
            val buf = codec.getInputBuffer(inIdx)
            if (buf != null) {
              buf.clear()
              buf.put(pkt)
              codec.queueInputBuffer(inIdx, 0, pkt.size, ptsUs, 0)
              ptsUs += 20_000
            }
          }
        }
        while (alive(my)) {
          val outIdx = codec.dequeueOutputBuffer(info, 0)
          if (outIdx >= 0) {
            val out = codec.getOutputBuffer(outIdx)
            if (out != null && info.size > 0) {
              if (pcm.size < info.size) pcm = ByteArray(info.size)
              out.position(info.offset)
              out.get(pcm, 0, info.size)
              track.write(pcm, 0, info.size)
            }
            codec.releaseOutputBuffer(outIdx, false)
          } else if (outIdx != MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            break
          }
        }
      }
    } catch (e: InterruptedException) {
      // stop()
    } catch (t: Throwable) {
      Log.w(TAG, "opus playback stopped", t)
    } finally {
      try { track?.stop() } catch (_: Throwable) {}
      try { track?.release() } catch (_: Throwable) {}
      try { codec?.stop() } catch (_: Throwable) {}
      try { codec?.release() } catch (_: Throwable) {}
      // A crash ends this session only; a newer start() keeps running.
      if (gen == my) running = false
    }
  }
}
