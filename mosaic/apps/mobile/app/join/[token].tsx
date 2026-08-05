import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useSession } from '../../src/lib/session.tsx';
import { MESSAGES, humanError, supabase } from '../../src/lib/supabase.ts';

interface Preview {
  album_title: string | null;
  inviter_name: string | null;
  valid: boolean;
  reason: string | null;
}

/**
 * Deep-link target for an invite.
 *
 * Reachable signed out on purpose: peek_invite runs for the anon role, so an
 * invitee sees *what* they were invited to before being asked to create an
 * account. Asking first is where shared albums lose most of their group.
 */
export default function JoinScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { session, loading: sessionLoading } = useSession();
  const router = useRouter();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase
      .rpc('peek_invite', { p_token: token })
      .single()
      .then(({ data }) => setPreview(data as Preview | null));
  }, [token]);

  const join = useCallback(async () => {
    setJoining(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('redeem_invite', { p_token: token });
    setJoining(false);

    if (rpcError) return setError(humanError(rpcError));
    router.replace(`/albums/${data}`);
  }, [token, router]);

  // Redeem automatically once the invitee has signed in.
  useEffect(() => {
    if (session && preview?.valid && !joining) void join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, preview?.valid]);

  if (!preview) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!preview.valid) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Deze link werkt niet meer</Text>
        <Text style={styles.body}>{MESSAGES[preview.reason ?? 'invite_not_found']}</Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.eyebrow}>
        {preview.inviter_name ?? 'Iemand'} nodigt je uit voor
      </Text>
      <Text style={styles.title}>{preview.album_title}</Text>
      <Text style={styles.body}>
        Voeg clips van 1 tot 3 seconden toe. Samen wordt het één film.
      </Text>

      {sessionLoading || joining ? (
        <ActivityIndicator style={styles.spinner} />
      ) : session ? (
        <Pressable style={styles.button} onPress={join}>
          <Text style={styles.buttonText}>Doe mee</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.button} onPress={() => router.push('/sign-in')}>
          <Text style={styles.buttonText}>Inloggen en meedoen</Text>
        </Pressable>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  eyebrow: { fontSize: 15, color: '#777' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, color: '#666', textAlign: 'center', lineHeight: 21, marginBottom: 12 },
  button: { backgroundColor: '#111', borderRadius: 12, paddingHorizontal: 32, paddingVertical: 16 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  spinner: { marginTop: 16 },
  error: { color: '#c0392b', marginTop: 12, textAlign: 'center' },
});
