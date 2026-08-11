import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';

import { supabase } from '../../../src/lib/supabase.ts';

const INVITE_DAYS = 14;
const MAX_USES = 20;

const inviteUrl = (token: string) =>
  `${process.env.EXPO_PUBLIC_WEB_ORIGIN ?? 'https://mosaic.app'}/join/${token}`;

interface InviteRow {
  id: string;
  token: string;
  expires_at: string;
  uses: number;
  max_uses: number;
  revoked_at: string | null;
}

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('invites')
      .select('id, token, expires_at, uses, max_uses, revoked_at')
      .eq('album_id', id)
      .order('created_at', { ascending: false });
    setInvites((data ?? []) as InviteRow[]);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return setBusy(false);

    // A link that never expires is a permanent open door into somebody's
    // holiday. Both limits are deliberate and both are revocable.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_DAYS);

    const { data } = await supabase
      .from('invites')
      .insert({
        album_id: id,
        token: Crypto.randomUUID().replace(/-/g, ''),
        created_by: auth.user.id,
        expires_at: expiresAt.toISOString(),
        max_uses: MAX_USES,
      })
      .select('token')
      .single();

    setBusy(false);
    await load();

    if (data?.token) {
      await Share.share({
        message: `Film mee aan onze aftermovie: ${inviteUrl(data.token)}`,
      });
    }
  };

  const revoke = async (inviteId: string) => {
    await supabase.from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', inviteId);
    await load();
  };

  const active = invites.filter(
    (i) => !i.revoked_at && new Date(i.expires_at) > new Date() && i.uses < i.max_uses,
  );

  return (
    <View style={styles.container}>
      <Text style={styles.intro}>
        Iedereen met de link kan clips aan de film toevoegen. De link verloopt na {INVITE_DAYS}
        dagen en werkt maximaal {MAX_USES} keer.
      </Text>

      <Pressable style={styles.button} onPress={create} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Maak uitnodigingslink</Text>}
      </Pressable>

      {active.length > 0 && <Text style={styles.sectionTitle}>Actieve links</Text>}

      {active.map((invite) => (
        <View key={invite.id} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.token} numberOfLines={1}>
              …{invite.token.slice(-8)}
            </Text>
            <Text style={styles.meta}>
              {invite.uses}/{invite.max_uses} gebruikt · verloopt{' '}
              {new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(
                new Date(invite.expires_at),
              )}
            </Text>
          </View>
          <Pressable onPress={() => void Share.share({ message: inviteUrl(invite.token) })}>
            <Text style={styles.link}>Deel</Text>
          </Pressable>
          <Pressable onPress={() => revoke(invite.id)}>
            <Text style={[styles.link, styles.destructive]}>Intrekken</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 14 },
  intro: { fontSize: 15, color: '#555', lineHeight: 21 },
  button: { backgroundColor: '#111', borderRadius: 12, padding: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', marginTop: 12, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 },
  rowText: { flex: 1 },
  token: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12, color: '#888', marginTop: 2 },
  link: { fontSize: 14, fontWeight: '600' },
  destructive: { color: '#c0392b' },
});
