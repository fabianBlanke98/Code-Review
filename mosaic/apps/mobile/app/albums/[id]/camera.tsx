import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';

import { DEFAULT_CLIP_SECONDS } from '@mosaic/montage';
import { useAlbum } from '../../../src/hooks/useAlbum.ts';
import { replaceClip, uploadClip } from '../../../src/lib/upload.ts';
import { humanError } from '../../../src/lib/supabase.ts';

export default function CameraScreen() {
  // `replace` carries the id of a clip being re-shot; without it we append.
  const { id, replace } = useLocalSearchParams<{ id: string; replace?: string }>();
  const router = useRouter();
  const { album } = useAlbum(id);

  const clipSeconds = album?.clipSeconds ?? DEFAULT_CLIP_SECONDS;
  const clipMs = clipSeconds * 1000;

  const camera = useRef<Camera>(null);
  // Portrait only. Mixed orientations are unfixable once they are in the film:
  // there is no crop that makes a landscape clip sit well in a 9:16 reel.
  const device = useCameraDevice('back');
  const { hasPermission: hasCamera, requestPermission: requestCamera } = useCameraPermission();
  const { hasPermission: hasMic, requestPermission: requestMic } = useMicrophonePermission();

  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Hand the camera back the moment this screen goes away. Leaving it active
  // keeps the indicator on, which reads as "it never stopped recording".
  const [active, setActive] = useState(true);
  const [remaining, setRemaining] = useState(clipSeconds);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const ring = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!hasCamera) void requestCamera();
    if (!hasMic) void requestMic();
  }, [hasCamera, hasMic, requestCamera, requestMic]);

  useEffect(() => setRemaining(clipSeconds), [clipSeconds]);

  const clearTimers = () => {
    if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
  };

  useEffect(() => () => {
    clearTimers();
    setActive(false);
  }, []);

  /**
   * One tap records exactly the group's clip length and stops itself. Nothing
   * to hold, nothing to trim, no decision to make — which is the whole reason
   * the length is a group setting rather than a slider on this screen.
   */
  const record = async () => {
    if (!camera.current || recording || uploading) return;

    setRecording(true);
    setRemaining(clipSeconds);

    ring.setValue(0);
    Animated.timing(ring, {
      toValue: 1,
      duration: clipMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    tick.current = setInterval(
      () => setRemaining((left) => Math.max(0, left - 1)),
      1000,
    );

    camera.current.startRecording({
      fileType: 'mp4',
      videoCodec: 'h264',
      onRecordingFinished: async (video) => {
        clearTimers();
        setRecording(false);
        setUploading(true);
        const fileUri = video.path.startsWith('file://') ? video.path : `file://${video.path}`;
        try {
          if (replace) {
            // Keeps the slot it already had rather than landing at the end.
            await replaceClip(replace, { fileUri, durationMs: clipMs });
          } else {
            await uploadClip({ albumId: id, fileUri, durationMs: clipMs });
          }
          router.back();
        } catch (error) {
          Alert.alert(
            replace ? 'Vervangen mislukt' : 'Uploaden mislukt',
            humanError(error),
          );
          setUploading(false);
        }
      },
      onRecordingError: (error) => {
        clearTimers();
        setRecording(false);
        Alert.alert('Opnemen mislukt', String(error.message ?? error));
      },
    });

    stopTimer.current = setTimeout(() => {
      void camera.current?.stopRecording();
    }, clipMs);
  };

  if (!device || !hasCamera) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          {hasCamera ? 'Geen camera gevonden.' : 'Geef toegang tot de camera om op te nemen.'}
        </Text>
        <Pressable style={styles.close} onPress={() => router.back()}>
          <Text style={styles.closeText}>Sluiten</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={active && !uploading}
        video
        audio={hasMic}
        orientation="portrait"
      />

      <Pressable style={styles.close} onPress={() => router.back()} disabled={recording}>
        <Text style={styles.closeText}>Sluiten</Text>
      </Pressable>

      <View style={styles.controls}>
        <Text style={styles.hint}>
          {uploading
            ? 'Uploaden…'
            : recording
              ? `${remaining}`
              : replace
                ? `Tik om deze opname over te doen · ${clipSeconds}s`
                : `Tik om ${clipSeconds} seconden op te nemen`}
        </Text>

        <Pressable
          onPress={record}
          disabled={recording || uploading}
          style={[styles.shutter, recording && styles.shutterActive]}
        >
          <Animated.View
            style={[
              styles.ring,
              {
                width: ring.interpolate({ inputRange: [0, 1], outputRange: [88, 108] }),
                height: ring.interpolate({ inputRange: [0, 1], outputRange: [88, 108] }),
                opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              },
            ]}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  fallback: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', gap: 20 },
  fallbackText: { color: '#fff', textAlign: 'center', paddingHorizontal: 32, lineHeight: 22 },
  close: { position: 'absolute', top: 56, left: 20, padding: 10 },
  closeText: { color: '#fff', fontSize: 16, fontWeight: '500' },
  controls: { position: 'absolute', bottom: 56, left: 0, right: 0, alignItems: 'center', gap: 18 },
  hint: { color: 'rgba(255,255,255,0.9)', fontSize: 15, fontVariant: ['tabular-nums'] },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterActive: { backgroundColor: '#e74c3c' },
  ring: { position: 'absolute', borderRadius: 999, borderWidth: 3, borderColor: '#fff' },
});
