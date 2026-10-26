#!/usr/bin/env bash
# Minimal static ffmpeg.exe for PC Remote, cross-compiled on Linux (mingw-w64).
# Only what runtime/agent uses:
#   screen : ddagrab (lavfi) / gdigrab -> hwdownload,format,scale -> H.264 -> FLV on stdout
#   encoder: h264_nvenc, h264_qsv (libvpl), h264_amf, libx264 (fallback)
#   probe  : lavfi color -> encoder -> null
#   webcam : dshow -> scale -> mjpeg -> image2pipe
# Needs: x86_64-w64-mingw32-gcc/g++, nasm, cmake, make, pkg-config, git, curl.
# Output: $OUT/ffmpeg.exe (default ./out/ffmpeg.exe)
set -euo pipefail

FFMPEG_VER="${FFMPEG_VER:-7.1.1}"
X264_REF="${X264_REF:-stable}"
NVHDR_REF="${NVHDR_REF:-n12.2.72.0}"
AMF_REF="${AMF_REF:-v1.4.36}"
VPL_REF="${VPL_REF:-v2.15.0}"
JOBS="${JOBS:-$(nproc)}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/work}"
OUT="${OUT:-$HERE/out}"
PREFIX="$WORK/prefix"
HOST=x86_64-w64-mingw32
mkdir -p "$WORK" "$OUT" "$PREFIX/include" "$PREFIX/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
cd "$WORK"

# --- x264 (static, 8-bit) ---
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
  [ -d x264 ] || git clone -q --depth 1 -b "$X264_REF" https://code.videolan.org/videolan/x264.git
  (cd x264 && ./configure --host=$HOST --cross-prefix=$HOST- --prefix="$PREFIX" \
      --enable-static --disable-cli --disable-opencl --bit-depth=8 --chroma-format=420 \
      --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
    && make -j"$JOBS" && make install)
fi

# --- NVENC headers (header only, loads nvEncodeAPI64.dll at runtime) ---
if [ ! -f "$PREFIX/lib/pkgconfig/ffnvcodec.pc" ]; then
  [ -d nv-codec-headers ] || git clone -q --depth 1 -b "$NVHDR_REF" https://github.com/FFmpeg/nv-codec-headers.git
  make -C nv-codec-headers PREFIX="$PREFIX" install
fi

# --- AMF headers (header only, loads amfrt64.dll at runtime) ---
if [ ! -d "$PREFIX/include/AMF" ]; then
  [ -d AMF ] || { git clone -q --depth 1 --filter=blob:none --sparse -b "$AMF_REF" https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git \
    && git -C AMF sparse-checkout set amf/public/include; }
  mkdir -p "$PREFIX/include/AMF" && cp -r AMF/amf/public/include/* "$PREFIX/include/AMF/"
fi

# --- libvpl dispatcher (Intel Quick Sync, loads the Intel runtime at runtime) ---
if [ ! -f "$PREFIX/lib/pkgconfig/vpl.pc" ]; then
  [ -d libvpl ] || git clone -q --depth 1 -b "$VPL_REF" https://github.com/intel/libvpl.git
  cat > "$WORK/mingw.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_C_COMPILER $HOST-gcc)
set(CMAKE_CXX_COMPILER $HOST-g++)
set(CMAKE_RC_COMPILER $HOST-windres)
set(CMAKE_FIND_ROOT_PATH /usr/$HOST $PREFIX)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
EOF
  cmake -S libvpl -B libvpl/build -DCMAKE_TOOLCHAIN_FILE="$WORK/mingw.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF \
    -DBUILD_TOOLS=OFF -DINSTALL_EXAMPLES=OFF -DINSTALL_DEV=ON -DBUILD_EXPERIMENTAL=OFF
  cmake --build libvpl/build -j"$JOBS"
  cmake --install libvpl/build
  # Static dispatcher pulls in the C++ runtime and ole32/advapi32 on Windows.
  sed -i 's/^Libs: \(.*\)$/Libs: \1 -lstdc++ -lole32 -luuid -ladvapi32/' "$PREFIX/lib/pkgconfig/vpl.pc"
fi

# --- ffmpeg ---
[ -f "ffmpeg-$FFMPEG_VER.tar.gz" ] || curl -fsSL -o "ffmpeg-$FFMPEG_VER.tar.gz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.gz"
rm -rf "ffmpeg-$FFMPEG_VER" && tar xf "ffmpeg-$FFMPEG_VER.tar.gz"
cd "ffmpeg-$FFMPEG_VER"
./configure \
  --prefix="$PREFIX" --target-os=mingw32 --arch=x86_64 --cross-prefix=$HOST- --pkg-config=pkg-config \
  --pkg-config-flags=--static --enable-static --disable-shared \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib -static -static-libgcc -static-libstdc++" \
  --enable-gpl --disable-autodetect --disable-everything --disable-debug --disable-doc \
  --disable-ffprobe --disable-ffplay --disable-network \
  --enable-avdevice --enable-avfilter --enable-swscale \
  --enable-w32threads --enable-d3d11va --enable-dxva2 \
  --enable-ffnvcodec --enable-nvenc --enable-amf --enable-libvpl --enable-libx264 \
  --enable-encoder=h264_nvenc,h264_amf,h264_qsv,libx264,mjpeg,rawvideo,wrapped_avframe \
  --enable-decoder=mjpeg,rawvideo \
  --enable-parser=h264,hevc,mjpeg \
  `# hevc parser only to link aom_film_grain.o (ffmpeg 7.1 h2645_sei bug)` \
  --enable-indev=gdigrab,dshow,lavfi \
  --enable-filter=ddagrab,hwdownload,hwupload,format,scale,null,color,fps,setpts,copy,trim,buffer,buffersink,abuffer,abuffersink,anull,aformat,aresample \
  --enable-muxer=flv,image2pipe,mjpeg,null,rawvideo \
  --enable-protocol=pipe,file
make -j"$JOBS" ffmpeg.exe
$HOST-strip -s ffmpeg.exe
cp ffmpeg.exe "$OUT/ffmpeg.exe"
ls -l "$OUT/ffmpeg.exe"
