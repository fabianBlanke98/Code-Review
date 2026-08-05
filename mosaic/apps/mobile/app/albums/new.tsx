import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';

import { supabase } from '../../src/lib/supabase.ts';

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export default function NewAlbum() {
  const [title, setTitle] = useState('');
  const [startsOn, setStartsOn] = useState(new Date());
  const [endsOn, setEndsOn] = useState(() => {
    const week = new Date();
    week.setDate(week.getDate() + 7);
    return week;
  });
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
      .insert({
        title: title.trim(),
        created_by: auth.user.id,
        starts_on: isoDay(startsOn),
        ends_on: isoDay(endsOn),
      })
      .select('id')
      .single();

    setBusy(false);
    if (insertError || !data) {
      setError('Aanmaken mislukt. Probeer het opnieuw.');
      return;
    }

    router.replace(`/albums/${data.id}`);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Waar gaat dit album over?</Text>
      <TextInput
        style={styles.input}
        placeholder="Kreta 2026"
        value={title}
        onChangeText={setTitle}
        maxLength={80}
        autoFocus
      />

      <Text style={styles.hint}>
        Een album met een begin en een eind werkt het best: een reis, een feest, een seizoen.
      </Text>

      <View style={styles.dateRow}>
        <View style={styles.dateField}>
          <Text style={styles.label}>Van</Text>
          <DateTimePicker
            value={startsOn}
            mode="date"
            display={Platform.OS === 'ios' ? 'compact' : 'default'}
            onChange={(_, date) => date && setStartsOn(date)}
          />
        </View>
        <View style={styles.dateField}>
          <Text style={styles.label}>Tot</Text>
          <DateTimePicker
            value={endsOn}
            mode="date"
            minimumDate={startsOn}
            display={Platform.OS === 'ios' ? 'compact' : 'default'}
            onChange={(_, date) => date && setEndsOn(date)}
          />
        </View>
      </View>

      <Pressable
        style={[styles.button, (title.trim().length === 0 || busy) && styles.buttonDisabled]}
        disabled={title.trim().length === 0 || busy}
        onPress={create}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Album aanmaken</Text>}
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 14 },
  label: { fontSize: 14, fontWeight: '600', color: '#444' },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, padding: 14, fontSize: 17 },
  hint: { fontSize: 13, color: '#888', lineHeight: 19 },
  dateRow: { flexDirection: 'row', gap: 24, marginTop: 8 },
  dateField: { gap: 6 },
  button: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 12 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#c0392b' },
});
