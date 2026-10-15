package expo.modules.pcremotevideo

import android.content.Context
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

/**
 * TextureView (not SurfaceView) so the React Native transform on a parent
 * (the viewer's camera scale/translate) applies to the video like any view.
 */
class PcremoteVideoView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), TextureView.SurfaceTextureListener {

  private val onVideoEvent by EventDispatcher()
  private var streamId = 0
  private var surface: Surface? = null

  internal val decoder = AvcDecoder { event ->
    // Decoder thread -> UI thread before talking to React.
    post { onVideoEvent(event) }
  }

  private val textureView = TextureView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    isOpaque = false // transparent until the first decoded frame
  }

  init {
    textureView.surfaceTextureListener = this
    addView(textureView)
  }

  fun setStreamId(id: Int) {
    if (streamId != 0) views.remove(streamId)
    streamId = id
    if (id != 0) views[id] = WeakReference(this)
  }

  fun release() {
    if (streamId != 0) {
      val cur = views[streamId]?.get()
      if (cur === this) views.remove(streamId)
    }
    decoder.setSurface(null)
    decoder.release()
    surface?.release()
    surface = null
  }

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
    val s = Surface(st)
    surface = s
    decoder.setSurface(s)
  }

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {}

  override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
    // Blocks (bounded) until the codec stopped rendering into this surface.
    decoder.setSurface(null)
    surface?.release()
    surface = null
    return true
  }

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}

  companion object {
    private val views = ConcurrentHashMap<Int, WeakReference<PcremoteVideoView>>()

    fun find(id: Int): PcremoteVideoView? = views[id]?.get()
  }
}
