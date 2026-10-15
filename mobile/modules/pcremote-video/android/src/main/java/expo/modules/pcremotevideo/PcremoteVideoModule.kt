package expo.modules.pcremotevideo

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

/**
 * H.264 (Annex-B access units) -> MediaCodec -> TextureView.
 * JS: requireOptionalNativeModule("PcremoteVideo") + requireNativeView("PcremoteVideo").
 */
class PcremoteVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PcremoteVideo")

    Function("isSupported") {
      true
    }

    // Synchronous on the JS thread: the bytes are copied out of the JS buffer
    // right here (the typed array is only valid during this call); decoding
    // runs on the view's own decoder thread. Returns false when dropped.
    Function("push") { streamId: Int, data: Uint8Array, ptsUs: Double, key: Boolean ->
      val view = PcremoteVideoView.find(streamId)
      if (view == null) {
        false
      } else {
        val size = data.byteLength
        val bytes = ByteArray(size)
        data.read(bytes, 0, size)
        view.decoder.push(bytes, ptsUs.toLong(), key)
      }
    }

    // Drop the decoder state (new stream / monitor / video off).
    Function("reset") { streamId: Int ->
      val view = PcremoteVideoView.find(streamId)
      view?.decoder?.reset()
      view != null
    }

    View(PcremoteVideoView::class) {
      Events("onVideoEvent")

      Prop("streamId") { view: PcremoteVideoView, id: Int ->
        view.setStreamId(id)
      }

      // Size hint for MediaCodec.configure (the real size comes from the SPS).
      Prop("codecWidth") { view: PcremoteVideoView, w: Int ->
        view.decoder.widthHint = w
      }

      Prop("codecHeight") { view: PcremoteVideoView, h: Int ->
        view.decoder.heightHint = h
      }

      OnViewDestroys { view: PcremoteVideoView ->
        view.release()
      }
    }
  }
}
