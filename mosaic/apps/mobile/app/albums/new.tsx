import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { CLIP_SECONDS_OPTIONS, DEFAULT_CLIP_SECONDS, type ClipSeconds } from '@mosaic/montage';
import { supabase } from '../../src/lib/supabase.ts';

export default function NewGroup() {
  const [title, setTitle] = useState('');
  const [clipSeconds, setClipSeconds] = useState<ClipSeconds>(DEFAULT_CLIP_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const create = async () => {
    setBusy(true);
    setError(null);

    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setBusy(false);
      return;
    }

    // The albums_grant_creator_admin trigger makes the creator an admin, so
    // there is nothing to insert into memberships here.
    const { data, error: insertError } = await supabase
      .from('albums')
      .insert({ title: title.trim(), created_by: auth.user.id, clip_seconds: clipSeconds })
      .select('id')
      .single();

    setBusy(false);
    if (insertError || !data) {
      setError('Aanmaken mislukt. Probeer het opnieuw.');
      return;
    }

    // Straight to inviting: a group of one has nothing to make a film out of.
    router.replace(`/albums/${data.id}/invite`);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Waar gaan jullie heen?</Text>
      <TextInput
        style={styles.input}
        placeholder="Kreta 2026"
        value={title}
        onChangeText={setTitle}
        maxLength={80}
        autoFocus
      />

      <View style={styles.block}>
        <Text style={styles.label}>Hoe lang duurt één opname?</Text>
        <View style={styles.chips}>
          {CLIP_SECONDS_OPTIONS.map((seconds) => (
            <Pressable
              key={seconds}
              style={[styles.chip, clipSeconds === seconds && styles.chipActive]}
              onPress={() => setClipSeconds(seconds)}
            >
              <Text style={[styles.chipText, clipSeconds === seconds && styles.chipTextActive]}>
                {seconds}s
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hint}>
          Geldt voor iedereen in de groep. Eén vaste lengte geeft de film ritme — en niemand
          hoeft na te denken over hoe lang hij moet filmen.
        </Text>
      </View>

      <Pressable
        style={[styles.button, (title.trim().length === 0 || busy) && styles.buttonDisabled]}
        disabled={title.trim().length === 0 || busy}
        onPress={create}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Groep aanmaken</Text>}
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 14 },
  block: { gap: 10, marginTop: 10 },
  label: { fontSize: 14, fontWeight: '600', color: '#444' },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, padding: 14, fontSize: 17 },
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
  },
  chipActive: { backgroundColor: '#111', borderColor: '#111' },
  chipText: { fontWeight: '600', fontSize: 15 },
  chipTextActive: { color: '#fff' },
  hint: { fontSize: 13, color: '#888', lineHeight: 19 },
  button: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 16 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#c0392b' },
});
