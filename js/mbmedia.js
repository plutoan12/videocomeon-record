/* Shared mediabunny wrapper (lazy dynamic import of the ~660KB ESM bundle
   in vendor/mediabunny/). Used for:
   - the editor's WebCodecs fast export (via load())
   - MP4 conversion (H.264 + AAC; compatible tracks are copied, others are
     hardware-encoded) — needs WebCodecs (canEncodeMp4)
   - no-re-encode clip merging by packet copy (pure JS remuxing, no
     WebCodecs needed)
   Callers fall back to ffmpeg.wasm (js/transcode.js) when a call throws. */
(function () {
  'use strict';

  const MB_URL = new URL('../vendor/mediabunny/mediabunny.min.mjs', document.currentScript.src).href;

  let mbPromise = null;
  function load() {
    if (!mbPromise) {
      mbPromise = import(MB_URL).catch((err) => { mbPromise = null; throw err; });
    }
    return mbPromise;
  }

  function canEncodeMp4() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  }

  /* Convert any decodable video blob to H.264 + AAC mp4. Tracks already in
     a compatible codec are copied without re-encoding. */
  async function toMp4(blob, { onProgress } = {}) {
    const MB = await load();
    const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
    const output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
    const conversion = await MB.Conversion.init({
      input,
      output,
      video: { codec: 'avc', bitrate: 8_000_000 },
      audio: { codec: 'aac', bitrate: 192_000 },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error('conversion not possible: '
        + conversion.discardedTracks.map((t) => t.reason).join(', '));
    }
    if (onProgress) conversion.onProgress = (p) => onProgress(p);
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer || !buffer.byteLength) throw new Error('empty output');
    return new Blob([buffer], { type: 'video/mp4' });
  }

  /* Merge same-codec clips without re-encoding: encoded packets are copied
     into one container with shifted timestamps. Pure JS — no WebCodecs, no
     ffmpeg. Throws when codecs differ or audio tracks are inconsistent;
     the caller then falls back (ffmpeg stream copy, then realtime render). */
  async function concat(blobs, mimeType, { onProgress } = {}) {
    const MB = await load();
    const isMp4 = !!(mimeType && mimeType.includes('mp4'));

    const inputs = [];
    for (const blob of blobs) {
      const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(blob) });
      const v = await input.getPrimaryVideoTrack();
      if (!v || !v.codec) throw new Error('video track missing or unknown codec');
      inputs.push({ v, a: await input.getPrimaryAudioTrack() });
    }
    const vCodec = inputs[0].v.codec;
    if (inputs.some((it) => it.v.codec !== vCodec)) throw new Error('video codecs differ');
    const withAudio = inputs.filter((it) => it.a).length;
    if (withAudio > 0 && withAudio < inputs.length) throw new Error('audio tracks inconsistent');
    const aCodec = withAudio ? inputs[0].a.codec : null;
    if (aCodec && inputs.some((it) => it.a.codec !== aCodec)) throw new Error('audio codecs differ');

    const output = new MB.Output({
      format: isMp4 ? new MB.Mp4OutputFormat() : new MB.WebMOutputFormat(),
      target: new MB.BufferTarget(),
    });
    const vSource = new MB.EncodedVideoPacketSource(vCodec);
    output.addVideoTrack(vSource);
    const aSource = aCodec ? new MB.EncodedAudioPacketSource(aCodec) : null;
    if (aSource) output.addAudioTrack(aSource);
    await output.start();

    try {
      let offset = 0;
      for (let i = 0; i < inputs.length; i++) {
        const { v, a } = inputs[i];
        let end = 0;
        const copy = async (track, source) => {
          let meta = { decoderConfig: await track.getDecoderConfig() };
          const sink = new MB.EncodedPacketSink(track);
          for await (const packet of sink.packets()) {
            await source.add(packet.clone({ timestamp: packet.timestamp + offset }), meta);
            meta = undefined; // config only accompanies each clip's first packet
            end = Math.max(end, packet.timestamp + packet.duration);
          }
        };
        await copy(v, vSource);
        if (aSource) await copy(a, aSource);
        offset += end;
        if (onProgress) onProgress((i + 1) / inputs.length);
      }
      vSource.close();
      if (aSource) aSource.close();
      await output.finalize();
    } catch (err) {
      try { await output.cancel(); } catch (e) { /* already errored */ }
      throw err;
    }

    const buffer = output.target.buffer;
    if (!buffer || !buffer.byteLength) throw new Error('empty output');
    return new Blob([buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' });
  }

  window.MBMedia = { load, canEncodeMp4, toMp4, concat };
})();
