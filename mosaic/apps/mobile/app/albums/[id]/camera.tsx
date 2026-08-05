import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';

import { uploadClip } from '../../../src/lib/upload.ts';
import { humanError } from '../../../src/lib/supabase.ts';

const MAX_MS = 3000;
const MIN_MS = 400;

export default function CameraScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const camera = useRef<Camera>(null);
  // Portrait only. Mixed orientations are unfixable once they are in the album:
  // there is no crop that makes a landscape clip sit well in a 9:16 montage.
  const device = useCameraDevice('back');
  const { hasPermission: hasCamera, requestPermission: requestCamera } = useCameraPermission();
  const { hasPermission: hasMic, requestPermission: requestMic } = useMicrophonePermission();

  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const startedAt = useRef(0);
  const capturedAt = useRef(new Date());
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ring = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!hasCamera) void requestCamera();
    if (!hasMic) void requestMic();
  }, [hasCamera, hasMic, requestCamera, requestMic]);

  useEffect(
    () => () => {
      if (autoStop.current) clearTimeout(autoStop.current);
    },
    [],
  );

  const start = async () => {
    if (!camera.current || recording || uploading) return;

    setRecording(true);
    startedAt.current = Date.now();
    // Capture time is stamped here, at the moment of filming — not at upload,
    // and not when the worker gets round to it.
    capturedAt.current = new Date();

    ring.setValue(0);
    Animated.timing(ring, { toValue: 1, duration: MAX_MS, useNativeDriver: false }).start();

    camera.current.startRecording({
      fileType: 'mp4',
      videoCodec: 'h264',
      onRecordingFinished: async (video) => {
        const durationMs = Math.min(Date.now() - startedAt.current, MAX_MS);
        setRecording(false);
        setUploading(true);
        try {
          await uploadClip({
            albumId: id,
            fileUri: video.path.startsWith('file://') ? video.path : `file://${video.path}`,
            capturedAt: capturedAt.current,
            durationMs,
          });
          router.back();
        } catch (error) {
          Alert.alert('Uploaden mislukt', humanError(error));
          setUploading(false);
        }
      },
      onRecordingError: (error) => {
        setRecording(false);
        Alert.alert('Opnemen mislukt', String(error.message ?? error));
      },
    });

    // Hard cap. One to three seconds is the format; longer clips make the
    // montage sag and give people something to edit, which is the thing this
    // app exists to avoid.
    autoStop.current = setTimeout(() => void stop(), MAX_MS);
  };

  const stop = async () => {
    if (!camera.current || !recording) return;
    if (autoStop.current) {
      clearTimeout(autoStop.current);
      autoStop.current = null;
    }
    // Below MIN_MS the result is a black frame; wait it out rather than ship it.
    const elapsed = Date.now() - startedAt.current;
    if (elapsed < MIN_MS) await new Promise((r) => setTimeout(r, MIN_MS - elapsed));
    ring.stopAnimation();
    await camera.current.stopRecording();
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
        isActive={!uploading}
        video
        audio={hasMic}
        orientation="portrait"
      />

      <Pressable style={styles.close} onPress={() => router.back()} disabled={recording}>
        <Text style={styles.closeText}>Sluiten</Text>
      </Pressable>

      <View style={styles.controls}>
        <Text style={styles.hint}>
          {uploading ? 'Uploaden…' : recording ? 'Laat los om te stoppen' : 'Houd vast om op te nemen'}
        </Text>

        <Pressable
          onPressIn={start}
          onPressOut={stop}
          disabled={uploading}
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
  hint: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
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
